import "dotenv/config";
import { readFileSync } from "node:fs";
import { z } from "zod";

const hostname = z
  .string()
  .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i, "debe ser un hostname sin esquema ni ruta");

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

export const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  // GitHub App
  GITHUB_APP_ID: z.coerce.number().int().positive(),
  GITHUB_INSTALLATION_ID: z.coerce.number().int().positive(),
  GITHUB_PRIVATE_KEY_PATH: z.string().min(1),
  GITHUB_TEMPLATE_OWNER: z.string().min(1),
  GITHUB_TEMPLATE_REPO: z.string().min(1),
  GITHUB_TARGET_OWNER: z.string().min(1),

  // MongoDB Atlas: Service Account con rol Project Database Access Admin.
  ATLAS_PROJECT_ID: z.string().regex(/^[a-f0-9]{24}$/, "debe ser el Project ID de 24 caracteres hex"),
  ATLAS_CLIENT_ID: z.string().min(1),
  ATLAS_CLIENT_SECRET: z.string().min(1),
  ATLAS_CLUSTER_NAME: z.string().min(1),
  ATLAS_CLUSTER_SRV_HOST: hostname,

  // Base administrativa (clientes, trabajos, recursos, auditoría). Usuario distinto al de Atlas API.
  ADMIN_MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, "debe empezar por mongodb:// o mongodb+srv://"),
  ADMIN_MONGODB_DB: z.string().regex(/^[a-zA-Z0-9_-]+$/).default("provisioning_admin"),

  // Dominio de las apps de clientes: https://<slug>.<APPS_DOMAIN>
  APPS_DOMAIN: hostname,

  // Fase 2: despliegue + health check. Mientras sea false, el trabajo termina
  // tras crear el repo, la base y los secrets.
  DEPLOY_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  // Secrets SSH compartidos para el workflow Deploy (contrato §3).
  // Obligatorios solo con DEPLOY_ENABLED=true.
  DEPLOY_SSH_HOST: optional(hostname),
  DEPLOY_SSH_USER: optional(z.string().min(1)),
  DEPLOY_SSH_PORT: optional(z.coerce.number().int().min(1).max(65535)),
  DEPLOY_SSH_PRIVATE_KEY_PATH: optional(z.string().min(1)),
  DEPLOY_SSH_KNOWN_HOSTS_PATH: optional(z.string().min(1)),

  // Template (contrato §1 y §8). Sin TEMPLATE_VERSION, la versión esperada se lee en cada trabajo
  // del package.json de la plantilla: al actualizarla no hay que tocar la configuración.
  // Solo para fijar una versión concreta (p. ej. congelar los clientes nuevos en una).
  TEMPLATE_VERSION: optional(z.string().regex(/^\d+\.\d+\.\d+$/, "debe ser SemVer, p. ej. 1.2.0")),
  // schemaVersion mínima que debe exponer /api/meta (opcional; /health/ready ya exige migraciones terminadas).
  MIN_SCHEMA_VERSION: optional(z.coerce.number().int().min(1)).default(1),

  // Contraseña inicial del admin de cada app (contrato §3).
  // random: se genera y se escribe INITIAL_ADMIN_PASSWORD. default: el template usa la suya y obliga a cambiarla.
  INITIAL_ADMIN_MODE: optional(z.enum(["random", "default"])).default("random"),
  // Ruta al archivo con la clave (32 bytes en base64) que cifra la contraseña hasta su revelación única.
  // Obligatoria con INITIAL_ADMIN_MODE=random. Genérala con: openssl rand -base64 32 > initial-password.key
  INITIAL_PASSWORD_KEY_PATH: optional(z.string().min(1)),

  // Sesión del panel
  PANEL_ADMIN_USERNAME: z.string().min(3),
  PANEL_ADMIN_PASSWORD_HASH: z.string().regex(/^scrypt\$/, "genéralo con `pnpm hash-password`"),
  SESSION_SECRET: z.string().min(32, "usa al menos 32 caracteres aleatorios")
});

export type Env = z.infer<typeof envSchema>;

/** Valida process.env. Los errores nombran la variable y la regla, nunca el valor. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // Valores de ejemplo de .env que aún no se han reemplazado.
  const placeholders = Object.keys(envSchema.shape).filter((key) => source[key]?.startsWith("CAMBIAR"));
  if (placeholders.length) {
    throw new Error(
      `Faltan valores reales en apps/api/.env (aún tienen CAMBIAR_…):\n${placeholders.map((key) => `  - ${key}`).join("\n")}`
    );
  }

  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Configuración inválida:\n${problems}`);
  }
  if (parsed.data.INITIAL_ADMIN_MODE === "random" && !parsed.data.INITIAL_PASSWORD_KEY_PATH) {
    throw new Error("Configuración inválida:\n  - INITIAL_PASSWORD_KEY_PATH: obligatoria con INITIAL_ADMIN_MODE=random");
  }
  return parsed.data;
}

/** Clave AES-256 para la revelación única de la contraseña inicial (archivo con 32 bytes en base64). */
export function loadInitialPasswordKey(env: Env) {
  if (!env.INITIAL_PASSWORD_KEY_PATH) return undefined;
  const key = Buffer.from(readFileSync(env.INITIAL_PASSWORD_KEY_PATH, "utf8").trim(), "base64");
  if (key.length !== 32) {
    throw new Error("Configuración inválida:\n  - INITIAL_PASSWORD_KEY_PATH: el archivo debe contener 32 bytes en base64 (openssl rand -base64 32)");
  }
  return key;
}

export function loadDeployConfig(env: Env) {
  const { DEPLOY_SSH_HOST, DEPLOY_SSH_USER, DEPLOY_SSH_PRIVATE_KEY_PATH, DEPLOY_SSH_KNOWN_HOSTS_PATH, DEPLOY_SSH_PORT } = env;
  if (!DEPLOY_SSH_HOST || !DEPLOY_SSH_USER || !DEPLOY_SSH_PRIVATE_KEY_PATH || !DEPLOY_SSH_KNOWN_HOSTS_PATH) return undefined;
  return {
    host: DEPLOY_SSH_HOST,
    user: DEPLOY_SSH_USER,
    port: DEPLOY_SSH_PORT,
    privateKey: readFileSync(DEPLOY_SSH_PRIVATE_KEY_PATH, "utf8"),
    knownHosts: readFileSync(DEPLOY_SSH_KNOWN_HOSTS_PATH, "utf8").trim()
  };
}
