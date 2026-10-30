import { useQuery } from "@tanstack/react-query";
import { useTablePage } from "@/components/data-table/use-table-page";
import { useSession } from "@/features/auth/auth";
import type { DealStatus, ProposalStatus } from "@/features/ops/api";
import type { Demo, DemoStatus } from "@/features/sales/api";
import { apiFetch } from "@/lib/api-client";

// ---- catálogos (los mismos valores que valida la API) ---------------------------------

export const PARTNER_KINDS = ["referral", "agency", "platform", "consultant", "other"] as const;
export const ACTIVITY_KINDS = ["call", "email", "meeting", "follow_up", "task", "other"] as const;
export const ACTIVITY_STATUSES = ["pending", "done", "cancelled"] as const;

export type PartnerKind = (typeof PARTNER_KINDS)[number];
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

export const PARTNER_KIND_LABELS: Record<PartnerKind, string> = { referral: "Referido", agency: "Agencia", platform: "Plataforma", consultant: "Consultor", other: "Otro" };
export const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = { call: "Llamada", email: "Correo", meeting: "Reunión", follow_up: "Follow-up", task: "Tarea", other: "Otra" };
export const ACTIVITY_STATUS_LABELS: Record<ActivityStatus, string> = { pending: "Pendiente", done: "Hecha", cancelled: "Cancelada" };

// ---- tipos de la API -------------------------------------------------------------

type LeadRef = { id: string; title: string } | null;
type DealRef = { id: string; dealCode: string; title: string } | null;

export interface Partner {
  id: string;
  name: string;
  kind: PartnerKind;
  /** Comisión por defecto (%) de sus deals nuevos. */
  commissionPct: number;
  contactId: string | null;
  notes: string;
  active: boolean;
  /** (calc) deals que originó, valor vendido y comisión (comisión % × valor). */
  deals: number;
  soldCents: number;
  commissionCents: number;
  updatedAt: string;
}

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

export interface Product {
  id: string;
  name: string;
  description: string;
  defaultRateCents: number;
  active: boolean;
}

export interface UseCase {
  id: string;
  title: string;
  description: string;
  industry: string | null;
  productId: string | null;
}

export interface ProposalLine {
  id: string;
  productId: string | null;
  product: string | null;
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
  useCases: { id: string; title: string }[];
}

export interface DemoRow extends Demo {
  lead: { id: string; title: string | null };
}

export interface PartnerDeal {
  id: string;
  dealCode: string;
  title: string;
  status: DealStatus;
  amountCents: number;
  currency: string;
  partnerCommissionPct: number | null;
  commissionCents: number;
}

// ---- consultas ---------------------------------------------------------------------

export const commercialKeys = {
  partners: ["commercial", "partners"] as const,
  partner: (id: string) => ["commercial", "partner", id] as const,
  activities: ["commercial", "activities"] as const,
  demos: ["commercial", "demos"] as const,
  proposals: ["commercial", "proposals"] as const,
  proposal: (id: string) => ["commercial", "proposal", id] as const,
  products: ["commercial", "products"] as const,
  useCases: ["commercial", "use-cases"] as const,
};

export const PARTNER_FILTERS = ["kind", "active"] as const;
export const ACTIVITY_FILTERS = ["status", "kind", "ownerUserId", "mine"] as const;
export const DEMO_FILTERS = ["status"] as const;
export const PROPOSAL_FILTERS = ["status", "area"] as const;

const useEnabled = () => Boolean(useSession().data);
type Writable = { canWrite: boolean };

export const usePartners = (query: string) => useTablePage<Partner, Writable>(commercialKeys.partners, "/api/partners", query, useEnabled());
export const useActivities = (query: string) => useTablePage<Activity, Writable>(commercialKeys.activities, "/api/activities", query, useEnabled());
export const useDemos = (query: string) => useTablePage<DemoRow, Writable>(commercialKeys.demos, "/api/sales/demos", query, useEnabled());
export const useProposals = (query: string) => useTablePage<ProposalRow, Writable>(commercialKeys.proposals, "/api/proposals", query, useEnabled());

export const usePartner = (id: string) =>
  useQuery({ queryKey: commercialKeys.partner(id), queryFn: () => apiFetch<{ partner: Partner; contact: { id: string; name: string } | null; deals: PartnerDeal[] } & Writable>(`/api/partners/${id}`) });
export const usePartnerOptions = (enabled = true) =>
  useQuery({
    queryKey: [...commercialKeys.partners, "options"],
    queryFn: async () => (await apiFetch<{ rows: Partner[] }>("/api/partners?pageSize=100&sort=name&dir=asc&active=true")).rows,
    enabled,
    staleTime: 60_000,
  });
export const useProposal = (id: string) => useQuery({ queryKey: commercialKeys.proposal(id), queryFn: () => apiFetch<{ proposal: ProposalDetail } & Writable>(`/api/proposals/${id}`) });
export const useProducts = () => useQuery({ queryKey: commercialKeys.products, queryFn: () => apiFetch<{ products: Product[] } & Writable>("/api/products"), staleTime: 60_000 });
export const useUseCases = () => useQuery({ queryKey: commercialKeys.useCases, queryFn: () => apiFetch<{ useCases: UseCase[] } & Writable>("/api/use-cases"), staleTime: 60_000 });

// ---- acciones ----------------------------------------------------------------------

const send = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

export type PartnerInput = Pick<Partner, "name" | "kind" | "commissionPct" | "notes" | "active"> & { contactId: string | null };
export const createPartner = (input: Partial<PartnerInput> & { name: string }) => apiFetch<{ partner: Partner }>("/api/partners", send("POST", input));
export const updatePartner = (id: string, patch: Partial<PartnerInput>) => apiFetch<{ partner: Partner }>(`/api/partners/${id}`, send("PATCH", patch));

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

export const createProduct = (input: Partial<Omit<Product, "id">> & { name: string }) => apiFetch<{ product: Product }>("/api/products", send("POST", input));
export const updateProduct = (id: string, patch: Partial<Omit<Product, "id">>) => apiFetch<{ product: Product }>(`/api/products/${id}`, send("PATCH", patch));
export const createUseCase = (input: Partial<Omit<UseCase, "id">> & { title: string }) => apiFetch<{ useCase: UseCase }>("/api/use-cases", send("POST", input));

export interface ProposalInput {
  title: string;
  url: string;
  leadId: string | null;
  dealId: string | null;
  status: ProposalStatus;
  currency: string;
  amountCents: number | null;
  lines: { productId?: string | null; description: string; hours: number; rateCents: number }[];
  useCaseIds: string[];
}
export const createProposal = (input: Partial<ProposalInput> & { title: string; url: string }) => apiFetch<{ proposal: ProposalDetail }>("/api/proposals", send("POST", input));
export const updateProposal = (id: string, patch: Partial<ProposalInput>) => apiFetch<{ proposal: ProposalDetail }>(`/api/proposals/${id}`, send("PATCH", patch));

export type { DemoStatus };
