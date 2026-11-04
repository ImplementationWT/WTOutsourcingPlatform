import { useQuery } from "@tanstack/react-query";
import type { Tone } from "@/components/ui/tones";
import { apiFetch } from "@/lib/api-client";

export const KINDS = ["email", "whatsapp", "slack", "call", "other"] as const;
export type Kind = (typeof KINDS)[number];
export const KIND_LABELS: Record<Kind, string> = { email: "Email", whatsapp: "WhatsApp", slack: "Slack", call: "Llamada", other: "Otro" };
export const KIND_TONE: Record<Kind, Tone> = { email: "info", whatsapp: "ok", slack: "accent", call: "warn", other: "neutral" };
export type Direction = "sent" | "received";
export const DIRECTION_LABELS: Record<Direction, string> = { sent: "Enviado", received: "Recibido" };

export interface Communication {
  id: string;
  kind: Kind;
  direction: Direction;
  subject: string;
  body: string;
  owner: { id: string; name: string | null } | null;
  contactName: string;
  date: string;
  project: { id: string; name: string | null } | null;
  lead: { id: string; name: string | null } | null;
  followUpDate: string | null;
  followUpDone: boolean;
}
export interface CommsList {
  communications: Communication[];
  canCreate: boolean;
  people: { id: string; name: string }[];
}
export interface ColdItem {
  kind: "project" | "lead";
  id: string;
  name: string;
  days: number | null;
  since: "contact" | "arrival" | "never";
}
export interface CommsSummary {
  cold: ColdItem[];
  followUpsDue: number;
  lastWeek: number;
}

export const commsKey = ["communications"] as const;
export type CommsScope = { projectId: string } | { leadId: string } | null;
const qs = (scope: CommsScope) => (!scope ? "" : "projectId" in scope ? `?projectId=${scope.projectId}` : `?leadId=${scope.leadId}`);

export const useComms = (scope: CommsScope) => useQuery({ queryKey: [...commsKey, "list", scope ?? "all"], queryFn: () => apiFetch<CommsList>(`/api/communications${qs(scope)}`) });
export const useCommsSummary = (enabled = true) => useQuery({ queryKey: [...commsKey, "summary"], queryFn: () => apiFetch<CommsSummary>("/api/communications/summary"), enabled, staleTime: 30_000 });

export interface CommInput {
  kind: Kind;
  direction: Direction;
  subject: string;
  body: string;
  ownerUserId: string | null;
  contactName: string;
  date: string;
  followUpDate: string | null;
  projectId?: string | null;
  leadId?: string | null;
}
const send = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });
export const commsApi = {
  create: (input: CommInput) => apiFetch<{ communication: Communication }>("/api/communications", send("POST", input)),
  update: (id: string, patch: Partial<CommInput> & { followUpDone?: boolean }) => apiFetch(`/api/communications/${id}`, send("PATCH", patch)),
  remove: (id: string) => apiFetch(`/api/communications/${id}`, send("DELETE")),
  restore: (id: string) => apiFetch(`/api/communications/${id}/restore`, send("POST")),
};

/** Seguimiento: vencido, hoy o próximo (null si no hay o ya se hizo). */
export function followUp(c: Pick<Communication, "followUpDate" | "followUpDone">, today = new Date().toISOString().slice(0, 10)): { text: string; tone: Tone } | null {
  if (!c.followUpDate || c.followUpDone) return null;
  const d = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${c.followUpDate}T00:00:00Z`)) / 86_400_000);
  if (d > 0) return { text: `Seguimiento vencido ${d} d`, tone: "danger" };
  if (d === 0) return { text: "Seguimiento hoy", tone: "warn" };
  return { text: `Seguimiento ${c.followUpDate.slice(8, 10)}/${c.followUpDate.slice(5, 7)}`, tone: "info" };
}
