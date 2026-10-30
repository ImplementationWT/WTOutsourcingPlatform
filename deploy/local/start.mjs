// Arranque de Launchpad en local (compose.yaml). Completa lo que no hace falta configurar a
// mano y arranca la API:
// - claves de cifrado y SESSION_SECRET: se generan una vez y se guardan en el volumen
//   local-secrets (solo en este equipo);
// - usuario del panel: admin con LOCAL_ADMIN_PASSWORD si apps/api/.env no define otro;
// - rutas de apps/api/.env (el .pem de la GitHub App) se buscan en la carpeta montada.
// Solo hay que poner las credenciales de GitHub y Atlas en apps/api/.env.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

const SECRETS = "/home/node/local";
const HOST_API = "/run/host-api"; // apps/api del equipo, solo lectura

mkdirSync(SECRETS, { recursive: true, mode: 0o700 });

function generated(name, make) {
  const path = join(SECRETS, name);
  if (!existsSync(path)) writeFileSync(path, `${make()}\n`, { mode: 0o600 });
  return path;
}

// Claves AES-256 de la plataforma: siempre las locales (las de producción nunca salen del VPS).
const aesKey = () => randomBytes(32).toString("base64");
process.env.INITIAL_PASSWORD_KEY_PATH = generated("initial-password.key", aesKey);
process.env.INTEGRATION_ENCRYPTION_KEY_SECRET_REF = generated("integration.key", aesKey);
process.env.SERVER_KEYS_ENCRYPTION_KEY_SECRET_REF = generated("server-keys.key", aesKey);
process.env.ACCOUNT_VAULT_KEY_PATH = generated("account-vault.key", aesKey);
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32 || process.env.SESSION_SECRET.startsWith("CAMBIAR")) {
  process.env.SESSION_SECRET = readFileSync(generated("session.secret", () => randomBytes(32).toString("hex")), "utf8").trim();
}

/** Ruta de un archivo de apps/api/.env dentro del contenedor (relativa o con el nombre del archivo). */
function hostFile(value) {
  if (!value) return undefined;
  const candidates = isAbsolute(value) ? [value, join(HOST_API, basename(value))] : [join(HOST_API, value)];
  return candidates.find((path) => existsSync(path));
}

const missing = [];
const pem = hostFile(process.env.GITHUB_PRIVATE_KEY_PATH) ?? hostFile("github-app.pem");
if (pem) process.env.GITHUB_PRIVATE_KEY_PATH = pem;
else {
  const configured = process.env.GITHUB_PRIVATE_KEY_PATH;
  missing.push(
    configured
      ? `la clave privada de la GitHub App: apps/api/.env apunta a ${configured}, fuera de apps/api. Cópiala como apps/api/github-app.pem`
      : "la clave privada de la GitHub App: guárdala como apps/api/github-app.pem"
  );
}

// AI Developer (opcional): ANTHROPIC_API_KEY con el valor, o la ruta a un archivo en apps/api.
if (process.env.ANTHROPIC_API_KEY) {
  process.env.ANTHROPIC_API_KEY_SECRET_REF = generated("anthropic.key", () => process.env.ANTHROPIC_API_KEY);
  delete process.env.ANTHROPIC_API_KEY;
} else if (process.env.ANTHROPIC_API_KEY_SECRET_REF) {
  const found = hostFile(process.env.ANTHROPIC_API_KEY_SECRET_REF);
  if (found) process.env.ANTHROPIC_API_KEY_SECRET_REF = found;
  else delete process.env.ANTHROPIC_API_KEY_SECRET_REF;
}

const REQUIRED = [
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
];
for (const name of REQUIRED) {
  const value = process.env[name];
  if (!value || value.startsWith("CAMBIAR")) missing.push(name);
}
if (!process.env.APP_BASE_DOMAIN && !process.env.APPS_DOMAIN) missing.push("APP_BASE_DOMAIN");
if (missing.length) {
  process.stderr.write(
    [
      "",
      "Falta configuración para arrancar Launchpad en local. En apps/api/.env (cópialo de apps/api/.env.example):",
      ...missing.map((item) => `  - ${item}`),
      "",
      "Son las credenciales de la GitHub App y de MongoDB Atlas; todo lo demás se genera solo.",
      "Después vuelve a ejecutar: docker compose up --build",
      ""
    ].join("\n")
  );
  process.exit(1);
}

// Usuario del panel: el de apps/api/.env o admin con LOCAL_ADMIN_PASSWORD.
if (!process.env.PANEL_ADMIN_PASSWORD_HASH || process.env.PANEL_ADMIN_PASSWORD_HASH.startsWith("CAMBIAR")) {
  const { hashPassword } = await import("/app/dist/auth/password.js");
  process.env.PANEL_ADMIN_USERNAME = "admin";
  process.env.PANEL_ADMIN_PASSWORD_HASH = await hashPassword(process.env.LOCAL_ADMIN_PASSWORD || "launchpad-local");
}
process.stdout.write(`\nLaunchpad en local: http://localhost:${process.env.WEB_PORT || 8080} (usuario ${process.env.PANEL_ADMIN_USERNAME})\n\n`);

await import("/app/dist/index.js");
