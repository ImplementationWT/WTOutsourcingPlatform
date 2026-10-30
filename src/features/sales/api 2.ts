import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import type { Health, Proposal, ProposalStatus, Stage } from "@/features/ops/api";

// ---- catálogos (los mismos valores que valida la API) ---------------------------------

export const LEAD_STATUSES = ["new", "contacted", "demo", "proposal_sent", "won", "lost"] as const;
export const DEMO_STATUSES = ["scheduled", "done", "cancelled", "no_show"] as const;
export const SOURCE_KINDS = ["webhook", "form", "manual", "import"] as const;
export const LEAD_FIELDS = ["company", "contactName", "email", "phone", "notes", "externalId"] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];
export type DemoStatus = (typeof DEMO_STATUSES)[number];
export type SourceKind = (typeof SOURCE_KINDS)[number];
export type LeadField = (typeof LEAD_FIELDS)[number];

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: "Nuevo",
  contacted: "Contactado",
  demo: "Demo",
  proposal_sent: "Propuesta enviada",
  won: "Ganado",
  lost: "Perdido",
};
export const LEAD_STATUS_TONE: Record<LeadStatus, string> = {
  new: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  contacted: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
  demo: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  proposal_sent: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  won: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
  lost: "bg-foreground/10 text-muted-foreground",
};
export const DEMO_STATUS_LABELS: Record<DemoStatus, string> = { scheduled: "Agendada", done: "Realizada", cancelled: "Cancelada", no_show: "No asistió" };
export const SOURCE_KIND_LABELS: Record<SourceKind, string> = { webhook: "Webhook (JSON)", form: "Formulario web", manual: "Manual", import: "Importación" };
export const LEAD_FIELD_LABELS: Record<LeadField, string> = {
  company: "Empresa",
  contactName: "Contacto",
  email: "Correo",
  phone: "Teléfono",
  notes: "Mensaje / notas",
  externalId: "Id en el origen",
};

/** Los sources de webhook y formulario reciben por el endpoint con su clave. */
export const receivesByEndpoint = (kind: SourceKind) => kind === "webhook" || kind === "form";

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
  source: { id: string | null; name: string };
  owner: { id: string; name: string | null } | null;
  lostReason: string | null;
  customerId: string | null;
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
}

export interface LeadSource {
  id: string;
  name: string;
  kind: SourceKind;
  keyHint: string | null;
  hasKey: boolean;
  mapping: { from: string; to: LeadField }[];
  active: boolean;
  received: number;
  lastReceivedAt: string | null;
  sampleKeys: string[];
  ingestPath: string;
}

export interface Customer {
  id: string;
  name: string;
  contactName: string;
  email: string | null;
  phone: string | null;
  leadId: string | null;
  createdAt: string;
  projects: { id: string; name: string; stage: Stage; health: Health }[];
}

export interface Owner {
  id: string;
  name: string;
  role: string;
}

// ---- consultas ---------------------------------------------------------------------

export interface LeadFilters {
  status?: LeadStatus;
  sourceId?: string;
  q?: string;
}

export const salesKeys = {
  all: ["sales"] as const,
  leads: (filters: LeadFilters = {}) => ["sales", "leads", filters] as const,
  lead: (id: string) => ["sales", "lead", id] as const,
  sources: ["sales", "sources"] as const,
  customers: ["sales", "customers"] as const,
  owners: ["sales", "owners"] as const,
};

function query(filters: LeadFilters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  const text = params.toString();
  return text ? `?${text}` : "";
}

export const useLeads = (filters: LeadFilters = {}) =>
  useQuery({ queryKey: salesKeys.leads(filters), queryFn: () => apiFetch<{ leads: Lead[]; counts: Record<LeadStatus, number> }>(`/api/sales/leads${query(filters)}`) });

export const useLead = (id: string) =>
  useQuery({
    queryKey: salesKeys.lead(id),
    queryFn: () =>
      apiFetch<{ lead: LeadDetail; demos: Demo[]; proposals: Proposal[]; customer: { id: string; name: string } | null; project: { id: string; name: string; stage: Stage; health: Health } | null }>(`/api/sales/leads/${id}`),
  });

export const useSources = () => useQuery({ queryKey: salesKeys.sources, queryFn: async () => (await apiFetch<{ sources: LeadSource[] }>("/api/sales/sources")).sources });
export const useCustomers = () => useQuery({ queryKey: salesKeys.customers, queryFn: async () => (await apiFetch<{ customers: Customer[] }>("/api/sales/customers")).customers });
export const useOwners = () => useQuery({ queryKey: salesKeys.owners, queryFn: async () => (await apiFetch<{ owners: Owner[] }>("/api/sales/owners")).owners, staleTime: 60_000 });

// ---- acciones ----------------------------------------------------------------------

const send = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });
const base = (id: string) => `/api/sales/leads/${id}`;
/** Ruta del lead para los paneles de reuniones y novedades. */
export const leadBase = base;

export const createLead = (input: { company?: string; contactName?: string; email?: string | null; phone?: string | null; notes?: string; sourceId?: string; ownerUserId?: string | null }) =>
  apiFetch<{ lead: LeadDetail }>("/api/sales/leads", send("POST", input));
export const updateLead = (
  id: string,
  patch: Partial<{ company: string; contactName: string; email: string | null; phone: string | null; notes: string; status: LeadStatus; ownerUserId: string | null; lostReason: string | null }>,
) => apiFetch<{ lead: LeadDetail }>(base(id), send("PATCH", patch));

export const createDemo = (id: string, input: { title: string; scheduledAt: string; url?: string | null; notes?: string }) => apiFetch<{ demo: Demo }>(`${base(id)}/demos`, send("POST", input));
export const updateDemo = (id: string, demoId: string, patch: Partial<{ status: DemoStatus; title: string; scheduledAt: string; url: string | null; notes: string }>) =>
  apiFetch<{ demo: Demo }>(`${base(id)}/demos/${demoId}`, send("PATCH", patch));

export const createLeadProposal = (id: string, input: { title: string; url: string; amountCents?: number | null; status?: ProposalStatus }) =>
  apiFetch<{ proposal: Proposal }>(`${base(id)}/proposals`, send("POST", input));
export const updateLeadProposal = (id: string, proposalId: string, patch: Partial<{ status: ProposalStatus; title: string; url: string; amountCents: number | null }>) =>
  apiFetch<{ proposal: Proposal }>(`${base(id)}/proposals/${proposalId}`, send("PATCH", patch));

export const convertLead = (id: string, input: { teamId: string; projectName: string; customerName?: string; leadUserId?: string | null; developerUserId?: string | null; proposalId?: string }) =>
  apiFetch<{ customer: { id: string; name: string }; project: { id: string; name: string } }>(`${base(id)}/convert`, send("POST", input));

/** La clave de ingesta solo llega aquí: se muestra una vez y no se guarda en la caché. */
export const createSource = (input: { name: string; kind: SourceKind; mapping?: LeadSource["mapping"] }) =>
  apiFetch<{ source: LeadSource; ingestKey: string | null }>("/api/sales/sources", send("POST", input));
export const updateSource = (id: string, patch: Partial<{ name: string; kind: SourceKind; mapping: LeadSource["mapping"]; active: boolean }>) =>
  apiFetch<{ source: LeadSource }>(`/api/sales/sources/${id}`, send("PATCH", patch));
export const rotateSourceKey = (id: string) => apiFetch<{ source: LeadSource; ingestKey: string }>(`/api/sales/sources/${id}/rotate-key`, send("POST"));
