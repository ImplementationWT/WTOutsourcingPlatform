import { useQuery } from "@tanstack/react-query";
import { useTablePage } from "@/components/data-table/use-table-page";
import { useSession } from "@/features/auth/auth";
import type { DealStatus, Stage } from "@/features/ops/api";
import type { LeadStatus } from "@/features/sales/api";
import { apiFetch } from "@/lib/api-client";

// ---- catálogos (los mismos valores que valida la API) ---------------------------------

export const SALES_STAGES = ["new", "discovery", "demo", "proposal", "negotiation", "confirmed", "won", "lost", "ghosted", "on_hold"] as const;
export const SALE_TYPES = ["new_project", "upsell", "change_order"] as const;
export const CHANGE_ORDER_STATUSES = ["draft", "proposed", "approved", "rejected", "canceled"] as const;
/** Comercial crea y edita deals hasta «Propuesto» (§6). */
export const COMMERCIAL_DEAL_STATUSES = ["draft", "proposed"] as const;

export type SalesStage = (typeof SALES_STAGES)[number];
export type SaleType = (typeof SALE_TYPES)[number];
export type ChangeOrderStatus = (typeof CHANGE_ORDER_STATUSES)[number];

export const SALES_STAGE_LABELS: Record<SalesStage, string> = {
  new: "Nuevo",
  discovery: "Discovery",
  demo: "Demo",
  proposal: "Propuesta",
  negotiation: "Negociación",
  confirmed: "Confirmado",
  won: "Ganado",
  lost: "Perdido",
  ghosted: "Ghosted",
  on_hold: "En espera",
};
export const SALE_TYPE_LABELS: Record<SaleType, string> = { new_project: "Nuevo proyecto", upsell: "Upsell", change_order: "Change order" };
export const CHANGE_ORDER_STATUS_LABELS: Record<ChangeOrderStatus, string> = {
  draft: "Borrador",
  proposed: "Propuesto",
  approved: "Aprobado",
  rejected: "Rechazado",
  canceled: "Cancelado",
};

// ---- tipos de la API -------------------------------------------------------------

type Ref = { id: string; name: string | null };

export interface Contact {
  id: string;
  name: string;
  emails: string[];
  phone: string | null;
  title: string | null;
  linkedinUrl: string | null;
  /** Empresa donde trabaja (texto). */
  company: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChangeOrder {
  id: string;
  description: string;
  hours: number;
  rateCents: number;
  amountCents: number;
  status: ChangeOrderStatus;
  approvedAt: string | null;
  signedBy: string | null;
  createdAt: string;
}

export interface Deal {
  id: string;
  dealCode: string;
  title: string;
  description: string;
  project: { id: string; name: string; customerName: string } | null;
  lead: { id: string; title: string } | null;
  contacts: Ref[];
  owner: Ref | null;
  salesStage: SalesStage;
  status: DealStatus;
  hours: number;
  rateCents: number;
  /** (calc) horas × tarifa. */
  amountCents: number;
  probability: number;
  /** (calc) valor × probabilidad. */
  projectedCents: number;
  currency: string;
  expectedCloseDate: string | null;
  actualCloseDate: string | null;
  saleType: SaleType | null;
  product: string | null;
  channel: string | null;
  lostReason: string | null;
  proposalUrl: string | null;
  sowUrl: string | null;
  paidAt: string | null;
  updatedAt: string;
  canEdit: boolean;
  changeOrders?: ChangeOrder[];
}

export interface DealInput {
  title: string;
  description: string;
  projectId: string | null;
  leadId: string | null;
  contactIds: string[];
  ownerUserId: string | null;
  salesStage: SalesStage;
  status: DealStatus;
  hours: number;
  rateCents: number;
  probability: number;
  currency: string;
  expectedCloseDate: string | null;
  actualCloseDate: string | null;
  saleType: SaleType | null;
  product: string | null;
  channel: string | null;
  lostReason: string | null;
  proposalUrl: string | null;
  sowUrl: string | null;
}

// ---- consultas ---------------------------------------------------------------------

export const coreKeys = {
  contacts: ["core", "contacts"] as const,
  contact: (id: string) => ["core", "contact", id] as const,
  deals: ["core", "deals"] as const,
  deal: (id: string) => ["core", "deal", id] as const,
};

export const DEAL_FILTERS = ["status", "salesStage", "ownerUserId"] as const;

const useEnabled = () => Boolean(useSession().data);

export const useContacts = (query: string) => useTablePage<Contact>(coreKeys.contacts, "/api/contacts", query, useEnabled());
export const useDeals = (query: string) => useTablePage<Deal, { canCreate: boolean }>(coreKeys.deals, "/api/deals", query, useEnabled());

export const useContact = (id: string) =>
  useQuery({
    queryKey: coreKeys.contact(id),
    queryFn: () =>
      apiFetch<{
        contact: Contact;
        deals: { id: string; dealCode: string; title: string; status: DealStatus }[];
        projects: { id: string; name: string; stage: Stage }[];
        leads: { id: string; title: string; status: LeadStatus }[];
      }>(`/api/contacts/${id}`),
  });

export const useDeal = (id: string) => useQuery({ queryKey: coreKeys.deal(id), queryFn: () => apiFetch<{ deal: Deal }>(`/api/deals/${id}`) });

/** Contactos para elegir en un formulario. */
export const useContactOptions = (enabled = true) =>
  useQuery({
    queryKey: [...coreKeys.contacts, "options"],
    queryFn: async () => (await apiFetch<{ rows: Contact[] }>("/api/contacts?pageSize=100&sort=name&dir=asc")).rows,
    enabled,
    staleTime: 60_000,
  });

/** Deals de un proyecto (para elegir uno en tareas y propuestas). */
export const useProjectDeals = (projectId: string) =>
  useQuery({
    queryKey: [...coreKeys.deals, "project", projectId],
    queryFn: async () => (await apiFetch<{ rows: Deal[] }>(`/api/deals?projectId=${projectId}&pageSize=100&sort=dealCode&dir=asc`)).rows,
  });

/** Reuniones que hablaron del deal (del proyecto o del lead). */
export const useDealMeetings = (id: string) =>
  useQuery({
    queryKey: [...coreKeys.deal(id), "meetings"],
    queryFn: async () =>
      (await apiFetch<{ meetings: { id: string; title: string; heldAt: string; kind: string | null; reviewStatus: string; owner: { kind: "project" | "lead"; id: string } }[] }>(`/api/deals/${id}/meetings`)).meetings,
  });

/** Base de la bitácora del deal (mismo panel de novedades que el proyecto y el lead). */
export const dealBase = (id: string) => `/api/deals/${id}`;

// ---- acciones ----------------------------------------------------------------------

const send = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

export type ContactInput = Pick<Contact, "name" | "emails" | "phone" | "title" | "company" | "linkedinUrl">;
export const createContact = (input: Partial<ContactInput> & { name: string }) => apiFetch<{ contact: Contact }>("/api/contacts", send("POST", input));
export const updateContact = (id: string, patch: Partial<ContactInput>) => apiFetch<{ contact: Contact }>(`/api/contacts/${id}`, send("PATCH", patch));

export const createDeal = (input: Partial<DealInput> & { title: string }) => apiFetch<{ deal: Deal }>("/api/deals", send("POST", input));
export const updateDeal = (id: string, patch: Partial<DealInput>) => apiFetch<{ deal: Deal }>(`/api/deals/${id}`, send("PATCH", patch));

export const createChangeOrder = (id: string, input: { description: string; hours: number; rateCents: number; status?: ChangeOrderStatus; signedBy?: string | null }) =>
  apiFetch<{ changeOrder: ChangeOrder }>(`/api/deals/${id}/change-orders`, send("POST", input));
export const updateChangeOrder = (id: string, changeOrderId: string, patch: Partial<{ description: string; hours: number; rateCents: number; status: ChangeOrderStatus; signedBy: string | null }>) =>
  apiFetch<{ changeOrder: ChangeOrder }>(`/api/deals/${id}/change-orders/${changeOrderId}`, send("PATCH", patch));
