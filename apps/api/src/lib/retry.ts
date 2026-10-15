import { TransientError } from "./errors.js";

export interface BackoffOptions {
  /** Intentos totales (incluido el primero). */
  attempts: number;
  baseMs: number;
  maxMs: number;
  /** Inyectable en tests para no esperar de verdad. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Backoff exponencial con "full jitter": espera aleatoria en [0, min(max, base·2^n)]. */
export function backoffDelay(attempt: number, { baseMs, maxMs, random = Math.random }: BackoffOptions) {
  const cap = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(random() * cap);
}

/**
 * Reintenta `fn` solo ante TransientError. Cualquier otro error se propaga de
 * inmediato. `onRetry` permite registrar el reintento.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: BackoffOptions,
  onRetry?: (error: TransientError, attempt: number, delayMs: number) => void
): Promise<T> {
  const wait = options.sleep ?? sleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (!(error instanceof TransientError) || attempt >= options.attempts - 1) throw error;
      const delay = backoffDelay(attempt, options);
      onRetry?.(error, attempt + 1, delay);
      await wait(delay);
    }
  }
}

/**
 * Consulta `check` hasta que devuelva un valor distinto de undefined o se
 * agote `timeoutMs`. Los TransientError dentro de `check` cuentan como "aún no".
 * Con `maxIntervalMs`, la espera entre consultas crece ×1.5 hasta ese tope.
 */
export async function pollUntil<T>(
  check: () => Promise<T | undefined>,
  {
    timeoutMs,
    intervalMs,
    maxIntervalMs = intervalMs,
    sleep: wait = sleep,
    now = Date.now
  }: { timeoutMs: number; intervalMs: number; maxIntervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number }
): Promise<T | undefined> {
  const deadline = now() + timeoutMs;
  let lastTransient: TransientError | undefined;
  let interval = intervalMs;
  for (;;) {
    try {
      const value = await check();
      if (value !== undefined) return value;
    } catch (error) {
      if (!(error instanceof TransientError)) throw error;
      lastTransient = error;
    }
    if (now() >= deadline) {
      if (lastTransient) throw lastTransient;
      return undefined;
    }
    await wait(interval);
    interval = Math.min(maxIntervalMs, Math.round(interval * 1.5));
  }
}
