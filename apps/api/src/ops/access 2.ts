import type { FastifyReply, FastifyRequest } from "fastify";
import type { Filter } from "mongodb";
import type { SessionUser } from "../auth/users.js";
import type { AdminStore } from "../store/admin-store.js";
import type { OpsProjectDoc } from "./models.js";

/** Roles que ven los proyectos de todos los equipos (los de Comercial y Financiera, solo lectura). */
const READ_ALL = ["boss", "commercial", "finance"] as const;

const sameTeam = (user: SessionUser, project: Pick<OpsProjectDoc, "teamId">) => Boolean(user.teamId && user.teamId === project.teamId);

/** Ver el proyecto y su contenido no sensible. */
export const canReadProject = (user: SessionUser, project: Pick<OpsProjectDoc, "teamId">) =>
  (READ_ALL as readonly string[]).includes(user.role) || ((user.role === "lead" || user.role === "developer") && sameTeam(user, project));

/** Trabajar en el proyecto: tareas, novedades, reuniones y cuentas. CEO/CCO y miembros del equipo. */
export const canWorkOnProject = (user: SessionUser, project: Pick<OpsProjectDoc, "teamId">) =>
  user.role === "boss" || ((user.role === "lead" || user.role === "developer") && sameTeam(user, project));

/** Gestionar el proyecto: datos, etapa, salud, deals y cuentas. CEO/CCO y el Team Leader del equipo. */
export const canManageProject = (user: SessionUser, project: Pick<OpsProjectDoc, "teamId">) =>
  user.role === "boss" || (user.role === "lead" && sameTeam(user, project));

/** Filtro con los proyectos que ve el usuario. Quien ve todo puede acotarlo a un equipo. */
export function projectScope(user: SessionUser, teamFilter?: string | null): Filter<OpsProjectDoc> {
  if ((READ_ALL as readonly string[]).includes(user.role)) return teamFilter ? { teamId: teamFilter } : {};
  return { teamId: user.teamId ?? "__sin_equipo__" };
}

/**
 * Carga el proyecto si el usuario puede verlo. Si no existe o es de otro equipo responde 404
 * (no se confirma que exista) y devuelve null.
 */
export async function readableProject(store: AdminStore, request: FastifyRequest, reply: FastifyReply, id: string) {
  const project = await store.opsProjects.findOne({ _id: id });
  if (!project || !request.user || !canReadProject(request.user, project)) {
    void reply.code(404).send({ error: "Proyecto no encontrado." });
    return null;
  }
  return project;
}

export const forbidden = (reply: FastifyReply) => reply.code(403).send({ error: "No tienes permiso para esta acción." });
