import { useQuery } from "@tanstack/react-query";
import type { Tone } from "@/components/ui/tones";
import { useTablePage } from "@/components/data-table/use-table-page";
import { useSession } from "@/features/auth/auth";
import { apiFetch } from "@/lib/api-client";
import type { DealStatus, Health, Proposal, ProposalStatus, Stage } from "@/features/ops/api";

// ---- catálogos (los mismos valores que valida la API) ---------------------------------

export const LEAD_STATUSES = ["new", "contacted", "demo", "proposal_sent", "won", "lost", "nurturing", "unqualified"] as const;
/** Una sola tabla de leads, tres vistas: activos, fríos (Cold Leads) y ganados. */
export const LEAD_VIEWS = { active: ["new", "contacted", "demo", "proposal_sent"], cold: ["nurturing", "unqualified", "lost"], won: ["won"] } as const;
export type LeadView = keyof typeof LEAD_VIEWS;
export const LEAD_FUNNELS = ["lht", "upwork", "guide", "outreach", "aitp", "other"] as const;
export const LEAD_TEMPERATURES = ["hot", "warm", "nurturing"] as const;
export const DEMO_STATUSES = ["scheduled", "done", "cancelled", "no_show"] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];
export type DemoStatus = (typeof DEMO_STATUSES)[number];
export type LeadFunnel = (typeof LEAD_FUNNELS)[number];
export type LeadTemperature = (typeof LEAD_TEMPERATURES)[number];

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: "Nuevo",
  contacted: "Contactado",
  demo: "Demo",
  proposal_sent: "Propuesta enviada",
  won: "Ganado",
  lost: "Perdido",
  nurturing: "Nurturing",
  unqualified: "No calificado",
};
export const LEAD_VIEW_LABELS: Record<LeadView, string> = { active: "Activos", cold: "Fríos", won: "Ganados" };
export const LEAD_FUNNEL_LABELS: Record<LeadFunnel, string> = { lht: "LHT", upwork: "Upwork", guide: "Guía", outreach: "Outreach", aitp: "AITP", other: "Otro" };
export const LEAD_TEMPERATURE_LABELS: Record<LeadTemperature, string> = { hot: "Hot", warm: "Warm", nurturing: "Nurturing" };
export const LEAD_TEMPERATURE_TONE: Record<LeadTemperature, Tone> = { hot: "danger", warm: "warn", nurturing: "info" };
export const LEAD_STATUS_TONE: Record<LeadStatus, Tone> = {
  new: "info",
  contacted: "warn",
  demo: "accent",
  proposal_sent: "ok",
  won: "ok",
  lost: "neutral",
  nurturing: "outline",
  unqualified: "neutral",
};
export const DEMO_STATUS_LABELS: Record<DemoStatus, string> = { scheduled: "Agendada", done: "Realizada", cancelled: "Cancelada", no_show: "No asistió" };

// ---- tipos de la API -------------------------------------------------------------

export interface Lead {
  id: string;
  title: string;
  company: string;
  contactName: string;
  email: string | null;
  phone: string | null;
  notes: string;
  status: LeadStatus;
  /** De dónde vino ("Manual", "Referido", el formulario…). */
  source: string;
  /** El Setter agenda la reunión; el Closer cierra la venta. */
  setter: { id: string; name: string | null } | null;
  closer: { id: string; name: string | null } | null;
  funnel: LeadFunnel | null;
  temperature: LeadTemperature | null;
  submittedAt: string | null;
  meetingAt: string | null;
  /** (calc) días entre la llegada y la primera reunión. */
  responseDays: number | null;
  proposalUrl: string | null;
  contactRef: { id: string; name: string | null } | null;
  deal: { id: string; dealCode: string; title: string } | null;
  lostReason: string | null;
  contactId: string | null;
  dealId: string | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeadDetail extends Lead {
  fields: { key: string; value: string }[];
  rawJson: string | null;
}

export interface Demo {
  id: string;
  title: string;
  scheduledAt: string;
  url: string | null;
  notes: string;
  status: DemoStatus;
  learnings: { id: string; text: string; authorName: string; createdAt: string }[];
}

export interface Owner {
  id: string;
  name: string;
  role: string;
}

// ---- consultas ---------------------------------------------------------------------

export const LEAD_FILTERS = ["view", "status", "source", "funnel", "temperature", "setterUserId", "closerUserId"] as const;

export const salesKeys = {
  all: ["sales"] as const,
  leads: ["sales", "leads"] as const,
  lead: (id: string) => ["sales", "lead", id] as const,
  owners: ["sales", "owners"] as const,
};

/** Tabla de leads (paginada en el servidor), con los conteos del embudo sin el filtro de estado. */
export const useLeads = (query: string) =>
  useTablePage<Lead, { counts: Record<LeadStatus, number>; canWrite: boolean }>(salesKeys.leads, "/api/sales/leads", query, Boolean(useSession().data));

export const useLead = (id: string) =>
  useQuery({
    queryKey: salesKeys.lead(id),
    queryFn: () =>
      apiFetch<{
        lead: LeadDetail;
        demos: Demo[];
        proposals: Proposal[];
        project: { id: string; name: string; stage: Stage; health: Health } | null;
        /** Deals del lead. */
        deals: { id: string; dealCode: string; title: string; status: DealStatus; amountCents: number; currency: string }[];
        pendingActivities: number;
        canWrite: boolean;
      }>(`/api/sales/leads/${id}`),
  });

export const useOwners = (enabled = true) =>
  useQuery({ queryKey: salesKeys.owners, queryFn: async () => (await apiFetch<{ owners: Owner[] }>("/api/sales/owners")).owners, staleTime: 60_000, enabled });

// ---- acciones ----------------------------------------------------------------------

const send = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });
const base = (id: string) => `/api/sales/leads/${id}`;
/** Ruta del lead para los paneles de reuniones y novedades. */
export const leadBase = base;

/** Campos editables del lead (§4.1). */
export interface LeadInput {
  company: string;
  contactName: string;
  email: string | null;
  phone: string | null;
  notes: string;
  status: LeadStatus;
  setterUserId: string | null;
  closerUserId: string | null;
  funnel: LeadFunnel | null;
  temperature: LeadTemperature | null;
  submittedAt: string | null;
  meetingAt: string | null;
  proposalUrl: string | null;
  contactId: string | null;
  /** De dónde vino (texto). */
  source: string;
  lostReason: string | null;
}

export const createLead = (input: Partial<Omit<LeadInput, "status" | "lostReason">>) => apiFetch<{ lead: LeadDetail }>("/api/sales/leads", send("POST", input));
export const updateLead = (id: string, patch: Partial<LeadInput>) => apiFetch<{ lead: LeadDetail }>(base(id), send("PATCH", patch));
export const addDemoLearning = (id: string, demoId: string, text: string) => apiFetch<{ demo: Demo }>(`${base(id)}/demos/${demoId}/learnings`, send("POST", { text }));

export const createDemo = (id: string, input: { title: string; scheduledAt: string; url?: string | null; notes?: string }) => apiFetch<{ demo: Demo }>(`${base(id)}/demos`, send("POST", input));
export const updateDemo = (id: string, demoId: string, patch: Partial<{ status: DemoStatus; title: string; scheduledAt: string; url: string | null; notes: string }>) =>
  apiFetch<{ demo: Demo }>(`${base(id)}/demos/${demoId}`, send("PATCH", patch));

export const createLeadProposal = (id: string, input: { title: string; url: string; amountCents?: number | null; status?: ProposalStatus }) =>
  apiFetch<{ proposal: Proposal }>(`${base(id)}/proposals`, send("POST", input));
export const updateLeadProposal = (id: string, proposalId: string, patch: Partial<{ status: ProposalStatus; title: string; url: string; amountCents: number | null }>) =>
  apiFetch<{ proposal: Proposal }>(`${base(id)}/proposals/${proposalId}`, send("PATCH", patch));


