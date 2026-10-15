import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { GithubAdapter } from "../adapters/github.js";
import type { Deps } from "../jobs/types.js";
import { requireAdmin } from "../auth/session.js";
import { deriveNames, parseSlug, slugSchema } from "../domain/naming.js";
import { type JobEngine, toPublicJob } from "../jobs/engine.js";
import { INITIAL_ADMIN_USERNAME } from "../jobs/stages/github-secrets.js";
import { redact } from "../lib/redact.js";
import { ActiveJobExistsError, type AdminStore, DuplicateClientError } from "../store/admin-store.js";
import type { ClientDoc } from "../store/models.js";

/**
 * Del navegador solo se aceptan nombre, slug y descripción. Base, usuario,
 * repo y subdominio se derivan del slug validado en el servidor; cualquier
 * otro campo enviado se descarta.
 */
const createClientSchema = z.object({
  name: z.string().trim().min(3).max(60),
  slug: slugSchema,
  description: z.string().trim().min(10).max(280)
});

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
  { store, engine, deps }: { store: AdminStore; engine: JobEngine; deps: Deps & { github: GithubAdapter } }
) {
  const { github, vault, server, config } = deps;
    const namesFor = (slug: string) => deriveNames(parseSlug(slug), { targetOwner: github.owner, appsDomain: config.appsDomain });

  app.post("/api/clients", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = createClientSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Datos inválidos.", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    const { name, slug, description } = parsed.data;
    const actor = request.user!.username;

    try {
      const job = await store.createClientWithJob({ slug, name, description, actor, stages: engine.stageNames });
      await store.audit({ actor, action: "client.created", clientId: slug, target: slug });
      void engine.start(job._id, actor);
      return reply.code(202).send({ clientId: slug, jobId: job._id });
    } catch (error) {
      if (error instanceof DuplicateClientError || error instanceof ActiveJobExistsError) {
        const existing = await store.getClient(slug);
        return reply.code(409).send({ error: `Ya existe un cliente con el identificador ${slug}.`, clientId: slug, jobId: existing?.latestJobId ?? null });
      }
      throw error;
    }
  });

  app.get("/api/clients/:slug", { preHandler: requireAdmin }, async (request, reply) => {
    const params = slugParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Identificador inválido." });
    const client = await store.getClient(params.data.slug);
    if (!client) return reply.code(404).send({ error: "Cliente no encontrado." });

    const names = namesFor(client._id);
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
        deployment: deploymentView(client, names.baseUrl),
        deployEnabled: config.deployEnabled,
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
  app.get("/api/clients/:slug/initial-password", { preHandler: requireAdmin }, async (request, reply) => {
    const params = slugParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Identificador inválido." });
    const client = await store.getClient(params.data.slug);
    if (!client) return reply.code(404).send({ error: "Cliente no encontrado." });
    return initialAdminStatus(client, await vault.pendingUntil(client._id), vault.now());
  });

  /**
   * Revelación única: entrega la contraseña y la borra en la misma operación.
   * La respuesta se envía ya serializada para que no pase por la redacción
   * global (que la ocultaría), con Cache-Control: no-store, y no se loguea.
   */
  app.post("/api/clients/:slug/initial-password/reveal", { preHandler: requireAdmin }, async (request, reply) => {
    const params = slugParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Identificador inválido." });
    const client = await store.getClient(params.data.slug);
    if (!client) return reply.code(404).send({ error: "Cliente no encontrado." });

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
  app.get("/api/platform", { preHandler: requireAdmin }, async () => ({
    deployEnabled: config.deployEnabled,
    appBaseDomain: config.appsDomain
  }));

  /** Estado en vivo en el servidor (consulta predefinida client-status). Sin variables de entorno. */
  app.get("/api/clients/:slug/server-status", { preHandler: requireAdmin }, async (request, reply) => {
    const params = slugParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Identificador inválido." });
    const client = await store.getClient(params.data.slug);
    if (!client) return reply.code(404).send({ error: "Cliente no encontrado." });
    if (!config.deployEnabled || !config.server) return reply.code(409).send({ error: "El despliegue no está habilitado." });
    try {
      const status = await server.clientStatus(parseSlug(client._id));
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
  app.post("/api/clients/:slug/redeploy", { preHandler: requireAdmin }, async (request, reply) => {
    const params = slugParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Identificador inválido." });
    const client = await store.getClient(params.data.slug);
    if (!client) return reply.code(404).send({ error: "Cliente no encontrado." });
    if (!config.deployEnabled) return reply.code(409).send({ error: "El despliegue no está habilitado." });
    if (!client.deployment?.preparedAt) {
      return reply.code(409).send({ error: "El servidor aún no está preparado para este cliente; termina primero el aprovisionamiento." });
    }
    const names = namesFor(client._id);
    const actor = request.user!.username;
    await github.dispatchWorkflow(names.repository, config.template.deployWorkflow, config.template.ref);
    const at = new Date();
    await store.setClientFields(client._id, { "deployment.redeployRequestedAt": at, "deployment.redeployRequestedBy": actor });
    await store.audit({ actor, action: "client.redeploy_requested", clientId: client._id, target: names.repositoryFullName });
    return reply.code(202).send({ requestedAt: at, actionsUrl: `https://github.com/${names.repositoryFullName}/actions` });
  });

  app.get("/api/jobs/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const job = await store.getJob(params.data.id);
    if (!job) return reply.code(404).send({ error: "Trabajo no encontrado." });
    return toPublicJob(job);
  });

  /** Progreso en tiempo real (NDJSON): una instantánea del trabajo por línea. */
  app.get("/api/jobs/:id/events", { preHandler: requireAdmin }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const job = await store.getJob(params.data.id);
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

  app.post("/api/jobs/:id/retry", { preHandler: requireAdmin }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const actor = request.user!.username;

    try {
      const job = await store.prepareRetry(params.data.id, engine.stageNames);
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

  /** Repos de GitHub de la organización (sin AB/WT), con el cliente asociado si lo hay. */
  app.get("/api/projects", { preHandler: requireAdmin }, async () => {
    const repos = await github.listProjectRepos();
    const clients = new Map(
      (await store.clients.find({}, { projection: { _id: 1, status: 1 } }).toArray()).map((c) => [c._id, c.status])
    );
    return {
      projects: repos.map((repo) => {
        const slug = repo.name.match(/^(.+)-app$/)?.[1];
        const status = slug ? clients.get(slug) : undefined;
        return { ...repo, clientId: status ? slug : null, clientStatus: status ?? null };
      })
    };
  });
}
