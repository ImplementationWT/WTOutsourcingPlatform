import { timingSafeEqual } from "node:crypto";
import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { verifyPassword } from "./password.js";

export const SESSION_COOKIE = "pp_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface AuthConfig {
  adminUsername: string;
  adminPasswordHash: string;
  sessionSecret: string;
  secureCookies: boolean;
}

export interface SessionUser {
  username: string;
  role: "admin";
}

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

const loginSchema = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(200) });

function sameString(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Sesión del panel: cookie HttpOnly firmada (HMAC) con usuario, rol y
 * expiración. Las credenciales del administrador viven solo en el servidor.
 */
export async function registerAuth(app: FastifyInstance, config: AuthConfig) {
  await app.register(cookie, { secret: config.sessionSecret });

  app.decorateRequest("user", undefined);
  app.addHook("onRequest", async (request) => {
    const raw = request.cookies[SESSION_COOKIE];
    if (!raw) return;
    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return;
    try {
      const session = JSON.parse(Buffer.from(unsigned.value, "base64url").toString("utf8")) as SessionUser & { exp: number };
      if (session.exp > Date.now() && session.role === "admin") request.user = { username: session.username, role: "admin" };
    } catch {
      // cookie manipulada: se ignora
    }
  });

  app.post("/api/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Usuario y contraseña son obligatorios." });

    const { username, password } = parsed.data;
    // Se verifica siempre la contraseña (aunque el usuario no coincida) para no filtrar por tiempos.
    const passwordOk = await verifyPassword(password, config.adminPasswordHash);
    if (!passwordOk || !sameString(username, config.adminUsername)) {
      request.log.warn({ username }, "Failed login");
      return reply.code(401).send({ error: "Usuario o contraseña incorrectos." });
    }

    const value = Buffer.from(
      JSON.stringify({ username, role: "admin", exp: Date.now() + SESSION_TTL_MS })
    ).toString("base64url");
    reply.setCookie(SESSION_COOKIE, value, {
      signed: true,
      httpOnly: true,
      sameSite: "strict",
      secure: config.secureCookies,
      path: "/api",
      maxAge: SESSION_TTL_MS / 1000
    });
    return { user: { username, role: "admin" } };
  });

  app.post("/api/auth/logout", async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/api" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: "No autenticado." });
    return { user: request.user };
  });
}

/** preHandler: exige sesión de administrador. */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user) return reply.code(401).send({ error: "No autenticado." });
  if (request.user.role !== "admin") return reply.code(403).send({ error: "No autorizado." });
}
