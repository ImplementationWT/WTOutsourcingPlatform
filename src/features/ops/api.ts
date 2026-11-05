import type { ChipColor } from "@/components/ui/chip";
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
export const TASK_STATUSES = ["todo", "in_progress", "review", "stuck", "done"] as const;
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
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = { todo: "Pending", in_progress: "Working on it", review: "In Review", stuck: "Stuck", done: "Completed" };
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
/** Colores del prototipo (prioChip; las etapas usan su propio tono en STAGE_HUE). */
export const PRIORITY_CHIP: Record<Priority, ChipColor> = { critical: "red", high: "red", medium: "amber", low: "green" };
export const HEALTH_CHIP: Record<Health, ChipColor> = { champion: "green", very_happy: "green", happy: "green", mixed: "amber", neutral: "gray", concerned: "amber", escalated: "red", at_risk: "red" };
/** Tono de cada etapa (prototipo .stg0…6): se mezcla con el fondo y con el texto en ambos temas. */
export const STAGE_HUE: Record<Stage, string> = { kickoff: "#38bdf8", structure: "#f97316", automation_layer: "#e0a50f", stabilization: "#84cc16", maintenance: "#3b82f6", no_pending_items: "#6b8e23", completed: "#22e06b" };
/** Fondo y texto de una etapa mezclando su tono (se lee en claro y en oscuro). */
export const stageStyle = (stage: Stage) => ({
  backgroundColor: `color-mix(in srgb, ${STAGE_HUE[stage]} 20%, transparent)`,
  color: `color-mix(in srgb, ${STAGE_HUE[stage]} 60%, var(--foreground))`,
});

// ---- tipos de la API -------------------------------------------------------------

type Ref = { id: string; name: string | null };

export interface OpsProject {
  id: string;
  name: string;
  customerName: string;
  team: Ref;
  lead: Ref | null;
  developer: Ref | null;
  /** Hasta 2 developers; `developer` es el primero. */
  developers: Ref[];
  contacts: Ref[];
  /** El cliente es el contacto del proyecto (con su empresa); `customerName` sale de él. */
  client: { id: string; name: string | null; company: string | null } | null;
  clientSlug: string | null;
  sowUrl: string | null;
  kickoffDate: string | null;
  /** Tarifa por hora del proyecto (centavos); sin ella se calcula de los deals. */
  hourlyRateCents?: number | null;
  /** SOW subido como archivo. */
  sowDoc?: { name: string; size: number; uploadedAt: string } | null;
  leadId: string | null;
  stage: Stage;
  /** Desde qué día (AAAA-MM-DD) está en la etapa actual. */
  stageSince: string;
  stageHistory: StageHistoryEntry[];
  health: Health;
  /** (calc) del Health. */
  sentimentScore: number;
  priority: Priority;
  paymentType: PaymentType | null;
  nextAction: NextAction | null;
  /** Campos calculados en el servidor. */
  summary: { deals: number; amountCents: number; soldHours: number; /** Horas de los deals Ganados (Total Hours Approved). */ wonHours?: number; billableHours: number; billableVsSold: number; tasks: number; tasksDone: number; progress: number };
  createdAt: string;
  updatedAt: string;
}

export interface StageHistoryEntry {
  stage: Stage;
  at: string;
  by: string;
  /** Fecha deducida al migrar. */
  estimated?: boolean;
}

/** Plazo esperado por etapa en días (null: sin límite). */
export type StageSla = Record<Stage, number | null>;
export const MAX_DEVELOPERS = 2;

/** Proyecto que lleva más días en su etapa que el plazo esperado. */
export interface StuckProject {
  id: string;
  name: string;
  stage: Stage;
  days: number;
  sla: number | null;
}

/** Días entre dos fechas AAAA-MM-DD (sin zona horaria). */
export const daysBetween = (from: string, to: string) => Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));
export const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * Tiempo en la etapa: verde en plazo, ámbar desde el 75 % del plazo y rojo si lo pasa. Sin plazo
 * (Completed), solo los días.
 */
export function stageAge(since: string, sla: number | null, today = todayIso()) {
  const days = daysBetween(since, today);
  if (sla === null) return { days, sla, over: 0, tone: "neutral" as Tone, text: `${days} d` };
  const over = days - sla;
  const tone: Tone = over > 0 ? "danger" : days >= sla * 0.75 ? "warn" : "ok";
  return { days, sla, over, tone, text: over > 0 ? `${days} d · +${over} d` : `${days} d de ${sla} d` };
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
  return useTablePage<OpsProjectRow, { canCreate: boolean; stuck: StuckProject[]; sla: StageSla }>(opsKeys.allProjects, "/api/ops/projects", query, enabled);
}

export function useOpsProject(id: string) {
  return useQuery({
    queryKey: opsKeys.project(id),
    queryFn: () => apiFetch<{ project: OpsProject; permissions: { manage: boolean; work: boolean }; finance?: { paidHours: number; paidCents: number } | null }>(`/api/ops/projects/${id}`),
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
  teamId: string;
  hourlyRateCents: number | null;
  customerName: string;
  contactIds: string[];
  leadUserId: string | null;
  developerUserId: string | null;
  developerUserIds: string[];
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

export function useStageSla() {
  return useQuery({
    queryKey: ["ops", "stage-sla"],
    queryFn: () => apiFetch<{ days: StageSla; defaults: StageSla }>("/api/ops/stage-sla"),
    staleTime: 60_000,
  });
}
export const updateStageSla = (days: StageSla) => apiFetch<{ days: StageSla }>("/api/ops/stage-sla", send("PUT", { days }));

// ---- formato ---------------------------------------------------------------------

/** Monto en centavos con el formato único del panel. */
export const money = (cents: number, currency = "USD") => formatMoney(cents, currency);
/** Monto redondeado como en el prototipo: «$9,000» (otras monedas, con su código). */
export const moneyShort = (cents: number, currency = "USD") => `${currency === "USD" ? "$" : `${currency} `}${Math.round(cents / 100).toLocaleString("en-US")}`;

export const hoursText = (hours: number) => `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
