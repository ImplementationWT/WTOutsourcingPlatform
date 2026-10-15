import Fastify from "fastify";
import type { GithubAdapter } from "./adapters/github.js";
import { type AuthConfig, registerAuth } from "./auth/session.js";
import { JobEngine } from "./jobs/engine.js";
import type { Deps } from "./jobs/types.js";
import { ProvisioningError } from "./lib/errors.js";
import { loggerOptions } from "./lib/logger.js";
import { redact } from "./lib/redact.js";
import { registerClientRoutes } from "./routes/clients.js";
import type { AdminStore } from "./store/admin-store.js";

export interface AppOptions {
  store: AdminStore;
  deps: Deps & { github: GithubAdapter };
  auth: AuthConfig;
  logLevel?: string;
  /** Destino de los logs (tests: para verificar la redacción). */
  logStream?: NodeJS.WritableStream;
}

export async function buildApp({ store, deps, auth, logLevel, logStream }: AppOptions) {
  const app = Fastify({ logger: loggerOptions({ level: logLevel, stream: logStream }) });
  const engine = new JobEngine(store, deps, app.log.child({ component: "jobs" }));

  // Última barrera: ninguna respuesta JSON sale sin redactar.
  app.addHook("preSerialization", async (_request, _reply, payload) => redact(payload));

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "Request failed");
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: "Petición inválida." });
    }
    const message = error instanceof ProvisioningError ? error.message : "Error interno del servidor.";
    return reply.code(error instanceof ProvisioningError ? 502 : 500).send({ error: redact(message) });
  });

  app.get("/health", async () => ({ status: "ok", service: "provisioning-api" }));

  await registerAuth(app, auth);
  await registerClientRoutes(app, { store, engine, deps });

  app.addHook("onClose", async () => {
    await engine.idle();
  });

  return Object.assign(app, { engine });
}
