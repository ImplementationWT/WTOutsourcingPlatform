import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { GithubAdapter } from "../adapters/github.js";
import { requireAdmin } from "../auth/session.js";
import { deriveNames, parseSlug, slugSchema } from "../domain/naming.js";
import { type JobEngine, toPublicJob } from "../jobs/engine.js";
import { redact } from "../lib/redact.js";
import { ActiveJobExistsError, type AdminStore, DuplicateClientError } from "../store/admin-store.js";

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

export async function registerClientRoutes(
  app: FastifyInstance,
  { store, engine, github, appsDomain }: { store: AdminStore; engine: JobEngine; github: GithubAdapter; appsDomain: string }
) {
  const namesFor = (slug: string) => deriveNames(parseSlug(slug), { targetOwner: github.owner, appsDomain });

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
    const [job, repo] = await Promise.all([
      store.getJob(client.latestJobId),
      store.getResource("github_repository", names.repositoryFullName)
    ]);

    // Solo referencias: nunca URI ni contraseñas.
    return {
      client: {
        id: client._id,
        name: client.name,
        description: client.description,
        status: client.status,
        readiness: client.readiness,
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
