import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { formatMoney } from "@/lib/format";

export interface CostBucket {
  costCents: number;
  sessions: number;
  mergedPrs: number;
  costPerMergedPrCents: number | null;
}

export interface CostSummary {
  scope: "boss" | "lead" | "developer";
  currency: "USD";
  listPrice: true;
  totals: CostBucket;
  byMonth: (CostBucket & { month: string })[];
  byTeam: (CostBucket & { teamId: string | null; name: string })[];
  byProject: (CostBucket & { clientId: string; name: string; teamName: string | null })[];
  byPerson: (CostBucket & { name: string; username: string })[];
}

export interface CostSessionRow {
  id: string;
  createdAt: string;
  month: string;
  clientId: string;
  project: string;
  team: string;
  person: string;
  username: string;
  title: string;
  status: "active" | "merged" | "closed";
  merged: boolean;
  pullRequest: number | null;
  costCents: number;
  deleted: boolean;
}

export interface CostRange {
  from: string;
  to: string;
}

/** Parámetros de la API: rango (AAAA-MM-DD, `to` incluido). */
export function costQuery(range: CostRange) {
  const params = new URLSearchParams();
  if (range.from) params.set("from", range.from);
  if (range.to) params.set("to", range.to);
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function useCostSummary(range: CostRange) {
  const query = costQuery(range);
  return useQuery({ queryKey: ["costs", "summary", query], queryFn: () => apiFetch<CostSummary>(`/api/costs/summary${query}`) });
}

export function useCostSessions(range: CostRange, enabled = true) {
  const query = costQuery(range);
  return useQuery({
    queryKey: ["costs", "sessions", query],
    queryFn: async () => (await apiFetch<{ sessions: CostSessionRow[] }>(`/api/costs/sessions${query}`)).sessions,
    enabled,
  });
}

/** Centavos de USD → "USD 12.34", el mismo formato que el resto del panel. */
export const formatUsd = (cents: number | null | undefined) => formatMoney(cents, "USD");

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
/** "2026-09" → "sep 2026". */
export const monthLabel = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1] ?? month.slice(5, 7)} ${month.slice(0, 4)}`;
