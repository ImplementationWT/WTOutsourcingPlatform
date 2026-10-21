import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/session.js";

/** Servidores: infraestructura compartida entre equipos. Los ve cualquiera; los cambian los team leaders. */
const requireServerAdmin = requireRole("lead");
import { ProvisioningError } from "../lib/errors.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { hostname, hostOrIp, ipv4 } from "../lib/validators.js";
import { type ServerDirectory, ServerDirectoryError } from "../servers/directory.js";
import type { AdminStore } from "../store/admin-store.js";

const idParams = z.object({ id: z.string().uuid() });
const createSchema = z
  .object({
    name: z.string().trim().min(2).max(60),
    host: hostOrIp,
    sshPort: z.coerce.number().int().min(1).max(65535).default(22),
    appsDomain: hostname,
    publicIp: ipv4
  })
  .strict();
const pinSchema = z.object({ consoleOutput: z.string().trim().min(1).max(500) }).strict();
const deleteSchema = z.object({ confirm: z.string() }).strict();

/** La auditoría de servidores no es de ningún cliente. */
const PLATFORM = "platform";

/**
 * Servidores de despliegue (solo administradores). Nunca devuelven la clave privada
 * del provisioner: solo la pública, para instalarla con bootstrap-vps.sh.
 */
export async function registerServerRoutes(app: FastifyInstance, { store, servers }: { store: AdminStore; servers: ServerDirectory }) {
  // Las conexiones SSH a hosts arbitrarios se limitan: 30 por minuto por usuario.
  const sshLimiter = createRateLimiter({ limit: 30, windowMs: 60_000 });

  async function run<T>(reply: FastifyReply, fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ServerDirectoryError) return reply.code(error.status).send({ error: error.message });
      if (error instanceof ProvisioningError) return reply.code(502).send({ error: error.message });
      throw error;
    }
  }

  const parseId = (params: unknown, reply: FastifyReply) => {
    const parsed = idParams.safeParse(params);
    if (!parsed.success) void reply.code(400).send({ error: "Id inválido." });
    return parsed.success ? parsed.data.id : null;
  };

  app.get("/api/servers", { preHandler: requireAuth }, async () => ({
    available: servers.available,
    ghcrOrg: servers.ghcrOrg,
    servers: await servers.list()
  }));

  app.post("/api/servers", { preHandler: requireServerAdmin }, async (request, reply) => {
    const body = createSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Datos inválidos.", issues: body.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    const actor = request.user!.username;
    return run(reply, async () => {
      const server = await servers.create(body.data, actor);
      await store.audit({ actor, action: "server.created", clientId: PLATFORM, target: server.appsDomain, details: { server: server.id, host: server.host } });
      return reply.code(201).send({ server });
    });
  });

  app.get("/api/servers/:id", { preHandler: requireAuth }, async (request, reply) => {
    const id = parseId(request.params, reply);
    if (!id) return reply;
    return run(reply, async () => ({ server: await servers.get(id) }));
  });

  /** Huella actual del host (para compararla con la consola del VPS; no se fija). */
  app.post("/api/servers/:id/fingerprint", { preHandler: requireServerAdmin }, async (request, reply) => {
    const id = parseId(request.params, reply);
    if (!id) return reply;
    if (!sshLimiter.take(request.user!.username)) return reply.code(429).send({ error: "Demasiadas conexiones. Espera un minuto." });
    return run(reply, () => servers.readFingerprint(id));
  });

  app.post("/api/servers/:id/host-key", { preHandler: requireServerAdmin }, async (request, reply) => {
    const id = parseId(request.params, reply);
    if (!id) return reply;
    const body = pinSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Pega la salida de ssh-keygen -lf de la consola del VPS." });
    const actor = request.user!.username;
    if (!sshLimiter.take(actor)) return reply.code(429).send({ error: "Demasiadas conexiones. Espera un minuto." });
    return run(reply, async () => {
      const server = await servers.pinHostKey(id, body.data.consoleOutput);
      await store.audit({ actor, action: "server.host_key_pinned", clientId: PLATFORM, target: server.appsDomain, details: { fingerprint: server.hostKeyFingerprint ?? "" } });
      return { server };
    });
  });

  app.post("/api/servers/:id/verify", { preHandler: requireServerAdmin }, async (request, reply) => {
    const id = parseId(request.params, reply);
    if (!id) return reply;
    const actor = request.user!.username;
    if (!sshLimiter.take(actor)) return reply.code(429).send({ error: "Demasiadas conexiones. Espera un minuto." });
    return run(reply, async () => {
      const server = await servers.verify(id);
      await store.audit({ actor, action: "server.verified", clientId: PLATFORM, target: server.appsDomain, details: { ok: Boolean(server.verification?.ok) } });
      return { server };
    });
  });

  app.post("/api/servers/:id/rotate-key", { preHandler: requireServerAdmin }, async (request, reply) => {
    const id = parseId(request.params, reply);
    if (!id) return reply;
    const actor = request.user!.username;
    return run(reply, async () => {
      const server = await servers.rotateKey(id);
      await store.audit({ actor, action: "server.key_rotated", clientId: PLATFORM, target: server.appsDomain });
      return { server };
    });
  });

  /** Quitar un servidor: exige reenviar su dominio y que no tenga proyectos. */
  app.post("/api/servers/:id/delete", { preHandler: requireServerAdmin }, async (request, reply) => {
    const id = parseId(request.params, reply);
    if (!id) return reply;
    const body = deleteSchema.safeParse(request.body);
    const actor = request.user!.username;
    return run(reply, async () => {
      const server = await servers.get(id);
      if (!body.success || body.data.confirm !== server.appsDomain) {
        return reply.code(400).send({ error: "Escribe el dominio del servidor para confirmar." });
      }
      await servers.remove(id);
      await store.audit({ actor, action: "server.deleted", clientId: PLATFORM, target: server.appsDomain, details: { server: id } });
      return { ok: true };
    });
  });
}
