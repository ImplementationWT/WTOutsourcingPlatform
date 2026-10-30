import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { useSession } from "@/features/auth/auth";

// ---- catálogos (los mismos valores que valida la API) ---------------------------------

export const STAGES = ["kickoff", "structure", "automation_layer", "stabilization", "maintenance", "no_pending_items", "completed"] as const;
export const HEALTH = ["champion", "very_happy", "happy", "mixed", "neutral", "concerned", "escalated", "at_risk"] as const;
export const PRIORITIES = ["critical", "high", "medium", "low"] as const;
export const DEAL_STATUSES = ["draft", "proposed", "approved", "in_progress", "delivered", "invoiced", "paid", "cancelled"] as const;
export const TASK_STATUSES = ["todo", "in_progress", "review", "done"] as const;
export const ACCOUNT_KINDS = ["web", "email", "api", "database", "server", "social", "other"] as const;

export type Stage = (typeof STAGES)[number];
export type Health = (typeof HEALTH)[number];
export type Priority = (typeof PRIORITIES)[number];
export type DealStatus = (typeof DEAL_STATUSES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

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

/** Clases de color por health: verdes los buenos, grises los neutros, ámbar y rojos los de riesgo. */
export const HEALTH_TONE: Record<Health, string> = {
  champion: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
  very_happy: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
  happy: "bg-green-500/15 text-green-600 dark:text-green-300",
  mixed: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-300",
  neutral: "bg-foreground/10 text-muted-foreground",
  concerned: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  escalated: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  at_risk: "bg-red-500/15 text-red-600 dark:text-red-300",
};
export const PRIORITY_TONE: Record<Priority, string> = {
  critical: "bg-red-500/15 text-red-600 dark:text-red-300",
  high: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  medium: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  low: "bg-foreground/10 text-muted-foreground",
};

// ---- tipos de la API -------------------------------------------------------------

export interface OpsProject {
  id: string;
  name: string;
  customerName: string;
  team: { id: string; name: string | null };
  lead: { id: string; name: string | null } | null;
  developer: { id: string; name: string | null } | null;
  clientSlug: string | null;
  proposalUrl: string | null;
  stage: Stage;
  health: Health;
  sentimentScore: number;
  priority: Priority;
  createdAt: string;
  updatedAt: string;
}

export interface OpsProjectListItem extends OpsProject {
  summary: { deals: number; hours: number; amountCents: number; tasks: number; tasksDone: number };
}

export interface Deal {
  id: string;
  projectId: string;
  title: string;
  description: string;
  hours: number;
  rateCents: number;
  amountCents: number;
  currency: string;
  status: DealStatus;
  proposalUrl: string | null;
  paidAt: string | null;
  createdAt: string;
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

export interface ProjectUpdate {
  id: string;
  kind: "manual" | "system";
  body: string;
  authorName: string;
  createdAt: string;
}

export interface Meeting {
  id: string;
  title: string;
  heldAt: string;
  source: "read_ai" | "manual";
  status: "pending" | "processed" | "failed";
  summary: string;
  feedback: string[];
  actionItems: string[];
  transcriptLength: number;
}

// ---- consultas ---------------------------------------------------------------------

export const opsKeys = {
  projects: (filters: ProjectFilters = {}) => ["ops", "projects", filters] as const,
  allProjects: ["ops", "projects"] as const,
  project: (id: string) => ["ops", "project", id] as const,
  part: (id: string, part: "deals" | "tasks" | "accounts" | "updates" | "meetings") => ["ops", "project", id, part] as const,
};

export interface ProjectFilters {
  stage?: Stage;
  health?: Health;
  priority?: Priority;
}

function query(filters: ProjectFilters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function useOpsProjects(filters: ProjectFilters = {}) {
  const enabled = Boolean(useSession().data);
  return useQuery({
    queryKey: opsKeys.projects(filters),
    queryFn: async () => (await apiFetch<{ projects: OpsProjectListItem[] }>(`/api/ops/projects${query(filters)}`)).projects,
    enabled,
  });
}

export function useOpsProject(id: string) {
  return useQuery({
    queryKey: opsKeys.project(id),
    queryFn: () => apiFetch<{ project: OpsProject; permissions: { manage: boolean; work: boolean } }>(`/api/ops/projects/${id}`),
  });
}

const list = <T,>(id: string, part: "deals" | "tasks" | "accounts" | "updates" | "meetings", key: string, enabled = true) => ({
  queryKey: opsKeys.part(id, part),
  queryFn: async () => (await apiFetch<Record<string, T[]>>(`/api/ops/projects/${id}/${part}`))[key],
  enabled,
});

export const dealsQuery = (id: string) => list<Deal>(id, "deals", "deals");
export const tasksQuery = (id: string) => list<OpsTask>(id, "tasks", "tasks");
export const accountsQuery = (id: string, enabled: boolean) => ({ ...list<VaultAccount>(id, "accounts", "accounts", enabled), retry: false });
export const updatesQuery = (id: string) => list<ProjectUpdate>(id, "updates", "updates");
export const meetingsQuery = (id: string) => list<Meeting>(id, "meetings", "meetings");

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

export const createProject = (input: {
  name: string;
  customerName: string;
  teamId?: string;
  leadUserId?: string | null;
  developerUserId?: string | null;
  proposalUrl?: string | null;
  priority?: Priority;
}) => apiFetch<{ project: OpsProject }>("/api/ops/projects", send("POST", input));

export const updateProject = (id: string, patch: Partial<Pick<OpsProject, "name" | "customerName" | "proposalUrl" | "stage" | "health" | "priority" | "sentimentScore">> & { leadUserId?: string | null; developerUserId?: string | null }) =>
  apiFetch<{ project: OpsProject }>(base(id), send("PATCH", patch));

export const createDeal = (id: string, input: { title: string; description?: string; hours: number; rateCents: number; currency?: string; status?: DealStatus; proposalUrl?: string | null }) =>
  apiFetch<{ deal: Deal }>(`${base(id)}/deals`, send("POST", input));
export const updateDeal = (id: string, dealId: string, patch: Partial<{ title: string; description: string; hours: number; rateCents: number; status: DealStatus; proposalUrl: string | null }>) =>
  apiFetch<{ deal: Deal }>(`${base(id)}/deals/${dealId}`, send("PATCH", patch));

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

export const createUpdate = (id: string, body: string) => apiFetch<{ update: ProjectUpdate }>(`${base(id)}/updates`, send("POST", { body }));
export const createMeeting = (id: string, input: { title: string; heldAt: string; transcript?: string; summary?: string; feedback?: string[]; actionItems?: string[] }) =>
  apiFetch<{ meeting: Meeting }>(`${base(id)}/meetings`, send("POST", input));

// ---- formato ---------------------------------------------------------------------

export function money(cents: number, currency = "USD") {
  return new Intl.NumberFormat("es-PE", { style: "currency", currency }).format(cents / 100);
}

export const hoursText = (hours: number) => `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
