/**
 * Clasificación de errores del aprovisionamiento.
 *
 * - TransientError: timeouts, 429, 5xx, red. La etapa se reintenta con backoff
 *   (y antes de reintentar vuelve a consultar el estado real).
 * - FatalError: credenciales inválidas, permisos insuficientes, conflictos de
 *   propiedad. Detienen el trabajo con un mensaje claro y accionable.
 *
 * Los mensajes de ambos se muestran en el panel: nunca deben contener valores
 * secretos (se redactan igualmente antes de salir del proceso).
 */
export class ProvisioningError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class TransientError extends ProvisioningError {}

export class FatalError extends ProvisioningError {}

/** El recurso existe pero no pertenece a este cliente: nunca se reutiliza. */
export class OwnershipError extends FatalError {
  constructor(message: string) {
    super("ownership_conflict", message);
  }
}

const NETWORK_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE"
]);

/** true si en la cadena de `cause` hay un error de red o un timeout. */
export function isNetworkError(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && typeof e === "object" && depth < 8; depth++) {
    const { code, name } = e as { code?: unknown; name?: unknown };
    if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
    if (name === "TimeoutError" || name === "AbortError") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export function isTransientStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}
