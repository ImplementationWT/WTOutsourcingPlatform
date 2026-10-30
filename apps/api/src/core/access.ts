import type { Filter } from "mongodb";
import type { SessionUser } from "../auth/users.js";
import type { DealDoc, DealStatus } from "../ops/models.js";
import type { UserRole } from "../store/models.js";

// Permisos de la sección 6 de docs/rework-plataforma.md.

/** Contactos y Empresas: CEO/CCO y Comercial todo; Financiera solo lectura; equipos sin acceso. */
export const canReadContacts = (user: SessionUser) => (["boss", "commercial", "finance"] as UserRole[]).includes(user.role);
export const canWriteContacts = (user: SessionUser) => user.role === "boss" || user.role === "commercial";

/** Comercial crea y edita deals solo hasta "propuesto". */
export const COMMERCIAL_DEAL_STATUSES: readonly DealStatus[] = ["draft", "proposed"];

const sameTeam = (user: SessionUser, deal: Pick<DealDoc, "teamId">) => Boolean(user.teamId && deal.teamId === user.teamId);

/** Deals visibles: CEO/CCO, Comercial y Financiera todos; Team Leader y Developer los de su equipo. */
export function dealScope(user: SessionUser): Filter<DealDoc> {
  if (user.role === "boss" || user.role === "commercial" || user.role === "finance") return {};
  return { teamId: user.teamId ?? "__sin_equipo__" };
}

export const canReadDeal = (user: SessionUser, deal: Pick<DealDoc, "teamId">) =>
  user.role === "boss" || user.role === "commercial" || user.role === "finance" || ((user.role === "lead" || user.role === "developer") && sameTeam(user, deal));

/** Editar: CEO/CCO; Team Leader de su equipo; Comercial mientras el deal no pase de "propuesto". */
export function canEditDeal(user: SessionUser, deal: Pick<DealDoc, "teamId" | "status">) {
  if (user.role === "boss") return true;
  if (user.role === "lead") return sameTeam(user, deal);
  if (user.role === "commercial") return COMMERCIAL_DEAL_STATUSES.includes(deal.status);
  return false;
}

/** Crear: CEO/CCO, Comercial y Team Leader (este último, en proyectos de su equipo). */
export const canCreateDeal = (user: SessionUser) => user.role === "boss" || user.role === "commercial" || user.role === "lead";
