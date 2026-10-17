/**
 * Redacción de secretos en todo lo que sale del proceso: logs, errores,
 * eventos del trabajo y respuestas de la API.
 *
 * Dos capas:
 * 1. Por patrón: URIs de MongoDB con credenciales, tokens de GitHub, Bearer,
 *    claves privadas PEM/OpenSSH.
 * 2. Por valor: cada secreto generado o leído en runtime (contraseñas de
 *    Atlas, client secret, etc.) se registra con `registerSecret` y cualquier
 *    aparición literal se reemplaza, aunque no siga ningún patrón.
 */
export const REDACTED = "[REDACTED]";

const knownSecrets = new Set<string>();

/** Registra un valor secreto para que nunca salga del proceso. */
export function registerSecret(value: string | undefined | null) {
  if (value && value.length >= 6) knownSecrets.add(value);
}

/** Solo para tests. */
export function clearRegisteredSecrets() {
  knownSecrets.clear();
}

const PATTERNS: [RegExp, string][] = [
  // mongodb://user:pass@host o mongodb+srv://...  → se oculta todo lo que va tras el esquema.
  [/mongodb(\+srv)?:\/\/[^\s"'`<>]+/gi, `mongodb$1://${REDACTED}`],
  // Tokens de GitHub (instalación, PAT clásicos y fine-grained, OAuth, refresh).
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, REDACTED],
  // Claves de la API de Anthropic.
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, REDACTED],
  // Cabeceras Authorization.
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // Claves privadas.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  // JWT sueltos (p. ej. access tokens de Atlas).
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, REDACTED]
];

/** Claves de objeto cuyo valor se oculta siempre, sea cual sea. */
const SENSITIVE_KEY =
  /pass(word)?|secret|token|authorization|cookie|private.?key|known.?hosts|^uri$|mongodb_?uri|connection.?string|encrypted.?value|client.?secret/i;

export function redactString(input: string): string {
  let out = input;
  for (const secret of knownSecrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** Copia profunda redactada. Soporta Error, arrays, objetos planos y ciclos. */
export function redact<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (typeof value === "string") return redactString(value) as T;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value) as T;

  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: redactString(value.message)
    };
    seen.set(value, out);
    if (value.stack) out.stack = redactString(value.stack);
    for (const [key, v] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(v, seen);
    }
    if (value.cause !== undefined) out.cause = redact(value.cause, seen);
    return out as T;
  }

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(redact(item, seen));
    return out as T;
  }

  if (value instanceof Date) return value;

  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [key, v] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) && v !== undefined && v !== null ? REDACTED : redact(v, seen);
  }
  return out as T;
}
