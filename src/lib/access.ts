import type { UserRole } from "@/features/auth/auth";

const ALL: readonly UserRole[] = ["boss", "commercial", "finance", "lead", "developer"];
const COMMERCIAL: readonly UserRole[] = ["boss", "commercial", "finance"];
const FINANCE: readonly UserRole[] = ["boss", "finance"];
const INFRA: readonly UserRole[] = ["boss", "lead", "developer"];

/**
 * Único punto que dice qué roles entran a cada pantalla (menú, buscador y rutas). Cada módulo usa
 * el acceso del grupo del menú donde vive; las reglas finas por pantalla se agregarán aquí.
 * El espejo del backend está en apps/api/src/auth/modules.ts.
 */
export const MODULE_ACCESS = {
  // Dashboards
  dashboards: ALL,
  // Comercial
  contacts: COMMERCIAL,
  leads: COMMERCIAL,
  proposals: COMMERCIAL,
  meetings: ALL,
  communications: COMMERCIAL,
  activities: COMMERCIAL,
  demos: COMMERCIAL,
  // Operativa
  myWork: ALL,
  projects: ALL,
  tasks: ALL,
  backlog: ALL,
  // Financiera
  invoices: FINANCE,
  payouts: FINANCE,
  // Infraestructura (zona protegida: mismo acceso que antes)
  infraDashboard: INFRA,
  apps: INFRA,
  integrations: INFRA,
} as const satisfies Record<string, readonly UserRole[]>;

export type ModuleId = keyof typeof MODULE_ACCESS;

export const canAccess = (role: UserRole | undefined, module: ModuleId) => Boolean(role && (MODULE_ACCESS[module] as readonly UserRole[]).includes(role));
