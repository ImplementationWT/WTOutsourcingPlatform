import { randomUUID, timingSafeEqual } from "node:crypto";
import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { UserRole } from "../store/models.js";
import { createLoginGuard, type LoginGuard } from "./login-guard.js";
import { verifyPassword } from "./password.js";
import { type SessionUser, toSessionUser, UserDirectory, UserDirectoryError } from "./users.js";

export const SESSION_COOKIE = "pp_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface AuthConfig {
  /** Cuenta admin de la configuración: se migra a un usuario jefe en el primer arranque. */
  adminUsername: string;
  adminPasswordHash: string;
  sessionSecret: string;
  secureCookies: boolean;
  /** Límite de intentos fallidos (inyectable para tests). */
  loginGuard?: LoginGuard;
}

export type { SessionUser };

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

const loginSchema = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(200) });
const passwordSchema = z.object({ current: z.string().min(1).max(200), next: z.string().min(1).max(200) }).strict();

function sameString(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Rutas que se pueden usar con la contraseña pendiente de cambiar (y por los jefes aunque escriban). */
const AUTH_PATHS = ["/api/auth/"];
/** Escrituras permitidas a los jefes: administración de usuarios, equipos y proyectos. */
const BOSS_WRITE_PATHS = ["/api/auth/", "/api/admin/"];
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Sesión del panel: cookie HttpOnly firmada (HMAC) con userId, username, rol, equipo y
 * expiración. En cada petición el usuario se relee de la base: desactivarlo o cambiarle el rol o
 * el equipo tiene efecto inmediato, sin esperar a que caduque la cookie.
 *
 * Mientras no exista ningún usuario (antes de la migración) se acepta la cuenta admin de la
 * configuración como jefe.
 */
export async function registerAuth(app: FastifyInstance, config: AuthConfig, users: UserDirectory) {
  await app.register(cookie, { secret: config.sessionSecret });
  const guard = config.loginGuard ?? createLoginGuard();
  const configAdmin: SessionUser = {
    id: "config-admin",
    username: config.adminUsername.toLowerCase(),
    name: config.adminUsername,
    role: "boss",
    teamId: null,
    mustChangeCredentials: false
  };

  app.decorateRequest("user", undefined);
  app.addHook("onRequest", async (request, reply) => {
    const raw = request.cookies[SESSION_COOKIE];
    if (raw) {
      const unsigned = request.unsignCookie(raw);
      if (unsigned.valid && unsigned.value) {
        try {
          const session = JSON.parse(Buffer.from(unsigned.value, "base64url").toString("utf8")) as { uid?: string; exp?: number };
          if (session.uid && session.exp && session.exp > Date.now()) {
            if (session.uid === configAdmin.id) {
              if (!(await users.hasUsers())) request.user = configAdmin;
            } else {
              const user = await users.findById(session.uid);
              if (user?.active) request.user = toSessionUser(user);
            }
          }
        } catch {
          // cookie manipulada: se ignora
        }
      }
    }

    const user = request.user;
    const path = request.url.split("?")[0];
    if (!user || !path.startsWith("/api/")) return;
    // Primer ingreso o restablecimiento: hasta cambiar la contraseña solo puede tocar /api/auth.
    if (user.mustChangeCredentials && !AUTH_PATHS.some((p) => path.startsWith(p))) {
      return reply.code(403).send({ error: "Cambia tu contraseña para continuar.", code: "password_change_required" });
    }
    // Jefes: solo lectura (excepto la administración de usuarios, equipos y proyectos).
    if (user.role === "boss" && !READ_METHODS.has(request.method) && !BOSS_WRITE_PATHS.some((p) => path.startsWith(p))) {
      return reply.code(403).send({ error: "Los jefes tienen acceso de solo lectura." });
    }
  });

  function setSession(reply: FastifyReply, user: SessionUser) {
    const value = Buffer.from(
      JSON.stringify({ uid: user.id, username: user.username, role: user.role, teamId: user.teamId, exp: Date.now() + SESSION_TTL_MS, n: randomUUID() })
    ).toString("base64url");
    reply.setCookie(SESSION_COOKIE, value, {
      signed: true,
      httpOnly: true,
      sameSite: "strict",
      secure: config.secureCookies,
      path: "/api",
      maxAge: SESSION_TTL_MS / 1000
    });
  }

  app.post("/api/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Usuario y contraseña son obligatorios." });

    const { username, password } = parsed.data;
    // request.ip es la IP real del navegador (trustProxy solo confía en el nginx local).
    const ip = request.ip;
    const wait = guard.retryAfterMs(ip, username);
    if (wait > 0) {
      const minutes = Math.ceil(wait / 60_000);
      return reply
        .code(429)
        .header("retry-after", String(Math.ceil(wait / 1000)))
        .send({ error: `Demasiados intentos fallidos. Vuelve a intentarlo en ${minutes} minuto${minutes === 1 ? "" : "s"}.` });
    }

    let user: SessionUser | null = null;
    if (await users.hasUsers()) {
      const result = await users.authenticate(username, password);
      if ("user" in result) user = toSessionUser(result.user);
      else if (result.error === "locked") {
        guard.fail(ip, username);
        request.log.warn({ username, ip }, "Login on locked account");
        return reply.code(429).send({ error: "Cuenta bloqueada temporalmente por intentos fallidos. Inténtalo más tarde o pide a un jefe que restablezca tu contraseña." });
      }
    } else {
      // Compatibilidad antes de la migración: la cuenta de la configuración.
      const passwordOk = await verifyPassword(password, config.adminPasswordHash);
      if (passwordOk && sameString(username.toLowerCase(), configAdmin.username)) user = configAdmin;
    }

    if (!user) {
      const blocked = guard.fail(ip, username);
      request.log.warn({ username, ip, blocked }, blocked ? "Login blocked after repeated failures" : "Failed login");
      return reply.code(401).send({ error: "Usuario o contraseña incorrectos." });
    }
    guard.succeed(ip, username);
    setSession(reply, user);
    return { user };
  });

  app.post("/api/auth/logout", async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/api" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: "No autenticado." });
    return { user: request.user };
  });

  /** Cambio de contraseña propio (obligatorio en el primer ingreso). */
  app.post("/api/auth/password", async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: "No autenticado." });
    const body = passwordSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Indica la contraseña actual y la nueva." });
    if (request.user.id === configAdmin.id) return reply.code(409).send({ error: "Esta cuenta viene de la configuración: no se cambia desde aquí." });
    try {
      await users.changeOwnPassword(request.user.id, body.data.current, body.data.next);
    } catch (error) {
      if (error instanceof UserDirectoryError) return reply.code(error.status).send({ error: error.message });
      throw error;
    }
    const updated = { ...request.user, mustChangeCredentials: false };
    setSession(reply, updated);
    return { user: updated };
  });
}

/** preHandler: exige una sesión. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user) return reply.code(401).send({ error: "No autenticado." });
}

/** preHandler: exige sesión con uno de esos roles. */
export function requireRole(...roles: UserRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) return reply.code(401).send({ error: "No autenticado." });
    if (!roles.includes(request.user.role)) return reply.code(403).send({ error: "No tienes permiso para esta acción." });
  };
}

/** Team leaders y developers: los que operan proyectos (crear, desplegar, AI Developer…). */
export const requireOperator = requireRole("lead", "developer");
/** Solo jefes: administración de usuarios, equipos y proyectos. */
export const requireBoss = requireRole("boss");
