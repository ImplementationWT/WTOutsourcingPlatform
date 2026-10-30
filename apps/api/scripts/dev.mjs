// pnpm dev (desde la raíz): la API en local con recarga automática, sin Docker.
// - Base administrativa: una MongoDB local propia (mongodb-memory-server) con los datos en
//   apps/api/.dev/mongo. Nunca la de producción, aunque apps/api/.env tenga ADMIN_MONGODB_URI.
// - Claves de cifrado y SESSION_SECRET: se generan una vez en apps/api/.dev.
// - Usuario del panel: el de apps/api/.env o admin / launchpad-local.
// - Despliegue a servidores desactivado: desde local nunca se toca un VPS.
// Solo hacen falta en apps/api/.env las credenciales de la GitHub App y de MongoDB Atlas.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API = dirname(dirname(fileURLToPath(import.meta.url)));
const DEV = join(API, ".dev");
const MONGO_PORT = 27027;

const { parse } = await import("dotenv");
const { MongoMemoryServer } = await import("mongodb-memory-server");

mkdirSync(join(DEV, "mongo"), { recursive: true, mode: 0o700 });
function generated(name, make) {
  const path = join(DEV, name);
  if (!existsSync(path)) writeFileSync(path, `${make()}\n`, { mode: 0o600 });
  return path;
}

const envPath = join(API, ".env");
const fileEnv = existsSync(envPath) ? parse(readFileSync(envPath)) : {};
const value = (name) => process.env[name] ?? fileEnv[name];
const usable = (v) => Boolean(v) && !v.startsWith("CAMBIAR");

const missing = [
  "GITHUB_APP_ID",
  "GITHUB_INSTALLATION_ID",
  "GITHUB_TEMPLATE_OWNER",
  "GITHUB_TEMPLATE_REPO",
  "GITHUB_TARGET_OWNER",
  "ATLAS_PROJECT_ID",
  "ATLAS_CLIENT_ID",
  "ATLAS_CLIENT_SECRET",
  "ATLAS_CLUSTER_NAME",
  "ATLAS_CLUSTER_SRV_HOST"
].filter((name) => !usable(value(name)));
if (!usable(value("APP_BASE_DOMAIN")) && !usable(value("APPS_DOMAIN"))) missing.push("APP_BASE_DOMAIN");
const pem = value("GITHUB_PRIVATE_KEY_PATH");
const pemPath = pem && (isAbsolute(pem) ? pem : resolve(API, pem));
if (!pemPath || !existsSync(pemPath)) missing.push(`GITHUB_PRIVATE_KEY_PATH (ruta al .pem de la GitHub App${pem ? `; no existe ${pem}` : ""})`);
if (missing.length) {
  console.error(
    [
      "",
      "Falta configuración para arrancar la API en local. En apps/api/.env (cópialo de apps/api/.env.example):",
      ...missing.map((item) => `  - ${item}`),
      "",
      "Son las credenciales de la GitHub App y de MongoDB Atlas; todo lo demás se genera solo.",
      ""
    ].join("\n")
  );
  process.exit(1);
}

const aesKey = () => randomBytes(32).toString("base64");
const env = {
  ...process.env,
  NODE_ENV: "development",
  DEPLOY_ENABLED: "false",
  DEPLOY_HOST: "",
  PROVISIONER_SSH_KEY_SECRET_REF: "",
  GITHUB_PRIVATE_KEY_PATH: pemPath,
  INITIAL_PASSWORD_KEY_PATH: generated("initial-password.key", aesKey),
  INTEGRATION_ENCRYPTION_KEY_SECRET_REF: generated("integration.key", aesKey),
  SERVER_KEYS_ENCRYPTION_KEY_SECRET_REF: generated("server-keys.key", aesKey),
  ACCOUNT_VAULT_KEY_PATH: generated("account-vault.key", aesKey)
};
const secret = value("SESSION_SECRET");
if (!usable(secret) || secret.length < 32) env.SESSION_SECRET = readFileSync(generated("session.secret", () => randomBytes(32).toString("hex")), "utf8").trim();
if (!usable(value("PANEL_ADMIN_PASSWORD_HASH"))) {
  // Se ejecuta con tsx: usa el mismo hash (scrypt) que la API.
  const { hashPassword } = await import("../src/auth/password.js");
  env.PANEL_ADMIN_PASSWORD_HASH = await hashPassword(process.env.LOCAL_ADMIN_PASSWORD || "launchpad-local");
  env.PANEL_ADMIN_USERNAME = "admin";
}
// AI Developer (opcional): ANTHROPIC_API_KEY con el valor también vale.
if (usable(value("ANTHROPIC_API_KEY"))) env.ANTHROPIC_API_KEY_SECRET_REF = generated("anthropic.key", () => value("ANTHROPIC_API_KEY"));

const mongo = await MongoMemoryServer.create({ instance: { dbPath: join(DEV, "mongo"), port: MONGO_PORT, storageEngine: "wiredTiger" } });
env.ADMIN_MONGODB_URI = mongo.getUri();

console.log(
  [
    "",
    "API de Launchpad en local: http://127.0.0.1:3001",
    `Base administrativa local: ${env.ADMIN_MONGODB_URI} (datos en apps/api/.dev/mongo)`,
    `Usuario del panel: ${env.PANEL_ADMIN_USERNAME ?? value("PANEL_ADMIN_USERNAME")}`,
    "Ahora, en otra terminal: pnpm dev:web  →  http://localhost:5173",
    ""
  ].join("\n")
);

const child = spawn("pnpm", ["exec", "tsx", "watch", "src/index.ts"], { cwd: API, env, stdio: "inherit" });
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  child.kill("SIGTERM");
  await mongo.stop({ doCleanup: false }).catch(() => undefined);
  process.exit(code);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
child.on("exit", (code) => void stop(code ?? 0));
