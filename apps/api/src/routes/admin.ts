import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireAuth, requireBoss } from "../auth/session.js";
import { UserDirectory, UserDirectoryError } from "../auth/users.js";
import { slugSchema } from "../domain/naming.js";

const roleSchema = z.enum(["boss", "commercial", "finance", "lead", "developer"]);
const idParams = z.object({ id: z.string().uuid() });
const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{1,38}[a-z0-9]$/);
const nameSchema = z.string().trim().min(2).max(80);
const teamIdSchema = z.string().uuid().nullable();
const emailSchema = z.string().trim().toLowerCase().email("Correo inválido.").max(200).nullable();

const createUserSchema = z.object({ username: usernameSchema, name: nameSchema, email: emailSchema.optional(), role: roleSchema, teamId: teamIdSchema.optional() }).strict();
const updateUserSchema = z
  .object({ name: nameSchema.optional(), email: emailSchema.optional(), role: roleSchema.optional(), teamId: teamIdSchema.optional(), active: z.boolean().optional() })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0);
const createTeamSchema = z.object({ name: nameSchema, leadUserId: z.string().uuid().nullable().optional() }).strict();
const updateTeamSchema = z
  .object({ name: nameSchema.optional(), leadUserId: z.string().uuid().nullable().optional() })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0);
const moveSchema = z.object({ teamId: teamIdSchema }).strict();

/**
 * Respuesta con una contraseña temporal: se serializa aquí (la redacción global la ocultaría) y
 * sin caché. Es la única vez que sale; no se registra en logs ni en la auditoría.
 */
function sendOnce(reply: FastifyReply, body: { temporaryPassword: string }) {
  return reply.header("Cache-Control", "no-store").type("application/json; charset=utf-8").send(JSON.stringify(body));
}

/**
 * Administración de usuarios y equipos (solo jefes). Las contraseñas temporales se devuelven una
 * sola vez en la respuesta y nunca se registran.
 */
export async function registerAdminRoutes(app: FastifyInstance, { users }: { users: UserDirectory }) {
  async function run<T>(reply: FastifyReply, fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof UserDirectoryError) return reply.code(error.status).send({ error: error.message });
      throw error;
    }
  }

  /** Equipos visibles para la sesión (selector del jefe y conversión de leads en Comercial; el resto solo ve el suyo). */
  app.get("/api/teams", { preHandler: requireAuth }, async (request) => {
    const user = request.user!;
    const teams = (await users.listTeams()).filter((team) => user.role === "boss" || user.role === "commercial" || team.id === user.teamId);
    return { teams: teams.map(({ id, name }) => ({ id, name })) };
  });

  app.get("/api/admin/users", { preHandler: requireBoss }, async () => ({ users: await users.listUsers() }));

  app.post("/api/admin/users", { preHandler: requireBoss }, async (request, reply) => {
    const body = createUserSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: body.error.issues.some((i) => i.path[0] === "email") ? "Correo inválido." : "Indica usuario (3-40 caracteres: minúsculas, números, punto, guion), nombre y rol."
      });
    }
    return run(reply, async () => sendOnce(reply.code(201), await users.createUser(body.data, request.user!.username)));
  });

  app.patch("/api/admin/users/:id", { preHandler: requireBoss }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = updateUserSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: body.error?.issues.some((i) => i.path[0] === "email") ? "Correo inválido." : "Datos inválidos." });
    return run(reply, async () => ({ user: await users.updateUser(params.data.id, body.data, request.user!) }));
  });

  app.post("/api/admin/users/:id/reset-password", { preHandler: requireBoss }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    return run(reply, async () => sendOnce(reply, await users.resetPassword(params.data.id, request.user!.username)));
  });

  app.get("/api/admin/teams", { preHandler: requireBoss }, async () => ({ teams: await users.listTeams() }));

  app.post("/api/admin/teams", { preHandler: requireBoss }, async (request, reply) => {
    const body = createTeamSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Indica el nombre del equipo (2-80 caracteres)." });
    return run(reply, async () => reply.code(201).send({ team: await users.createTeam(body.data, request.user!.username) }));
  });

  app.patch("/api/admin/teams/:id", { preHandler: requireBoss }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = updateTeamSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Datos inválidos." });
    return run(reply, async () => {
      await users.updateTeam(params.data.id, body.data, request.user!.username);
      return { ok: true };
    });
  });

  /** Mueve un proyecto a otro equipo (o lo deja sin equipo: solo lo verán los jefes). */
  app.post("/api/admin/clients/:slug/team", { preHandler: requireBoss }, async (request, reply) => {
    const params = z.object({ slug: slugSchema }).safeParse(request.params);
    const body = moveSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Datos inválidos." });
    return run(reply, async () => {
      await users.moveClient(params.data.slug, body.data.teamId, request.user!.username);
      return { ok: true };
    });
  });
}
