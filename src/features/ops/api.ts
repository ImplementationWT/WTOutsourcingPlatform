import { useQuery } from "@tanstack/react-query";
import type { Tone } from "@/components/ui/tones";
import { apiFetch } from "@/lib/api-client";
import { useSession } from "@/features/auth/auth";
import { useTablePage } from "@/components/data-table/use-table-page";
import { formatMoney } from "@/lib/format";

// ---- catálogos (los mismos valores que valida la API) ---------------------------------

export const STAGES = ["kickoff", "structure", "automation_layer", "stabilization", "maintenance", "no_pending_items", "completed"] as const;
export const HEALTH = ["champion", "very_happy", "happy", "mixed", "neutral", "concerned", "escalated", "at_risk"] as const;
export const PRIORITIES = ["critical", "high", "medium", "low"] as const;
export const DEAL_STATUSES = ["draft", "proposed", "approved", "in_progress", "delivered", "invoiced", "paid", "cancelled"] as const;
export const TASK_STATUSES = ["todo", "in_progress", "review", "done"] as const;
export const ACCOUNT_KINDS = ["web", "email", "api", "database", "server", "social", "other"] as const;
export const PAYMENT_TYPES = ["upwork", "stripe", "direct_pe", "direct_us", "paypal", "revolut"] as const;
export const NEXT_ACTIONS = ["contact", "follow_up", "prepare_proposal", "internal_review", "none"] as const;

export type Stage = (typeof STAGES)[number];
export type Health = (typeof HEALTH)[number];
export type Priority = (typeof PRIORITIES)[number];
export type DealStatus = (typeof DEAL_STATUSES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type AccountKind = (typeof ACCOUNT_KINDS)[number];
export type PaymentType = (typeof PAYMENT_TYPES)[number];
export type NextAction = (typeof NEXT_ACTIONS)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  kickoff: "Kick Off",
  structure: "Estructura",
  automation_layer: "Automation Layer",
  stabilization: "Estabilización",
  maintenance: "Maintenance",
  no_pending_items: "No Pending Items",
  completed: "Completed",
};
export const HEALTH_LABELS: Record<Health, string> = {
  champion: "Champion",
  very_happy: "Very Happy",
  happy: "Happy",
  mixed: "Mixed",
  neutral: "Neutral",
  concerned: "Concerned",
  escalated: "Escalated",
  at_risk: "At Risk",
};
export const PRIORITY_LABELS: Record<Priority, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
export const DEAL_STATUS_LABELS: Record<DealStatus, string> = {
  draft: "Borrador",
  proposed: "Propuesto",
  approved: "Aprobado",
  in_progress: "En curso",
  delivered: "Entregado",
  invoiced: "Facturado",
  paid: "Cobrado",
  cancelled: "Cancelado",
};
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = { todo: "Por hacer", in_progress: "En curso", review: "En revisión", done: "Hecha" };
export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  web: "Web / panel",
  email: "Correo",
  api: "API",
  database: "Base de datos",
  server: "Servidor",
  social: "Red social",
  other: "Otra",
};

export const PAYMENT_TYPE_LABELS: Record<PaymentType, string> = {
  upwork: "Upwork",
  stripe: "Stripe",
  direct_pe: "Directo Perú",
  direct_us: "Directo USA",
  paypal: "PayPal",
  revolut: "Revolut",
};
export const NEXT_ACTION_LABELS: Record<NextAction, string> = {
  contact: "Contactar",
  follow_up: "Follow-up",
  prepare_proposal: "Preparar propuesta",
  internal_review: "Revisión interna",
  none: "Ninguna",
};

/** Sentiment derivado del Health (§3): el mismo cálculo que hace el servidor. */
export const SENTIMENT_BY_HEALTH: Record<Health, number> = {
  champion: 100,
  very_happy: 90,
  happy: 80,
  mixed: 65,
  neutral: 55,
  concerned: 40,
  at_risk: 20,
  escalated: 10,
};

/** Tono por health: los buenos en verde, los neutros en gris, los de riesgo en ámbar y rojo. */
export const HEALTH_TONE: Record<Health, Tone> = {
  champion: "ok",
  very_happy: "ok",
  happy: "ok",
  mixed: "warn",
  neutral: "neutral",
  concerned: "warn",
  escalated: "danger",
  at_risk: "danger",
};
export const PRIORITY_TONE: Record<Priority, Tone> = { critical: "danger", high: "warn", medium: "info", low: "neutral" };

// ---- tipos de la API -------------------------------------------------------------

type Ref = { id: string; name: string | null };

export interface OpsProject {
  id: string;
  name: string;
  customerName: string;
  team: Ref;
  lead: Ref | null;
  developer: Ref | null;
  contacts: Ref[];
  /** El cliente es el contacto del proyecto (con su empresa); `customerName` sale de él. */
  client: { id: string; name: string | null; company: string | null } | null;
  clientSlug: string | null;
  sowUrl: string | null;
  kickoffDate: string | null;
  leadId: string | null;
  stage: Stage;
  health: Health;
  /** (calc) del Health. */
  sentimentScore: number;
  priority: Priority;
  paymentType: PaymentType | null;
  nextAction: NextAction | null;
  /** Campos calculados en el servidor. */
  summary: { deals: number; amountCents: number; soldHours: number; billableHours: number; billableVsSold: number; tasks: number; tasksDone: number; progress: number };
  createdAt: string;
  updatedAt: string;
}

/** Cliente del proyecto: su contacto con la empresa al lado (o el nombre guardado, en proyectos viejos). */
export const clientLabel = (p: Pick<OpsProject, "client" | "customerName">) =>
  p.client?.name ? [p.client.name, p.client.company].filter(Boolean).join(" · ") : p.customerName;

export interface OpsProjectRow extends OpsProject {
  canManage: boolean;
}

export interface OpsTask {
  id: string;
  projectId: string;
  dealId: string | null;
  title: string;
  assigneeUserId: string | null;
  assigneeName: string | null;
  estimatedHours: number;
  status: TaskStatus;
  dueDate: string | null;
  completedAt: string | null;
}

export interface VaultAccount {
  id: string;
  label: string;
  kind: AccountKind;
  url: string | null;
  username: string | null;
  notes: string;
  /** Solo indica si hay un valor guardado; el valor nunca viaja en listados. */
  credentialSet: boolean;
  rotatedAt: string | null;
}

export const PROPOSAL_STATUSES = ["draft", "sent", "accepted", "rejected"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
export const PROPOSAL_STATUS_LABELS: Record<ProposalStatus, string> = { draft: "Borrador", sent: "Enviada", accepted: "Aceptada", rejected: "Rechazada" };

/** Propuesta (web) de Comercial o de Operativa; la de un deal queda como su propuesta. */
export interface Proposal {
  id: string;
  leadId: string | null;
  projectId: string | null;
  dealId: string | null;
  title: string;
  url: string;
  amountCents: number | null;
  currency: string;
  status: ProposalStatus;
  area: "commercial" | "operations";
  sentAt: string | null;
  decidedAt: string | null;
  createdAt: string;
}

// ---- consultas ---------------------------------------------------------------------

export const opsKeys = {
  allProjects: ["ops", "projects"] as const,
  project: (id: string) => ["ops", "project", id] as const,
  part: (id: string, part: "tasks" | "accounts" | "proposals") => ["ops", "project", id, part] as const,
};

export const PROJECT_FILTERS = ["stage", "health", "priority", "teamId"] as const;

/** Tabla de proyectos (paginada en el servidor, con contador por etapa y totales del filtro). */
export function useOpsProjects(query: string) {
  const enabled = Boolean(useSession().data);
  return useTablePage<OpsProjectRow, { canCreate: boolean }>(opsKeys.allProjects, "/api/ops/projects", query, enabled);
}

export function useOpsProject(id: string) {
  return useQuery({
    queryKey: opsKeys.project(id),
    queryFn: () => apiFetch<{ project: OpsProject; permissions: { manage: boolean; work: boolean } }>(`/api/ops/projects/${id}`),
  });
}

const list = <T,>(id: string, part: "tasks" | "accounts" | "proposals", key: string, enabled = true) => ({
  queryKey: opsKeys.part(id, part),
  queryFn: async () => (await apiFetch<Record<string, T[]>>(`/api/ops/projects/${id}/${part}`))[key],
  enabled,
});

export const tasksQuery = (id: string) => list<OpsTask>(id, "tasks", "tasks");
export const accountsQuery = (id: string, enabled: boolean) => ({ ...list<VaultAccount>(id, "accounts", "accounts", enabled), retry: false });
export const proposalsQuery = (id: string) => list<Proposal>(id, "proposals", "proposals");

export interface TeamMember {
  id: string;
  name: string;
  role: "lead" | "developer";
}

/** Team leaders y developers activos de un equipo (el CEO/CCO indica cuál; el resto ve el suyo). */
export function useTeamMembers(teamId?: string | null, enabled = true) {
  return useQuery({
    queryKey: ["ops", "members", teamId ?? "own"],
    queryFn: async () => (await apiFetch<{ members: TeamMember[] }>(`/api/ops/members${teamId ? `?teamId=${teamId}` : ""}`)).members,
    enabled,
    staleTime: 60_000,
  });
}

// ---- acciones ----------------------------------------------------------------------

const send = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });
const base = (id: string) => `/api/ops/projects/${id}`;
/** Ruta del proyecto para los paneles de reuniones y novedades. */
export const opsBase = base;

/** Campos editables del proyecto (el Sentiment no: se deriva del Health). */
export interface ProjectInput {
  name: string;
  customerName: string;
  contactIds: string[];
  leadUserId: string | null;
  developerUserId: string | null;
  clientSlug: string | null;
  sowUrl: string | null;
  kickoffDate: string | null;
  stage: Stage;
  health: Health;
  priority: Priority;
  paymentType: PaymentType | null;
  nextAction: NextAction | null;
}

/** Contactos para elegir el cliente de un proyecto (CEO/CCO y Team Leader). */
export interface ClientOption {
  id: string;
  name: string;
  company: string | null;
}
export const useClientOptions = (enabled = true) =>
  useQuery({
    queryKey: ["ops", "contact-options"],
    queryFn: async () => (await apiFetch<{ contacts: ClientOption[] }>("/api/ops/contact-options")).contacts,
    enabled,
    staleTime: 60_000,
  });

export const createProject = (input: Partial<ProjectInput> & { name: string; teamId?: string }) => apiFetch<{ project: OpsProject }>("/api/ops/projects", send("POST", input));

export const updateProject = (id: string, patch: Partial<ProjectInput>) => apiFetch<{ project: OpsProject }>(base(id), send("PATCH", patch));

export const createTask = (id: string, input: { title: string; dealId?: string | null; assigneeUserId?: string | null; estimatedHours?: number; dueDate?: string | null }) =>
  apiFetch<{ task: OpsTask }>(`${base(id)}/tasks`, send("POST", input));
export const updateTask = (id: string, taskId: string, patch: Partial<{ status: TaskStatus; title: string; dealId: string | null; assigneeUserId: string | null; estimatedHours: number; dueDate: string | null }>) =>
  apiFetch<{ task: OpsTask }>(`${base(id)}/tasks/${taskId}`, send("PATCH", patch));

export const createAccount = (id: string, input: { label: string; kind: AccountKind; url?: string | null; username?: string | null; notes?: string; secret?: string }) =>
  apiFetch<{ account: VaultAccount }>(`${base(id)}/accounts`, send("POST", input));
export const rotateAccount = (id: string, accountId: string, secret: string) => apiFetch<{ account: VaultAccount }>(`${base(id)}/accounts/${accountId}`, send("PATCH", { secret }));
export const deleteAccount = (id: string, accountId: string) => apiFetch<{ ok: true }>(`${base(id)}/accounts/${accountId}`, send("DELETE"));
/** El valor se muestra en pantalla y no se guarda en la caché de consultas. */
export const revealAccount = (id: string, accountId: string) => apiFetch<{ username: string | null; credential: string }>(`${base(id)}/accounts/${accountId}/reveal`, send("POST"));

export const createProposal = (id: string, input: { title: string; url: string; dealId?: string | null; amountCents?: number | null; status?: ProposalStatus }) =>
  apiFetch<{ proposal: Proposal }>(`${base(id)}/proposals`, send("POST", input));
export const updateProposal = (id: string, proposalId: string, patch: Partial<{ title: string; url: string; dealId: string | null; amountCents: number | null; status: ProposalStatus }>) =>
  apiFetch<{ proposal: Proposal }>(`${base(id)}/proposals/${proposalId}`, send("PATCH", patch));

// ---- formato ---------------------------------------------------------------------

/** Monto en centavos con el formato único del panel. */
export const money = (cents: number, currency = "USD") => formatMoney(cents, currency);

export const hoursText = (hours: number) => `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
