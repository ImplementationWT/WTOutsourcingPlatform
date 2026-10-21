import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type GithubAdapter, PLATFORM_TOPIC } from "../adapters/github.js";
import type { Deps } from "../jobs/types.js";
import { accessibleClient, canSeeClient, clientScope, teamFilterOf } from "../auth/access.js";
import { requireAuth, requireOperator, type SessionUser } from "../auth/session.js";
import { deriveNames, parseSlug, slugSchema } from "../domain/naming.js";
import { type JobEngine, toPublicJob } from "../jobs/engine.js";
import { ActiveWorkError, type Teardown, toPublicDeletion } from "../jobs/teardown.js";
import { INITIAL_ADMIN_USERNAME } from "../jobs/stages/github-secrets.js";
import { getProvider, integrationsInputSchema } from "../integrations/catalog.js";
import { redact, registerSecret } from "../lib/redact.js";
import { ActiveJobExistsError, type AdminStore, DuplicateClientError } from "../store/admin-store.js";
import type { ClientDoc } from "../store/models.js";
import { type ServerDirectory, ServerDirectoryError } from "../servers/directory.js";
import { appsDomainOf, serverFor } from "../servers/resolve.js";

/**
 * Del navegador solo se aceptan nombre, slug y descripción. Base, usuario,
 * repo y subdominio se derivan del slug validado en el servidor; cualquier
 * otro campo enviado se descarta.
 */
const createClientSchema = z.object({
  name: z.string().trim().min(3).max(60),
  // "preview-" está reservado: preview-<slug>.<dominio> es la vista previa del AI Developer.
  slug: slugSchema.refine((slug) => !slug.startsWith("preview-")),
  description: z.string().trim().min(10).max(280),
  // Integraciones opcionales: estricto (solo proveedores del catálogo y sus campos).
  integrations: integrationsInputSchema.optional(),
  // Servidor donde se desplegará (fijo para siempre). Sin él, el principal.
  serverId: z.string().regex(/^(principal|[0-9a-f-]{36})$/).optional(),
  // Solo CEO/CCO: equipo del proyecto (el resto crea siempre en el suyo).
  teamId: z.string().uuid().optional()
});

/** Registra para redacción cualquier credencial recibida, antes incluso de validarla. */
export function registerIncomingSecrets(value: unknown) {
  if (typeof value === "string") registerSecret(value);
  else if (value && typeof value === "object") Object.values(value).forEach(registerIncomingSecrets);
}

/** Reglas de GitHub para topics: minúsculas, números y guiones, hasta 50 caracteres y 20 por repo. */
const topicsSchema = z
  .object({
    topics: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,49}$/, "Etiqueta inválida: minúsculas, números y guiones (máx. 50)."))
      .max(20, "Máximo 20 etiquetas por proyecto.")
  })
  .strict();
const repoParams = z.object({ name: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/) });

const idParams = z.object({ id: z.string().uuid() });
const slugParams = z.object({ slug: slugSchema });

export type InitialAdminState = "pending" | "default" | "available" | "revealed" | "expired" | "unavailable";

/**
 * Estado de la contraseña inicial para el panel. Nunca incluye el valor.
 * - available: se escribió el secret en este trabajo y aún puede verse una vez.
 * - revealed / expired: ya se mostró o venció el plazo; se borró definitivamente.
 * - unavailable: el secret ya existía de un intento anterior y no se conoce su valor.
 */
export function initialAdminStatus(client: ClientDoc, pendingUntil: Date | null, now = new Date()) {
  const info = client.initialAdmin;
  const base = { username: INITIAL_ADMIN_USERNAME, mustChangeOnFirstLogin: true };
  if (!info) return { ...base, mode: null, state: "pending" as InitialAdminState };
  const state: InitialAdminState =
    info.mode === "default"
      ? "default"
      : info.revealedAt
        ? "revealed"
        : info.generatedAt && pendingUntil
          ? "available"
          : info.generatedAt && info.revealExpiresAt && info.revealExpiresAt <= now
            ? "expired"
            : "unavailable";
  return {
    ...base,
    mode: info.mode,
    state,
    expiresAt: state === "available" ? pendingUntil : null,
    revealedAt: info.revealedAt ?? null,
    revealedBy: info.revealedBy ?? null
  };
}

/** Integraciones del cliente para el panel: estado y fechas. Nunca valores, parciales ni longitudes. */
export function integrationsView(client: ClientDoc) {
  return Object.entries(client.integrations ?? {})
    .filter(([providerId]) => getProvider(providerId))
    .map(([provider, state]) => ({
      provider,
      enabled: state.enabled,
      configuredAt: state.configuredAt ?? null,
      updatedAt: state.updatedAt ?? null
    }));
}

/** Digest abreviado de una imagen ghcr.io/<org>/<repo>@sha256:… para mostrar en el panel. */
export function shortDigest(image: string | undefined) {
  const digest = image?.match(/@sha256:([a-f0-9]{64})$/)?.[1];
  return digest ? `sha256:${digest.slice(0, 12)}` : null;
}

/** Despliegue del cliente para el panel: solo referencias, nunca claves, tokens ni variables. */
function deploymentView(client: ClientDoc, baseUrl: string) {
  const d = client.deployment;
  return {
    appUrl: baseUrl,
    host: d?.host ?? null,
    dnsVerifiedAt: d?.dnsVerifiedAt ?? null,
    certificate: d?.certificate ?? null,
    https: d?.httpsVerifiedAt ? { verifiedAt: d.httpsVerifiedAt, trusted: d.httpsTrusted !== false } : null,
    image: d?.image ? { digest: shortDigest(d.image), deployedAt: d.deployedAt ?? null } : null,
    lastRunUrl: d?.lastRunUrl ?? null,
    redeployRequestedAt: d?.redeployRequestedAt ?? null,
    redeployRequestedBy: d?.redeployRequestedBy ?? null
  };
}

export async function registerClientRoutes(
  app: FastifyInstance,
  {
    store,
    engine,
    teardown,
    deps,
    servers
  }: { store: AdminStore; engine: JobEngine; teardown: Teardown; deps: Deps & { github: GithubAdapter }; servers: ServerDirectory }
) {
  const { github, vault, config } = deps;
  const namesFor = (client: ClientDoc) =>
    deriveNames(parseSlug(client._id), { targetOwner: github.owner, appsDomain: appsDomainOf(client, config) });

  app.post("/api/clients", { preHandler: requireOperator }, async (request, reply) => {
    registerIncomingSecrets((request.body as { integrations?: unknown } | null)?.integrations);
    const parsed = createClientSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Datos inválidos.", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    const { name, slug, description } = parsed.data;
    const integrations = Object.entries(parsed.data.integrations ?? {}).filter(
      (entry): entry is [string, Record<string, string>] => entry[1] !== undefined
    );
    if (integrations.length && !deps.secrets.available) {
      return reply.code(503).send({ error: "Las integraciones no están disponibles: falta INTEGRATION_ENCRYPTION_KEY_SECRET_REF en el servidor." });
    }
    const actor = request.user!.username;
    // El proyecto es del equipo de quien lo crea; un CEO/CCO (sin equipo) elige el equipo.
    const user = request.user!;
    const teamId = user.role === "boss" ? (parsed.data.teamId ?? null) : user.teamId;
    if (user.role === "boss" && !teamId) return reply.code(400).send({ error: "Elige el equipo del proyecto." });
    if (!teamId) return reply.code(409).send({ error: "Tu usuario no tiene equipo: pide a un CEO/CCO que te asigne uno." });
    if (!(await store.teams.findOne({ _id: teamId }))) return reply.code(400).send({ error: "El equipo no existe." });
    let server: Awaited<ReturnType<ServerDirectory["select"]>>;
    try {
      server = await servers.select(parsed.data.serverId);
    } catch (error) {
      if (error instanceof ServerDirectoryError) return reply.code(error.status).send({ error: error.message });
      throw error;
    }

    try {
      const job = await store.createClientWithJob({ slug, name, description, actor, stages: engine.stageNames, server, teamId });
      await store.audit({ actor, action: "client.created", clientId: slug, target: slug, ...(server ? { details: { server: server.name } } : {}) });
      // Las credenciales quedan cifradas (TTL) hasta que github_secrets las escribe en GitHub.
      for (const [providerId, credentials] of integrations) {
        await deps.secrets.put(slug, providerId, credentials);
        await store.setClientFields(slug, { [`integrations.${providerId}`]: { enabled: true, requestedAt: new Date() } });
      }
      void engine.start(job._id, actor);
      return reply.code(202).send({ clientId: slug, jobId: job._id });
    } catch (error) {
      if (error instanceof DuplicateClientError || error instanceof ActiveJobExistsError) {
        const existing = await store.getClient(slug);
        // A otro equipo no se le dice nada más que el identificador está ocupado.
        const visible = existing && canSeeClient(request.user!, existing);
        return reply.code(409).send({ error: `Ya existe un proyecto con el identificador ${slug}.`, clientId: visible ? slug : null, jobId: visible ? existing.latestJobId : null });
      }
      throw error;
    }
  });

  app.get("/api/clients/:slug", { preHandler: requireAuth }, async (request, reply) => {
    const params = slugParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Identificador inválido." });
    const client = await accessibleClient(store, request, reply, params.data.slug);
    if (!client) return reply;
    const team = client.teamId ? await store.teams.findOne({ _id: client.teamId }) : null;

    const names = namesFor(client);
    const [job, repo, pendingUntil] = await Promise.all([
      store.getJob(client.latestJobId),
      store.getResource("github_repository", names.repositoryFullName),
      vault.pendingUntil(client._id)
    ]);

    // Solo referencias: nunca URI, SESSION_SECRET ni contraseñas.
    return {
      client: {
        id: client._id,
        name: client.name,
        description: client.description,
        status: client.status,
        readiness: client.readiness,
        template: client.template
          ? { name: client.template.name, version: client.template.version, schemaVersion: client.template.schemaVersion ?? null }
          : null,
        initialAdmin: initialAdminStatus(client, pendingUntil, vault.now()),
        integrations: integrationsView(client),
        deployment: deploymentView(client, names.baseUrl),
        deployEnabled: config.deployEnabled,
        server: client.server ?? { id: "principal", name: "Principal", appsDomain: config.appsDomain },
        team: team ? { id: team._id, name: team.name } : null,
        createdAt: client.createdAt
      },
      resources: {
        repository: { fullName: names.repositoryFullName, url: typeof repo?.ref.url === "string" ? repo.ref.url : null },
        database: names.database,
        databaseUser: names.dbUser,
        subdomain: names.host,
        baseUrl: names.baseUrl
      },
      job: job ? toPublicJob(job) : null
    };
  });

  /** Estado de la contraseña inicial del admin de la app (sin el valor). */
  app.get("/api/clients/:slug/initial-password", { preHandler: requireAuth }, async (request, reply) => {
    const params = slugParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Identificador inválido." });
    const client = await accessibleClient(store, request, reply, params.data.slug);
    if (!client) return reply;
    return initialAdminStatus(client, await vault.pendingUntil(client._id), vault.now());
  });

  /**
   * Revelación única: entrega la contraseña y la borra en la misma operación.
   * La respuesta se envía ya serializada para que no pase por la redacción
   * global (que la ocultaría), con Cache-Control: no-store, y no se loguea.
   */
  app.post("/api/clients/:slug/initial-password/reveal", { preHandler: requireOperator }, async (request, reply) => {
    const params = slugParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Identificador inválido." });
    const client = await accessibleClient(store, request, reply, params.data.slug);
    if (!client) return reply;

    const status = initialAdminStatus(client, await vault.pendingUntil(client._id), vault.now());
    const password = status.state === "available" ? await vault.take(client._id) : null;
    if (!password) {
      const reasons: Record<InitialAdminState, string> = {
        pending: "La contraseña inicial aún no se ha generado.",
        default: "Este cliente usa la contraseña por defecto del template; no hay una contraseña generada que mostrar.",
        available: "La contraseña inicial ya no está disponible.",
        revealed: "La contraseña inicial ya se mostró y se eliminó.",
        expired: "El plazo para ver la contraseña inicial venció y se eliminó.",
        unavailable: "La contraseña se generó en un intento anterior y ya no está disponible. No se puede mostrar."
      };
      return reply.code(410).send({ error: reasons[status.state], state: status.state === "available" ? "revealed" : status.state });
    }

    const actor = request.user!.username;
    await store.setClientFields(client._id, { "initialAdmin.revealedAt": vault.now(), "initialAdmin.revealedBy": actor });
    await store.audit({ actor, action: "initial_password_revealed", clientId: client._id, target: client._id });
    return reply
      .header("Cache-Control", "no-store")
      .type("application/json; charset=utf-8")
      .send(JSON.stringify({ username: INITIAL_ADMIN_USERNAME, password, mustChangeOnFirstLogin: true }));
  });

  /** Configuración visible para el panel (sin secretos): evita duplicarla en el frontend. */
  app.get("/api/platform", { preHandler: requireAuth }, async () => ({
    deployEnabled: config.deployEnabled,
    appBaseDomain: config.appsDomain,
    templateVersion: config.template.expectedVersion,
    integrationsAvailable: deps.secrets.available,
    githubOwner: github.owner,
    atlas: {
      clusterName: config.atlas.clusterName,
      consoleUrl: config.atlas.projectId ? `https://cloud.mongodb.com/v2/${config.atlas.projectId}#/clusters` : null
    }
  }));

  /**
   * Borra el proyecto y todo lo que la plataforma creó para él. Irreversible: exige
   * reenviar el identificador del proyecto como confirmación. Responde 202 y el
   * progreso se consulta en /deletion.
   */
  app.post("/api/clients/:slug/delete", { preHandler: requireOperator }, async (request, reply) => {
    const params = slugParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Identificador inválido." });
    const slug = params.data.slug;
    const confirm = (request.body as { confirm?: unknown } | null)?.confirm;
    if (confirm !== slug) return reply.code(400).send({ error: "Escribe el identificador exacto del proyecto para confirmar." });
    const [client, previous] = await Promise.all([store.getClient(slug), store.deletions.findOne({ _id: slug })]);
    // Se puede reintentar un borrado fallido aunque el cliente ya no exista en la base (con el
    // equipo que se guardó al pedirlo).
    const teamId = client ? client.teamId ?? null : previous?.status === "failed" ? previous.teamId ?? null : undefined;
    if (teamId === undefined || !canSeeClient(request.user!, { teamId })) return reply.code(404).send({ error: "Proyecto no encontrado." });
    try {
      const doc = await teardown.start(slug, request.user!.username, teamId);
      return reply.code(202).send(toPublicDeletion(doc));
    } catch (error) {
      if (error instanceof ActiveWorkError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.get("/api/clients/:slug/deletion", { preHandler: requireAuth }, async (request, reply) => {
    const params = slugParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Identificador inválido." });
    const [doc, client] = await Promise.all([store.deletions.findOne({ _id: params.data.slug }), store.getClient(params.data.slug)]);
    if (!doc || !canSeeClient(request.user!, client ?? { teamId: doc.teamId ?? null })) {
      return reply.code(404).send({ error: "No hay ningún borrado de este proyecto." });
    }
    return toPublicDeletion(doc);
  });

  /** Estado en vivo en el servidor (consulta predefinida client-status). Sin variables de entorno. */
  app.get("/api/clients/:slug/server-status", { preHandler: requireAuth }, async (request, reply) => {
    const params = slugParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Identificador inválido." });
    const client = await accessibleClient(store, request, reply, params.data.slug);
    if (!client) return reply;
    const target = config.deployEnabled ? await serverFor(deps, client).catch(() => undefined) : undefined;
    if (!target) return reply.code(409).send({ error: "El despliegue no está habilitado o el servidor del proyecto no está disponible." });
    try {
      const status = await target.adapter.clientStatus(parseSlug(client._id));
      return {
        host: status.host,
        port: status.port,
        nginx: status.nginx,
        certificate: status.certificate,
        image: status.deployment ? { digest: shortDigest(status.deployment.image), deployedAt: status.deployment.deployedAt } : null,
        container: status.container
      };
    } catch (error) {
      request.log.warn({ err: error, slug: client._id }, "client-status failed");
      return reply.code(502).send({ error: "No se pudo consultar el servidor." });
    }
  });

  /** Redesplegar: lanza el workflow Deploy del repo del cliente (workflow_dispatch) y lo audita. */
  app.post("/api/clients/:slug/redeploy", { preHandler: requireOperator }, async (request, reply) => {
    const params = slugParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Identificador inválido." });
    const client = await accessibleClient(store, request, reply, params.data.slug);
    if (!client) return reply;
    if (!config.deployEnabled) return reply.code(409).send({ error: "El despliegue no está habilitado." });
    if (!client.deployment?.preparedAt) {
      return reply.code(409).send({ error: "El servidor aún no está preparado para este cliente; termina primero el aprovisionamiento." });
    }
    const names = namesFor(client);
    const actor = request.user!.username;
    await github.dispatchWorkflow(names.repository, config.template.deployWorkflow, config.template.ref);
    const at = new Date();
    await store.setClientFields(client._id, { "deployment.redeployRequestedAt": at, "deployment.redeployRequestedBy": actor });
    await store.audit({ actor, action: "client.redeploy_requested", clientId: client._id, target: names.repositoryFullName });
    return reply.code(202).send({ requestedAt: at, actionsUrl: `https://github.com/${names.repositoryFullName}/actions` });
  });

  /** Trabajo de un proyecto visible para el usuario (404 si es de otro equipo). */
  async function visibleJob(id: string, user: SessionUser) {
    const job = await store.getJob(id);
    if (!job) return null;
    const client = await store.getClient(job.clientId);
    return client && canSeeClient(user, client) ? job : null;
  }

  app.get("/api/jobs/:id", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const job = await visibleJob(params.data.id, request.user!);
    if (!job) return reply.code(404).send({ error: "Trabajo no encontrado." });
    return toPublicJob(job);
  });

  /** Progreso en tiempo real (NDJSON): una instantánea del trabajo por línea. */
  app.get("/api/jobs/:id/events", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const job = await visibleJob(params.data.id, request.user!);
    if (!job) return reply.code(404).send({ error: "Trabajo no encontrado." });

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive"
    });

    const done = (status: string) => status === "failed" || status === "succeeded";
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      clearInterval(keepAlive);
      if (!res.writableEnded) res.end();
    };
    const send = (snapshot: unknown, status: string) => {
      if (closed || res.destroyed) return;
      res.write(`${JSON.stringify(redact(snapshot))}\n`);
      if (done(status)) close();
    };

    const unsubscribe = engine.subscribe(job._id, (snapshot) => send(snapshot, snapshot.status));
    // Las conexiones inactivas se cortan en algunos proxies: un latido cada 15 s.
    const keepAlive = setInterval(() => !closed && res.write("\n"), 15_000);
    request.raw.on("close", close);

    // Se relee después de suscribirse para no perder un cambio entre medias.
    const current = await store.getJob(job._id);
    if (current) send(toPublicJob(current), current.status);
  });

  app.post("/api/jobs/:id/retry", { preHandler: requireOperator }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const actor = request.user!.username;
    if (!(await visibleJob(params.data.id, request.user!))) return reply.code(404).send({ error: "Trabajo no encontrado." });

    try {
      const job = await store.prepareRetry(params.data.id, engine.retryableStageNames);
      if (!job) return reply.code(409).send({ error: "Solo se puede reintentar un trabajo fallido." });
      await store.updateClient(job.clientId, { status: "provisioning" });
      const resumeFrom = job.stages.find((s) => s.status !== "succeeded")?.name ?? null;
      await store.audit({ actor, action: "job.retried", clientId: job.clientId, target: job._id, details: { resumeFrom: resumeFrom ?? "none" } });
      void engine.start(job._id, actor);
      return reply.code(202).send({ jobId: job._id, resumeFrom });
    } catch (error) {
      if (error instanceof ActiveJobExistsError) return reply.code(409).send({ error: "El cliente ya tiene un trabajo en curso." });
      throw error;
    }
  });

  /**
   * Repos de GitHub de la organización (sin AB/WT), con el cliente asociado si lo hay. Un jefe ve
   * todos (o los de un equipo con ?teamId=); el resto, solo los proyectos de su equipo.
   */
  app.get("/api/projects", { preHandler: requireAuth }, async (request) => {
    const user = request.user!;
    const teamFilter = teamFilterOf(request);
    const repos = await github.listProjectRepos();
    const visible = new Map(
      (await store.clients.find(clientScope(user, teamFilter), { projection: { _id: 1, status: 1, teamId: 1 } }).toArray()).map((c) => [c._id, c])
    );
    const showAll = user.role === "boss" && !teamFilter;
    return {
      projects: repos.flatMap((repo) => {
        const slug = repo.name.match(/^(.+)-app$/)?.[1];
        const client = slug ? visible.get(slug) : undefined;
        if (!client && !showAll) return [];
        return [{ ...repo, clientId: client ? slug! : null, clientStatus: client?.status ?? null, teamId: client?.teamId ?? null }];
      }),
      platformTopic: PLATFORM_TOPIC
    };
  });

  /** Etiquetas (topics de GitHub) de un proyecto de la lista; los internos AB/WT y la plantilla no. */
  app.put("/api/projects/:name/topics", { preHandler: requireOperator }, async (request, reply) => {
    const params = repoParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Repositorio inválido." });
    const body = topicsSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? "Etiquetas inválidas." });
    // Solo repos de proyectos del equipo del usuario.
    const slug = params.data.name.match(/^(.+)-app$/)?.[1];
    const client = slug ? await store.getClient(slug) : null;
    if (!client || !canSeeClient(request.user!, client)) return reply.code(404).send({ error: "Proyecto no encontrado." });
    const repo = (await github.listProjectRepos()).find((r) => r.name === params.data.name);
    if (!repo) return reply.code(404).send({ error: "Proyecto no encontrado." });
    const topics = [...new Set(body.data.topics)].sort();
    await github.setRepositoryTopics(repo.name, topics);
    await store.audit({ actor: request.user!.username, action: "project.topics_updated", clientId: "-", target: repo.fullName, details: { topics } });
    return { topics };
  });
}
