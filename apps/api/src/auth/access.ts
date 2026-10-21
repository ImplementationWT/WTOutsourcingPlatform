import type { FastifyReply, FastifyRequest } from "fastify";
import type { Filter } from "mongodb";
import type { AdminStore } from "../store/admin-store.js";
import type { ClientDoc } from "../store/models.js";
import type { SessionUser } from "./users.js";

/**
 * Aislamiento entre equipos: un proyecto pertenece a un equipo y solo lo ven sus miembros. Los
 * jefes ven todos (incluidos los que aún no tienen equipo, anteriores a los equipos).
 */
export function canSeeClient(user: SessionUser, client: Pick<ClientDoc, "teamId">) {
  if (user.role === "boss") return true;
  return Boolean(user.teamId && client.teamId === user.teamId);
}

/**
 * Filtro de MongoDB con los proyectos que ve el usuario. Un jefe puede acotarlo a un equipo
 * (selector de equipo del panel); el resto, siempre al suyo.
 */
export function clientScope(user: SessionUser, teamFilter?: string | null): Filter<ClientDoc> {
  if (user.role === "boss") return teamFilter ? { teamId: teamFilter } : {};
  return { teamId: user.teamId ?? "__sin_equipo__" };
}

/** Equipo pedido por un jefe en ?teamId= (los demás no pueden elegir). */
export function teamFilterOf(request: FastifyRequest) {
  const value = (request.query as { teamId?: unknown } | null)?.teamId;
  return request.user?.role === "boss" && typeof value === "string" && /^[0-9a-f-]{36}$/.test(value) ? value : null;
}

/**
 * Carga el proyecto si el usuario puede verlo. Si no existe o es de otro equipo responde 404
 * (no se confirma que exista) y devuelve null.
 */
export async function accessibleClient(store: AdminStore, request: FastifyRequest, reply: FastifyReply, slug: string) {
  const client = await store.getClient(slug);
  if (!client || !request.user || !canSeeClient(request.user, client)) {
    void reply.code(404).send({ error: "Proyecto no encontrado." });
    return null;
  }
  return client;
}
