import type { UserRole } from "../store/models.js";
import { requireRole } from "./session.js";

const ALL: UserRole[] = ["boss", "commercial", "finance", "lead", "developer"];
const COMMERCIAL: UserRole[] = ["boss", "commercial", "finance"];
const FINANCE: UserRole[] = ["boss", "finance"];

/**
 * Qué roles entran a cada módulo nuevo (espejo de src/lib/access.ts). Cada módulo usa el acceso del
 * grupo del menú donde vive; el alcance por equipo de los datos sigue en ops/access.ts.
 */
export const MODULE_ACCESS = {
  dashboards: ALL,
  communications: COMMERCIAL,
  myWork: ALL,
  tasks: ALL,
  backlog: ALL,
  invoices: FINANCE,
  payouts: FINANCE,
} as const satisfies Record<string, UserRole[]>;

export type ModuleId = keyof typeof MODULE_ACCESS;

/** preHandler: exige sesión con acceso al módulo. */
export const requireModule = (module: ModuleId) => requireRole(...MODULE_ACCESS[module]);
