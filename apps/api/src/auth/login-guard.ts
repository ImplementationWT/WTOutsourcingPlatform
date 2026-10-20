/**
 * Freno a los intentos de contraseña del panel. Cuenta solo los fallos, en una ventana
 * fija por clave:
 * - por IP: pocos fallos seguidos bloquean esa IP durante la ventana;
 * - por usuario: un tope más alto frena un ataque repartido entre muchas IPs, sin que
 *   una sola IP pueda bloquear la cuenta para todos.
 * Mientras hay bloqueo, la contraseña ni se comprueba: probar no sirve aunque acierte.
 * En memoria (una sola instancia de la API): un reinicio pone los contadores a cero.
 */
export interface LoginGuardOptions {
  windowMs?: number;
  maxPerIp?: number;
  maxPerUser?: number;
  now?: () => number;
}

export function createLoginGuard({ windowMs = 15 * 60_000, maxPerIp = 10, maxPerUser = 30, now = Date.now }: LoginGuardOptions = {}) {
  const failures = new Map<string, { count: number; resetAt: number }>();
  const keys = (ip: string, username: string) => [
    { key: `ip:${ip}`, max: maxPerIp },
    // El usuario en minúsculas y recortado: variantes del mismo nombre cuentan juntas.
    { key: `user:${username.trim().toLowerCase().slice(0, 100)}`, max: maxPerUser }
  ];

  function current(key: string, t: number) {
    const entry = failures.get(key);
    if (entry && entry.resetAt <= t) {
      failures.delete(key);
      return undefined;
    }
    return entry;
  }

  return {
    /** Milisegundos que faltan para poder intentarlo de nuevo (0: se puede). */
    retryAfterMs(ip: string, username: string) {
      const t = now();
      let wait = 0;
      for (const { key, max } of keys(ip, username)) {
        const entry = current(key, t);
        if (entry && entry.count >= max) wait = Math.max(wait, entry.resetAt - t);
      }
      return wait;
    },

    /** Registra un fallo; devuelve true si con él queda bloqueado. */
    fail(ip: string, username: string) {
      const t = now();
      let blocked = false;
      for (const { key, max } of keys(ip, username)) {
        const entry = current(key, t) ?? { count: 0, resetAt: t + windowMs };
        entry.count++;
        failures.set(key, entry);
        if (entry.count >= max) blocked = true;
      }
      // Limpieza de ventanas vencidas para que el mapa no crezca sin fin.
      if (failures.size > 10_000) for (const [k, e] of failures) if (e.resetAt <= t) failures.delete(k);
      return blocked;
    },

    /** Un acierto borra los fallos de esa IP y de ese usuario. */
    succeed(ip: string, username: string) {
      for (const { key } of keys(ip, username)) failures.delete(key);
    }
  };
}

export type LoginGuard = ReturnType<typeof createLoginGuard>;
