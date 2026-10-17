import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Pases de acceso a las vistas previas. nginx solo deja pasar a la app de la
 * vista previa si Launchpad valida la cookie `lp_preview` de ese host:
 *
 * 1. El panel (con sesión de admin) recibe una URL `/__launchpad/auth?t=<pase>`
 *    con un pase firmado de un solo uso, válido 2 minutos y atado al host.
 * 2. nginx reenvía esa URL a Launchpad, que canjea el pase por una cookie
 *    firmada para ese host (8 h) y redirige a la app.
 * 3. Cada petición posterior pasa por auth_request → Launchpad valida la cookie.
 */
export const PREVIEW_COOKIE = "lp_preview";
const PASS_TTL_MS = 2 * 60_000;
const COOKIE_TTL_MS = 8 * 3_600_000;

interface Claims {
  /** Host de la vista previa. */
  h: string;
  /** Sesión del AI Developer. */
  s: string;
  /** Caducidad (ms epoch). */
  e: number;
  /** Tipo: pase de URL o cookie (un tipo no sirve como el otro). */
  k: "pass" | "cookie";
  /** Nonce del pase (un solo uso). */
  n?: string;
}

export class PreviewPasses {
  private readonly key: Buffer;
  private readonly usedNonces = new Map<string, number>();

  constructor(
    secret: string,
    private readonly now: () => number = Date.now
  ) {
    // Clave propia derivada del secreto de sesión: una cookie del panel no sirve aquí.
    this.key = Buffer.from(hkdfSync("sha256", secret, "launchpad", "preview-pass", 32));
  }

  private sign(claims: Claims) {
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${body}.${createHmac("sha256", this.key).update(body).digest("base64url")}`;
  }

  private verify(value: string | undefined, kind: Claims["k"], host: string): Claims | null {
    if (!value || value.length > 2_000) return null;
    const [body, signature] = value.split(".");
    if (!body || !signature) return null;
    const expected = createHmac("sha256", this.key).update(body).digest();
    const given = Buffer.from(signature, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Claims;
      if (claims.k !== kind || claims.h !== host || typeof claims.e !== "number" || claims.e <= this.now()) return null;
      return claims;
    } catch {
      return null;
    }
  }

  /** Pase de un solo uso para la URL del iframe. */
  issuePass(host: string, sessionId: string) {
    return this.sign({ h: host, s: sessionId, e: this.now() + PASS_TTL_MS, k: "pass", n: randomBytes(12).toString("base64url") });
  }

  /** Canjea un pase por el valor de la cookie; null si no vale o ya se usó. */
  redeem(pass: string | undefined, host: string) {
    const claims = this.verify(pass, "pass", host);
    if (!claims?.n) return null;
    const t = this.now();
    for (const [nonce, expires] of this.usedNonces) if (expires <= t) this.usedNonces.delete(nonce);
    if (this.usedNonces.has(claims.n)) return null;
    this.usedNonces.set(claims.n, claims.e);
    return { sessionId: claims.s, cookie: this.sign({ h: host, s: claims.s, e: t + COOKIE_TTL_MS, k: "cookie" }), maxAgeSeconds: COOKIE_TTL_MS / 1000 };
  }

  /** Sesión a la que da acceso la cookie para ese host, o null. */
  check(cookie: string | undefined, host: string) {
    return this.verify(cookie, "cookie", host)?.s ?? null;
  }
}
