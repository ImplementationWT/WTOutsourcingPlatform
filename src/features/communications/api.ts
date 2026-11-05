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
  /** Manual o sincronizado desde el Gmail de `owner`. */
  source: "manual" | "gmail";
  email: { from: string; to: string[]; cc: string[]; sentAt: string | null; threadId: string | null; matchedBy: "contact" | "lead" | "thread" | "domain" | "manual" | null; sentFromApp: boolean } | null;
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

export const useThread = (id: string | null) => useQuery({ queryKey: [...commsKey, "thread", id], queryFn: () => apiFetch<{ communications: Communication[] }>(`/api/communications/${id}/thread`), enabled: Boolean(id) });

// ---- Gmail del usuario (siempre el buzón propio: /api/me/mail) ----

export interface MailConnection {
  email: string;
  status: "active" | "error" | "disconnected";
  lastSyncAt: string | null;
  lastError: string | null;
  push: boolean;
}
export interface MyMail {
  /** El servidor tiene configurada la integración. */
  available: boolean;
  pushEnabled: boolean;
  /** Correo corporativo del usuario (null si no tiene uno del dominio). */
  email: string | null;
  canConnect: boolean;
  connection: MailConnection | null;
}
export const mailKey = ["me", "mail"] as const;
export const useMyMail = () => useQuery({ queryKey: mailKey, queryFn: () => apiFetch<MyMail>("/api/me/mail"), staleTime: 30_000 });
/** El usuario tiene su Gmail conectado y puede enviar. */
export const mailReady = (m: MyMail | undefined) => Boolean(m?.connection && m.connection.status !== "disconnected");

export interface SendInput {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  projectId?: string | null;
  leadId?: string | null;
  replyToId?: string | null;
}
export const mailApi = {
  connect: () => apiFetch<{ connection: MailConnection }>("/api/me/mail/connect", send("POST")),
  disconnect: () => apiFetch("/api/me/mail/disconnect", send("POST")),
  sync: () => apiFetch<{ connection: MailConnection }>("/api/me/mail/sync", send("POST")),
  send: (input: SendInput) => apiFetch<{ messageId: string; threadId: string; communicationId: string | null }>("/api/me/mail/send", send("POST", input)),
};

/** «a@x.com, b@y.com; c@z.com» → lista de correos. */
export const splitEmails = (text: string) => text.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
