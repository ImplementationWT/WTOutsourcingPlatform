import Fastify from "fastify";
import type { GithubAdapter } from "./adapters/github.js";
import { PreviewPasses } from "./ai/preview-pass.js";
import { AiDeveloper } from "./ai/service.js";
import type { AiAgentAdapter, AiConfig } from "./ai/types.js";
import { type AuthConfig, registerAuth } from "./auth/session.js";
import { UserDirectory } from "./auth/users.js";
import { JobEngine } from "./jobs/engine.js";
import { Teardown } from "./jobs/teardown.js";
import type { Deps } from "./jobs/types.js";
import { ProvisioningError } from "./lib/errors.js";
import { loggerOptions } from "./lib/logger.js";
import { redact } from "./lib/redact.js";
import type { MeetingAnalyzer } from "./meetings/analyzer.js";
import { MeetingProcessing } from "./meetings/processing.js";
import { registerAiRoutes } from "./routes/ai.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerClientRoutes } from "./routes/clients.js";
import { registerCommercialRoutes } from "./routes/commercial.js";
import { registerCoreRoutes } from "./routes/core.js";
import { registerCostRoutes } from "./routes/costs.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerDealRoutes } from "./routes/deals.js";
import { registerIntegrationRoutes } from "./routes/integrations.js";
import { registerMeetingInboxRoutes } from "./routes/meetings.js";
import { registerOpsRoutes } from "./routes/ops.js";
import { registerSalesRoutes } from "./routes/sales.js";
import { registerServerRoutes } from "./routes/servers.js";
import { ServerDirectory } from "./servers/directory.js";
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
  /** Servidores de despliegue; sin él, solo el principal de la configuración (sin alta desde el panel). */
  servers?: ServerDirectory;
  /** Clave AES-256 del vault de cuentas de Operativa; sin ella, esas rutas responden 503. */
  vaultKey?: Buffer;
  /** Procesa las reuniones con Claude; sin él quedan pendientes y el reproceso responde 503. */
  meetingAnalyzer?: MeetingAnalyzer;
  /** Signing key del webhook de Read.ai; sin ella el webhook responde 503. */
  readAiSigningKey?: Buffer;
}

export async function buildApp({ store, deps: baseDeps, auth, logLevel, logStream, ai, servers: givenServers, vaultKey, meetingAnalyzer, readAiSigningKey }: AppOptions) {
  const app = Fastify({
    logger: loggerOptions({ level: logLevel, stream: logStream }),
    // La API solo escucha en 127.0.0.1 detrás de nginx: se confía únicamente en ese salto, así
    // request.ip es la IP que vio nginx (lo que el cliente añada a X-Forwarded-For se ignora).
    trustProxy: ["127.0.0.1", "::1"]
  });
  const primary = baseDeps.config.server;
  const servers =
    givenServers ??
    new ServerDirectory({
      servers: store.servers,
      clients: store.clients,
      primary: primary && { ...primary, appsDomain: baseDeps.config.appsDomain, adapter: baseDeps.server },
      ghcrOrg: primary?.ghcrOrg,
      acmeCa: primary?.acmeCa,
      resolver: baseDeps.resolver
    });
  // Etapas, borrado y AI Developer resuelven el servidor de cada proyecto con `servers`. Se
  // asigna sobre el mismo objeto (no una copia): quien lo creó sigue viendo los mismos deps.
  const deps = baseDeps;
  deps.servers ??= servers;
  const engine = new JobEngine(store, deps, app.log.child({ component: "jobs" }));
  const teardown = new Teardown(store, deps, app.log.child({ component: "teardown" }));
  const aiDeveloper = ai
    ? new AiDeveloper({
        store,
        github: deps.github,
        agent: ai.agent,
        server: deps.server,
        servers: deps.servers,
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

  // Usuarios: en el primer arranque la cuenta admin de la configuración pasa a ser un jefe.
  const users = new UserDirectory(store);
  if (await users.bootstrapFromConfig(auth.adminUsername, auth.adminPasswordHash)) {
    app.log.info({ username: auth.adminUsername }, "Config admin migrated to a boss user");
  }
  await registerAuth(app, auth, users);
  await registerAdminRoutes(app, { users });
  await registerCostRoutes(app, { store });
  await registerClientRoutes(app, { store, engine, teardown, deps, servers });
  await registerServerRoutes(app, { store, servers });
  await registerDashboardRoutes(app, { store, deps });
  await registerIntegrationRoutes(app, { store, engine, deps });
  await registerAiRoutes(app, { store, ai: aiDeveloper, secureCookies: auth.secureCookies });
  const meetings = new MeetingProcessing(meetingAnalyzer, app.log.child({ component: "meetings" }));
  await registerOpsRoutes(app, { store, vaultKey, meetings });
  await registerSalesRoutes(app, { store, meetings });
  await registerCoreRoutes(app, { store });
  await registerDealRoutes(app, { store });
  await registerCommercialRoutes(app, { store });
  await registerMeetingInboxRoutes(app, { store, processing: meetings, signingKey: readAiSigningKey });

  app.addHook("onClose", async () => {
    if (previewSweep) clearInterval(previewSweep);
    await Promise.all([engine.idle(), teardown.idle(), meetings.idle()]);
  });

  return Object.assign(app, { engine, teardown, store, aiDeveloper, servers, users, meetings });
}
