import "dotenv/config";
import { readFileSync } from "node:fs";
import { z } from "zod";

const hostname = z
  .string()
  .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i, "debe ser un hostname sin esquema ni ruta");

const hostOrIp = z
  .string()
  .regex(
    /^((?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}|(\d{1,3}\.){3}\d{1,3})$/i,
    "debe ser un hostname o una IPv4, sin usuario, puerto ni esquema"
  );

const ipv4 = z.string().regex(/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/, "debe ser una IPv4");

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

  // Dominio de las apps de clientes: https://<slug>.<APP_BASE_DOMAIN> (APPS_DOMAIN: nombre anterior).
  APP_BASE_DOMAIN: optional(hostname),
  APPS_DOMAIN: optional(hostname),

  // Despliegue en el VPS + health check. Mientras sea false, el trabajo termina
  // tras crear el repo, la base y los secrets.
  DEPLOY_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  // VPS compartido (contrato §3 y §5). Obligatorias solo con DEPLOY_ENABLED=true.
  // DEPLOY_HOST: host del VPS, el mismo que se escribe en la variable DEPLOY_HOST de cada repo.
  DEPLOY_HOST: optional(hostOrIp),
  // Puerto SSH del orquestador (usuario provisioner). Los workflows usan siempre el 22 (contrato §5).
  DEPLOY_SSH_PORT: optional(z.coerce.number().int().min(1).max(65535)).default(22),
  // Línea(s) known_hosts del VPS ("<host> ssh-ed25519 AAAA…"): huella fijada y DEPLOY_KNOWN_HOSTS de los repos.
  DEPLOY_HOST_KEY: optional(z.string().min(1)),
  // Ruta al archivo con la clave privada del usuario provisioner (no el contenido).
  PROVISIONER_SSH_KEY_SECRET_REF: optional(z.string().min(1)),
  // Owner de GHCR en minúsculas (lo valida deploy-client; aquí, para mostrar el digest).
  GHCR_ORG: optional(z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "debe ir en minúsculas, p. ej. implementationwt")),
  // IP pública del VPS: <slug>.<APP_BASE_DOMAIN> debe resolver a ella (etapa dns_https).
  VPS_PUBLIC_IP: optional(ipv4),
  // Solo para pruebas con la CA de staging: el health check acepta su certificado (no es de confianza).
  ACME_CA: optional(z.string().regex(/^https:\/\/\S+$/, "debe ser una URL https")),

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
  const problems: string[] = [];
  if (parsed.data.INITIAL_ADMIN_MODE === "random" && !parsed.data.INITIAL_PASSWORD_KEY_PATH) {
    problems.push("INITIAL_PASSWORD_KEY_PATH: obligatoria con INITIAL_ADMIN_MODE=random");
  }
  if (!parsed.data.APP_BASE_DOMAIN && !parsed.data.APPS_DOMAIN) problems.push("APP_BASE_DOMAIN: obligatoria");
  if (parsed.data.DEPLOY_ENABLED) {
    for (const key of ["DEPLOY_HOST", "DEPLOY_HOST_KEY", "PROVISIONER_SSH_KEY_SECRET_REF", "GHCR_ORG", "VPS_PUBLIC_IP"] as const) {
      if (!parsed.data[key]) problems.push(`${key}: obligatoria con DEPLOY_ENABLED=true`);
    }
  }
  if (problems.length) throw new Error(`Configuración inválida:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  return parsed.data;
}

/** Dominio de las apps (APP_BASE_DOMAIN, o APPS_DOMAIN de configuraciones anteriores). */
export function appBaseDomain(env: Env) {
  return (env.APP_BASE_DOMAIN ?? env.APPS_DOMAIN)!;
}

const HOST_KEY_TYPES = new Set(["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "ssh-rsa"]);

/**
 * Líneas known_hosts → claves aceptadas del servidor. Admite "<host> <tipo> <base64>"
 * o "<tipo> <base64>"; devuelve también las líneas normalizadas con el host.
 */
export function parseHostKeys(raw: string, host: string) {
  const keys: { type: string; key: Buffer; line: string }[] = [];
  for (const entry of raw.split(/\r?\n|\\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))) {
    const parts = entry.split(/\s+/);
    const [type, b64] = HOST_KEY_TYPES.has(parts[0]) ? parts : parts.slice(1);
    const key = b64 && /^[A-Za-z0-9+/]+=*$/.test(b64) ? Buffer.from(b64, "base64") : undefined;
    // El blob de una clave SSH empieza con su propio tipo (longitud + nombre).
    if (!type || !HOST_KEY_TYPES.has(type) || !key || key.subarray(4, 4 + type.length).toString() !== type) {
      throw new Error("Configuración inválida:\n  - DEPLOY_HOST_KEY: debe tener formato known_hosts (p. ej. salida de ssh-keyscan -t ed25519 <host>)");
    }
    keys.push({ type, key, line: `${host} ${type} ${b64}` });
  }
  if (!keys.length) throw new Error("Configuración inválida:\n  - DEPLOY_HOST_KEY: no contiene ninguna clave");
  return keys;
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

export function loadServerConfig(env: Env) {
  if (!env.DEPLOY_HOST || !env.DEPLOY_HOST_KEY || !env.PROVISIONER_SSH_KEY_SECRET_REF || !env.GHCR_ORG || !env.VPS_PUBLIC_IP) {
    return undefined;
  }
  const hostKeys = parseHostKeys(env.DEPLOY_HOST_KEY, env.DEPLOY_HOST);
  return {
    host: env.DEPLOY_HOST,
    port: env.DEPLOY_SSH_PORT,
    hostKeys: hostKeys.map(({ type, key }) => ({ type, key })),
    knownHosts: hostKeys.map((k) => k.line).join("\n"),
    provisionerKey: readFileSync(env.PROVISIONER_SSH_KEY_SECRET_REF, "utf8"),
    ghcrOrg: env.GHCR_ORG,
    publicIp: env.VPS_PUBLIC_IP,
    acmeCa: env.ACME_CA
  };
}

export type ServerConfig = NonNullable<ReturnType<typeof loadServerConfig>>;
