import Fastify from "fastify";
import type { GithubAdapter } from "./adapters/github.js";
import { PreviewPasses } from "./ai/preview-pass.js";
import { AiDeveloper } from "./ai/service.js";
import type { AiAgentAdapter, AiConfig } from "./ai/types.js";
import { type AuthConfig, registerAuth } from "./auth/session.js";
import { JobEngine } from "./jobs/engine.js";
import { Teardown } from "./jobs/teardown.js";
import type { Deps } from "./jobs/types.js";
import { ProvisioningError } from "./lib/errors.js";
import { loggerOptions } from "./lib/logger.js";
import { redact } from "./lib/redact.js";
import { registerAiRoutes } from "./routes/ai.js";
import { registerClientRoutes } from "./routes/clients.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerIntegrationRoutes } from "./routes/integrations.js";
import type { AdminStore } from "./store/admin-store.js";

export interface AppOptions {
  store: AdminStore;
  deps: Deps & { github: GithubAdapter };
  auth: AuthConfig;
  logLevel?: string;
  /** Destino de los logs (tests: para verificar la redacción). */
  logStream?: NodeJS.WritableStream;
  /** AI Developer (Claude Managed Agents); sin él, sus rutas responden 503. */
  ai?: { agent: AiAgentAdapter; config: AiConfig; now?: () => Date };
}

export async function buildApp({ store, deps, auth, logLevel, logStream, ai }: AppOptions) {
  const app = Fastify({ logger: loggerOptions({ level: logLevel, stream: logStream }) });
  const engine = new JobEngine(store, deps, app.log.child({ component: "jobs" }));
  const teardown = new Teardown(store, deps, app.log.child({ component: "teardown" }));
  const aiDeveloper = ai
    ? new AiDeveloper({
        store,
        github: deps.github,
        agent: ai.agent,
        server: deps.server,
        passes: new PreviewPasses(auth.sessionSecret, ai.now ? () => ai.now!().getTime() : undefined),
        config: ai.config,
        provisioning: deps.config,
        log: app.log.child({ component: "ai" }),
        now: ai.now
      })
    : undefined;
  // Las vistas previas sin visitas se apagan solas (revisión cada 5 minutos).
  const previewSweep = aiDeveloper
    ? setInterval(() => void aiDeveloper.sweepPreviews().catch((error) => app.log.warn({ err: error }, "preview sweep failed")), 5 * 60_000)
    : undefined;
  previewSweep?.unref();

  // Última barrera: ninguna respuesta JSON sale sin redactar.
  app.addHook("preSerialization", async (_request, _reply, payload) => redact(payload));

  app.setErrorHandler((error, request, reply) => {
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      // Errores del cliente (p. ej. JSON mal formado): el mensaje puede citar el cuerpo
      // recibido, que puede llevar credenciales. Se registra solo el código.
      request.log.warn({ code: (error as { code?: string }).code ?? "client_error", statusCode: status }, "Bad request");
      return reply.code(status).send({ error: "Petición inválida." });
    }
    request.log.error({ err: error }, "Request failed");
    const message = error instanceof ProvisioningError ? error.message : "Error interno del servidor.";
    return reply.code(error instanceof ProvisioningError ? 502 : 500).send({ error: redact(message) });
  });

  app.get("/health", async () => ({ status: "ok", service: "provisioning-api" }));

  await registerAuth(app, auth);
  await registerClientRoutes(app, { store, engine, teardown, deps });
  await registerDashboardRoutes(app, { store, deps });
  await registerIntegrationRoutes(app, { store, engine, deps });
  await registerAiRoutes(app, { store, ai: aiDeveloper, appsDomain: deps.config.appsDomain, secureCookies: auth.secureCookies });

  app.addHook("onClose", async () => {
    if (previewSweep) clearInterval(previewSweep);
    await Promise.all([engine.idle(), teardown.idle()]);
  });

  return Object.assign(app, { engine, teardown, store, aiDeveloper });
}
