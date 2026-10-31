import { useQuery } from "@tanstack/react-query";
import { useTablePage } from "@/components/data-table/use-table-page";
import { useSession } from "@/features/auth/auth";
import type { ProposalStatus } from "@/features/ops/api";
import type { Demo, DemoStatus } from "@/features/sales/api";
import { apiFetch } from "@/lib/api-client";

// ---- catálogos (los mismos valores que valida la API) ---------------------------------

export const ACTIVITY_KINDS = ["call", "email", "meeting", "follow_up", "task", "other"] as const;
export const ACTIVITY_STATUSES = ["pending", "done", "cancelled"] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

export const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = { call: "Llamada", email: "Correo", meeting: "Reunión", follow_up: "Follow-up", task: "Tarea", other: "Otra" };
export const ACTIVITY_STATUS_LABELS: Record<ActivityStatus, string> = { pending: "Pendiente", done: "Hecha", cancelled: "Cancelada" };

// ---- tipos de la API -------------------------------------------------------------

type LeadRef = { id: string; title: string } | null;
type DealRef = { id: string; dealCode: string; title: string } | null;

export interface Activity {
  id: string;
  title: string;
  kind: ActivityKind;
  owner: { id: string; name: string | null } | null;
  dueDate: string | null;
  /** (calc) pendiente y con la fecha pasada. */
  overdue: boolean;
  status: ActivityStatus;
  notes: string;
  lead: LeadRef;
  deal: DealRef;
  completedAt: string | null;
  updatedAt: string;
}

export interface ProposalLine {
  id: string;
  description: string;
  hours: number;
  rateCents: number;
  /** (calc) horas × tarifa. */
  subtotalCents: number;
}

export interface ProposalRow {
  id: string;
  title: string;
  url: string;
  amountCents: number | null;
  currency: string;
  status: ProposalStatus;
  area: "commercial" | "operations";
  sentAt: string | null;
  decidedAt: string | null;
  createdAt: string;
  lead: LeadRef;
  deal: DealRef;
  /** Cantidad de líneas. */
  lines: number;
}

export interface ProposalDetail extends Omit<ProposalRow, "lines"> {
  project: { id: string; name: string } | null;
  lines: ProposalLine[];
}

export interface DemoRow extends Demo {
  lead: { id: string; title: string | null };
}

// ---- consultas ---------------------------------------------------------------------

export const commercialKeys = {
  activities: ["commercial", "activities"] as const,
  demos: ["commercial", "demos"] as const,
  proposals: ["commercial", "proposals"] as const,
  proposal: (id: string) => ["commercial", "proposal", id] as const,
};

export const ACTIVITY_FILTERS = ["status", "kind", "ownerUserId", "mine"] as const;
export const DEMO_FILTERS = ["status"] as const;
export const PROPOSAL_FILTERS = ["status", "area"] as const;

const useEnabled = () => Boolean(useSession().data);
type Writable = { canWrite: boolean };

export const useActivities = (query: string) => useTablePage<Activity, Writable>(commercialKeys.activities, "/api/activities", query, useEnabled());
export const useDemos = (query: string) => useTablePage<DemoRow, Writable>(commercialKeys.demos, "/api/sales/demos", query, useEnabled());
export const useProposals = (query: string) => useTablePage<ProposalRow, Writable>(commercialKeys.proposals, "/api/proposals", query, useEnabled());

export const useProposal = (id: string) => useQuery({ queryKey: commercialKeys.proposal(id), queryFn: () => apiFetch<{ proposal: ProposalDetail } & Writable>(`/api/proposals/${id}`) });

// ---- acciones ----------------------------------------------------------------------

const send = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

export interface ActivityInput {
  title: string;
  kind: ActivityKind;
  ownerUserId: string | null;
  dueDate: string | null;
  status: ActivityStatus;
  leadId: string | null;
  dealId: string | null;
  notes: string;
}
export const createActivity = (input: Partial<ActivityInput> & { title: string }) => apiFetch<{ activity: Activity }>("/api/activities", send("POST", input));
export const updateActivity = (id: string, patch: Partial<ActivityInput>) => apiFetch<{ activity: Activity }>(`/api/activities/${id}`, send("PATCH", patch));

export interface ProposalInput {
  title: string;
  url: string;
  leadId: string | null;
  dealId: string | null;
  status: ProposalStatus;
  currency: string;
  amountCents: number | null;
  lines: { description: string; hours: number; rateCents: number }[];
}
export const createProposal = (input: Partial<ProposalInput> & { title: string; url: string }) => apiFetch<{ proposal: ProposalDetail }>("/api/proposals", send("POST", input));
export const updateProposal = (id: string, patch: Partial<ProposalInput>) => apiFetch<{ proposal: ProposalDetail }>(`/api/proposals/${id}`, send("PATCH", patch));

export type { DemoStatus };
