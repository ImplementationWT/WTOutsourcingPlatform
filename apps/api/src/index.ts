import { MongoClient } from "mongodb";
import { createAtlasAdapter } from "./adapters/atlas.js";
import { createGithubAdapter } from "./adapters/github.js";
import { createHttpProbe } from "./adapters/http-probe.js";
import { createMongoBootstrapAdapter } from "./adapters/mongo-bootstrap.js";
import { buildApp } from "./app.js";
import { loadDeployConfig, loadEnv, loadInitialPasswordKey } from "./config/env.js";
import { DEFAULT_TIMING } from "./jobs/types.js";
import { registerSecret } from "./lib/redact.js";
import { AdminStore } from "./store/admin-store.js";
import { InitialPasswordVault } from "./store/initial-password-vault.js";

const env = loadEnv();
for (const secret of [env.ATLAS_CLIENT_SECRET, env.ADMIN_MONGODB_URI, env.SESSION_SECRET, env.PANEL_ADMIN_PASSWORD_HASH]) {
  registerSecret(secret);
}
const deploy = loadDeployConfig(env);
// Antes de conectar: una clave mal configurada detiene el arranque con un mensaje claro.
const initialPasswordKey = loadInitialPasswordKey(env);
if (deploy) {
  registerSecret(deploy.privateKey);
}
if (env.DEPLOY_ENABLED && !deploy) {
  throw new Error(
    "DEPLOY_ENABLED=true requiere DEPLOY_SSH_HOST, DEPLOY_SSH_USER, DEPLOY_SSH_PRIVATE_KEY_PATH y DEPLOY_SSH_KNOWN_HOSTS_PATH."
  );
}

const adminClient = new MongoClient(env.ADMIN_MONGODB_URI, { appName: "provisioning-platform" });
await adminClient.connect();
const store = new AdminStore(adminClient.db(env.ADMIN_MONGODB_DB));
await store.init();
const vault = new InitialPasswordVault(store.initialPasswords, initialPasswordKey);
await vault.init();

const app = await buildApp({
  store,
  logLevel: env.LOG_LEVEL,
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
    probe: createHttpProbe(),
    vault,
    timing: DEFAULT_TIMING,
    config: {
      appsDomain: env.APPS_DOMAIN,
      atlas: { clusterName: env.ATLAS_CLUSTER_NAME, srvHost: env.ATLAS_CLUSTER_SRV_HOST },
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
      deploy
    }
  }
});

// Trabajos que quedaron a medias por un reinicio: se marcan como fallidos para reintentarlos.
const abandoned = await store.failAbandonedJobs();
if (abandoned) app.log.warn({ abandoned }, "Marked interrupted jobs as failed");
app.log.info(
  { deployEnabled: env.DEPLOY_ENABLED, templateVersion: env.TEMPLATE_VERSION ?? "la de la plantilla", minSchemaVersion: env.MIN_SCHEMA_VERSION, initialAdminMode: env.INITIAL_ADMIN_MODE },
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
