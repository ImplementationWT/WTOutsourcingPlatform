import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Tone } from "@/components/ui/tones";
import { apiFetch } from "@/lib/api-client";
import { errorText, toast } from "@/lib/toast";
import type { PaymentType } from "@/features/ops/api";

export const INVOICE_STAGES = ["overdue", "follow_up", "due", "pending", "invoiced", "upcoming", "paid"] as const;
export type InvoiceStage = (typeof INVOICE_STAGES)[number];
export const INVOICE_STAGE_LABELS: Record<InvoiceStage, string> = { overdue: "Overdue", follow_up: "Follow Up", due: "Due", pending: "Pending", invoiced: "Invoiced", upcoming: "Upcoming", paid: "Paid" };
export const INVOICE_STAGE_TONE: Record<InvoiceStage, Tone> = { overdue: "danger", follow_up: "primary", due: "warn", pending: "neutral", invoiced: "info", upcoming: "accent", paid: "ok" };

export interface Invoice {
  id: string;
  number: string;
  month: string;
  stage: InvoiceStage;
  /** Pending de un mes futuro = Upcoming. */
  effectiveStage: InvoiceStage;
  invoicedDate: string | null;
  paidDate: string | null;
  sustained: boolean;
  project: { id: string; name: string | null };
  deal: { id: string; code: string; title: string } | null;
  lead: { id: string; name: string | null } | null;
  paymentType: PaymentType | null;
  hours: number;
  rateCents: number;
  grossCents: number;
  feeCents: number;
  totalCents: number;
  currency: string;
}
export interface InvoiceProject {
  id: string;
  name: string;
  deals: { id: string; code: string; title: string; rateCents: number }[];
}
export interface InvoicesData {
  invoices: Invoice[];
  projects: InvoiceProject[];
}
export type InvoicePatch = Partial<{ month: string; stage: InvoiceStage; invoicedDate: string | null; paidDate: string | null; sustained: boolean; projectId: string; dealId: string | null; hours: number; feeCents: number }>;

export const invoicesKey = ["finance", "invoices"] as const;
export const useInvoices = () => useQuery({ queryKey: invoicesKey, queryFn: () => apiFetch<InvoicesData>("/api/invoices") });

const send = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });
export const invoicesApi = {
  create: (input: InvoicePatch & { projectId: string }) => apiFetch<{ invoice: Invoice }>("/api/invoices", send("POST", input)),
  update: (id: string, patch: InvoicePatch) => apiFetch<{ invoice: Invoice }>(`/api/invoices/${id}`, send("PATCH", patch)),
  remove: (id: string) => apiFetch(`/api/invoices/${id}`, send("DELETE")),
  restore: (id: string) => apiFetch(`/api/invoices/${id}/restore`, send("POST")),
};

/** Ejecuta y refresca Financiera (y los proyectos, que muestran horas pagadas). */
export function useFinanceAction() {
  const queryClient = useQueryClient();
  return async <T,>(action: () => Promise<T>, failure = "No se pudo guardar el cambio.") => {
    try {
      const r = await action();
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["finance"] }), queryClient.invalidateQueries({ queryKey: ["ops"] })]);
      return r;
    } catch (err) {
      toast.error(failure, { description: errorText(err, "Inténtalo de nuevo.") });
      return null;
    }
  };
}

export const MONTHS = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
export const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
