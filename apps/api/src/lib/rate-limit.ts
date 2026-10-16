/** Límite de peticiones por clave en una ventana fija (en memoria: una sola instancia). */
export function createRateLimiter({ limit, windowMs, now = Date.now }: { limit: number; windowMs: number; now?: () => number }) {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    /** true si la petición entra; false si supera el límite. */
    take(key: string) {
      const t = now();
      const current = windows.get(key);
      if (!current || current.resetAt <= t) {
        windows.set(key, { count: 1, resetAt: t + windowMs });
        if (windows.size > 10_000) for (const [k, w] of windows) if (w.resetAt <= t) windows.delete(k);
        return true;
      }
      current.count++;
      return current.count <= limit;
    }
  };
}
