import { promises as dns } from "node:dns";
import { MongoClient } from "mongodb";
import { createAtlasAdapter } from "./adapters/atlas.js";
import { createAnthropicAgentAdapter } from "./ai/anthropic-adapter.js";
import { createGithubAdapter } from "./adapters/github.js";
import { createHttpProbe } from "./adapters/http-probe.js";
import { createMongoBootstrapAdapter } from "./adapters/mongo-bootstrap.js";
import { createServerAdapter } from "./adapters/server.js";
import { buildApp } from "./app.js";
import { appBaseDomain, loadAnthropicKey, loadEnv, loadInitialPasswordKey, loadIntegrationKey, loadServerConfig } from "./config/env.js";
import { getProvider } from "./integrations/catalog.js";
import { DEFAULT_TIMING } from "./jobs/types.js";
import { registerSecret } from "./lib/redact.js";
import { AdminStore } from "./store/admin-store.js";
import { InitialPasswordVault } from "./store/initial-password-vault.js";
import { ProvisioningSecrets } from "./store/provisioning-secrets.js";

const env = loadEnv();
for (const secret of [env.ATLAS_CLIENT_SECRET, env.ADMIN_MONGODB_URI, env.SESSION_SECRET, env.PANEL_ADMIN_PASSWORD_HASH]) {
  registerSecret(secret);
}
const server = loadServerConfig(env);
// Antes de conectar: una clave mal configurada detiene el arranque con un mensaje claro.
const initialPasswordKey = loadInitialPasswordKey(env);
const integrationKey = loadIntegrationKey(env);
const anthropicKey = loadAnthropicKey(env);
registerSecret(anthropicKey);
if (server) registerSecret(server.provisionerKey);

const adminClient = new MongoClient(env.ADMIN_MONGODB_URI, { appName: "provisioning-platform" });
await adminClient.connect();
const store = new AdminStore(adminClient.db(env.ADMIN_MONGODB_DB));
await store.init();
const vault = new InitialPasswordVault(store.initialPasswords, initialPasswordKey);
await vault.init();
const secrets = new ProvisioningSecrets(store.provisioningSecrets, integrationKey, env.INTEGRATION_SECRET_TTL_HOURS * 3_600_000);
await secrets.init();

const app = await buildApp({
  store,
  logLevel: env.LOG_LEVEL,
  ai: anthropicKey
    ? {
        agent: createAnthropicAgentAdapter(anthropicKey, store.aiAgentSettings),
        config: { sessionBudgetCents: env.AI_SESSION_BUDGET_USD * 100, workspace: env.ANTHROPIC_WORKSPACE }
      }
    : undefined,
  auth: {
    adminUsername: env.PANEL_ADMIN_USERNAME,
    adminPasswordHash: env.PANEL_ADMIN_PASSWORD_HASH,
    sessionSecret: env.SESSION_SECRET,
    secureCookies: env.NODE_ENV === "production"
  },
  deps: {
    atlas: createAtlasAdapter({
      projectId: env.ATLAS_PROJECT_ID,
      clientId: env.ATLAS_CLIENT_ID,
      clientSecret: env.ATLAS_CLIENT_SECRET,
      clusterName: env.ATLAS_CLUSTER_NAME
    }),
    github: createGithubAdapter({
      appId: env.GITHUB_APP_ID,
      installationId: env.GITHUB_INSTALLATION_ID,
      privateKeyPath: env.GITHUB_PRIVATE_KEY_PATH,
      templateOwner: env.GITHUB_TEMPLATE_OWNER,
      templateRepo: env.GITHUB_TEMPLATE_REPO,
      targetOwner: env.GITHUB_TARGET_OWNER
    }),
    mongo: createMongoBootstrapAdapter(),
    probe: createHttpProbe({ allowUntrustedCertificates: Boolean(server?.acmeCa) }),
    server: server
      ? createServerAdapter({ host: server.host, port: server.port, hostKeys: server.hostKeys, provisionerKey: server.provisionerKey })
      : {
          installClient: () => Promise.reject(new Error("Servidor de despliegue no configurado.")),
          clientStatus: () => Promise.reject(new Error("Servidor de despliegue no configurado.")),
          uninstallClient: () => Promise.reject(new Error("Servidor de despliegue no configurado.")),
          installPreview: () => Promise.reject(new Error("Servidor de despliegue no configurado.")),
          stopPreview: () => Promise.reject(new Error("Servidor de despliegue no configurado."))
        },
    resolver: { resolve4: (host) => dns.resolve4(host) },
    vault,
    secrets,
    validateIntegration: async (providerId, credentials) => {
      const provider = getProvider(providerId);
      if (!provider) return { ok: false, code: "unavailable" };
      return provider.validate(credentials);
    },
    timing: DEFAULT_TIMING,
    config: {
      appsDomain: appBaseDomain(env),
      atlas: { clusterName: env.ATLAS_CLUSTER_NAME, srvHost: env.ATLAS_CLUSTER_SRV_HOST, projectId: env.ATLAS_PROJECT_ID },
      template: {
        name: "node-typescript",
        environment: "production",
        deployWorkflow: "deploy.yml",
        ref: "main",
        schemaVersion: 1,
        expectedVersion: env.TEMPLATE_VERSION,
        minSchemaVersion: env.MIN_SCHEMA_VERSION
      },
      initialAdmin: { mode: env.INITIAL_ADMIN_MODE, revealTtlMs: 30 * 60_000 },
      deployEnabled: env.DEPLOY_ENABLED,
      server: server && {
        host: server.host,
        knownHosts: server.knownHosts,
        publicIp: server.publicIp,
        ghcrOrg: server.ghcrOrg,
        acmeCa: server.acmeCa
      }
    }
  }
});

// Trabajos que quedaron a medias por un reinicio: se marcan como fallidos para reintentarlos.
const abandoned = await store.failAbandonedJobs();
if (abandoned) app.log.warn({ abandoned }, "Marked interrupted jobs as failed");
app.log.info(
  { deployEnabled: env.DEPLOY_ENABLED, aiDeveloper: Boolean(anthropicKey), templateVersion: env.TEMPLATE_VERSION, integrations: secrets.available, minSchemaVersion: env.MIN_SCHEMA_VERSION, initialAdminMode: env.INITIAL_ADMIN_MODE },
  env.DEPLOY_ENABLED ? "Pipeline completo (con despliegue)" : "Fase 1: repo + MongoDB + secrets (despliegue deshabilitado)"
);

const shutdown = async () => {
  await app.close();
  await adminClient.close();
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

try {
  await app.listen({ port: env.PORT, host: "127.0.0.1" });
} catch (error) {
  app.log.error({ err: error }, "Server failed to start");
  process.exitCode = 1;
}
