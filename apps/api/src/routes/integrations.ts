import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../auth/session.js";
import { deriveNames, parseSlug, slugSchema } from "../domain/naming.js";
import { credentialsSchema, getProvider, publicCatalog, type ValidationCode } from "../integrations/catalog.js";
import type { JobEngine } from "../jobs/engine.js";
import { markConfigured, writeIntegrationSecrets } from "../jobs/stages/integrations.js";
import type { Deps } from "../jobs/types.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { ActiveJobExistsError, type AdminStore } from "../store/admin-store.js";
import type { StageName } from "../store/models.js";
import { registerIncomingSecrets } from "./clients.js";
import { appsDomainOf } from "../servers/resolve.js";

const providerParams = z.object({ provider: z.string().min(1).max(40) });
const clientProviderParams = z.object({ slug: slugSchema, provider: z.string().min(1).max(40) });

const VALIDATION_MESSAGES: Record<ValidationCode, string> = {
  auth_failed: "El proveedor rechazó la credencial.",
  timeout: "El proveedor no respondió a tiempo.",
  unavailable: "No se pudo contactar con el proveedor."
};

/**
 * Integraciones opcionales de las apps de clientes. Las credenciales nunca se
 * devuelven ni se registran: se validan contra el host fijo del catálogo, viajan
 * cifradas mientras se aprovisiona y acaban solo como secrets en GitHub.
 */
export async function registerIntegrationRoutes(
  app: FastifyInstance,
  { store, engine, deps }: { store: AdminStore; engine: JobEngine; deps: Deps }
) {
  // Probar conexión contacta un servicio externo: 10 por minuto por IP.
  const validationLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 });
  const limited = (request: FastifyRequest, reply: FastifyReply) => {
    if (validationLimiter.take(request.ip)) return false;
    void reply.code(429).send({ error: "Demasiadas pruebas de conexión. Espera un minuto." });
    return true;
  };

  type Parsed =
    | { ok: false; code: number; body: Record<string, unknown> }
    | { ok: true; provider: NonNullable<ReturnType<typeof getProvider>>; credentials: Record<string, string> };

  /** Valida el cuerpo como credenciales del proveedor (estricto). */
  function parseCredentials(providerId: string, body: unknown): Parsed {
    registerIncomingSecrets(body);
    const provider = getProvider(providerId);
    if (!provider) return { ok: false, code: 404, body: { error: "Integración desconocida." } };
    const parsed = credentialsSchema(provider).safeParse(body);
    if (!parsed.success) {
      return {
        ok: false,
        code: 400,
        body: { error: "Datos inválidos.", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }
      };
    }
    return { ok: true, provider, credentials: parsed.data as Record<string, string> };
  }

  app.get("/api/integrations/catalog", { preHandler: requireAdmin }, async () => ({
    providers: publicCatalog(),
    available: deps.secrets.available
  }));

  /** "Probar conexión" antes de enviar el formulario. Responde ok o un código genérico. */
  app.post("/api/integrations/:provider/validate", { preHandler: requireAdmin }, async (request, reply) => {
    const params = providerParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Proveedor inválido." });
    if (limited(request, reply)) return reply;
    const result = parseCredentials(params.data.provider, request.body);
    if (!result.ok) return reply.code(result.code).send(result.body);
    const validation = await deps.validateIntegration(result.provider.id, result.credentials);
    await store.audit({
      actor: request.user!.username,
      action: "integration_validated",
      clientId: "-",
      target: result.provider.id,
      details: validation.ok ? { ok: true } : { ok: false, code: validation.code }
    });
    return validation.ok ? { ok: true } : { ok: false, code: validation.code, error: VALIDATION_MESSAGES[validation.code] };
  });

  /**
   * Activa o actualiza la integración de un cliente:
   * - ready: valida, la escribe en GitHub y redespliega (trabajo seguido en el panel).
   * - failed sin github_secrets completada: valida y la guarda cifrada; el reintento la escribe.
   * - failed con github_secrets ya completada: valida y la escribe en GitHub; el reintento despliega.
   * - en aprovisionamiento u otro estado: 409.
   */
  app.put("/api/clients/:slug/integrations/:provider", { preHandler: requireAdmin }, async (request, reply) => {
    const params = clientProviderParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Parámetros inválidos." });
    const { slug } = params.data;
    const result = parseCredentials(params.data.provider, request.body);
    if (!result.ok) return reply.code(result.code).send(result.body);
    const { provider, credentials } = result;
    const client = await store.getClient(slug);
    if (!client) return reply.code(404).send({ error: "Cliente no encontrado." });
    if (client.status !== "ready" && client.status !== "failed") {
      return reply.code(409).send({ error: "El cliente tiene un trabajo en curso; espera a que termine." });
    }
    if (!deps.secrets.available) {
      return reply.code(503).send({ error: "Las integraciones no están disponibles: falta INTEGRATION_ENCRYPTION_KEY_SECRET_REF en el servidor." });
    }
    if (limited(request, reply)) return reply;

    const validation = await deps.validateIntegration(provider.id, credentials);
    if (!validation.ok) return reply.code(422).send({ error: VALIDATION_MESSAGES[validation.code], code: validation.code });

    const actor = request.user!.username;
    const names = deriveNames(parseSlug(slug), { targetOwner: deps.github.owner, appsDomain: appsDomainOf(client, deps.config) });
    const current = client.integrations?.[provider.id];

    if (client.status === "ready") {
      await deps.secrets.put(slug, provider.id, credentials);
      if (!current) await store.setClientFields(slug, { [`integrations.${provider.id}`]: { enabled: true, requestedAt: new Date() } });
      const deployed = deps.config.deployEnabled && !!client.deployment?.preparedAt;
      const stages: StageName[] = deployed ? ["integration_secret", "deploy", "health_check"] : ["integration_secret"];
      try {
        const job = await store.createJob({ clientId: slug, stages, actor, integration: { provider: provider.id, action: "set" } });
        void engine.start(job._id, actor);
        return reply.code(202).send({ action: deployed ? "redeploy" : "write", jobId: job._id });
      } catch (error) {
        if (error instanceof ActiveJobExistsError) return reply.code(409).send({ error: "El cliente ya tiene un trabajo en curso." });
        throw error;
      }
    }

    // failed: ¿llegó a completarse github_secrets? (un trabajo de integración implica que sí, al crear el cliente).
    const job = await store.getJob(client.latestJobId);
    const secretsStage = job?.stages.find((s) => s.name === "github_secrets");
    const secretsDone = secretsStage ? secretsStage.status === "succeeded" : true;
    if (!secretsDone) {
      await deps.secrets.put(slug, provider.id, credentials);
      await store.setClientFields(slug, {
        [`integrations.${provider.id}`]: { ...(current ?? {}), enabled: true, requestedAt: current?.requestedAt ?? new Date() }
      });
      await store.audit({ actor, action: "integration_credential_stored", clientId: slug, target: names.repositoryFullName, details: { provider: provider.id } });
      return reply.code(202).send({ action: "stored", message: "Credencial guardada. Se escribirá al reintentar el aprovisionamiento." });
    }
    const written = await writeIntegrationSecrets(deps, names.repository, provider, credentials);
    const { firstTime } = await markConfigured({ store, client }, provider.id);
    await store.audit({
      actor,
      action: firstTime ? "integration_enabled" : "integration_updated",
      clientId: slug,
      target: names.repositoryFullName,
      details: { provider: provider.id, names: written }
    });
    return reply.code(200).send({ action: "written", message: "Credencial escrita en GitHub. El reintento del aprovisionamiento desplegará con el valor nuevo." });
  });

  /** Quita la integración: borra los secrets y redespliega para que la variable desaparezca. */
  app.delete("/api/clients/:slug/integrations/:provider", { preHandler: requireAdmin }, async (request, reply) => {
    const params = clientProviderParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Parámetros inválidos." });
    const { slug } = params.data;
    const provider = getProvider(params.data.provider);
    if (!provider) return reply.code(404).send({ error: "Integración desconocida." });
    const client = await store.getClient(slug);
    if (!client) return reply.code(404).send({ error: "Cliente no encontrado." });
    if (client.status !== "ready") return reply.code(409).send({ error: "Solo se puede desactivar en un cliente listo." });
    if (!client.integrations?.[provider.id]) return reply.code(404).send({ error: `${provider.label} no está activada en este cliente.` });

    const actor = request.user!.username;
    const deployed = deps.config.deployEnabled && !!client.deployment?.preparedAt;
    const stages: StageName[] = deployed ? ["integration_remove", "deploy", "health_check"] : ["integration_remove"];
    try {
      const job = await store.createJob({ clientId: slug, stages, actor, integration: { provider: provider.id, action: "remove" } });
      void engine.start(job._id, actor);
      return reply.code(202).send({ action: deployed ? "redeploy" : "remove", jobId: job._id });
    } catch (error) {
      if (error instanceof ActiveJobExistsError) return reply.code(409).send({ error: "El cliente ya tiene un trabajo en curso." });
      throw error;
    }
  });
}
