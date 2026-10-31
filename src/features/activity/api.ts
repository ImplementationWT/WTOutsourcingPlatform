import type { Tone } from "@/components/ui/tones";
import { apiFetch } from "@/lib/api-client";
import { formatDateTime } from "@/lib/format";

// Reuniones y novedades: mismas rutas bajo un proyecto (/api/ops/projects/:id) o un lead
// (/api/sales/leads/:id). `base` es esa ruta.

// ---- catálogos de reuniones (§4.2, los mismos que valida la API) ----------------------

export const MEETING_KINDS = ["discovery", "kickoff", "sprint_review", "alignment", "issue_resolution", "change_discussion", "ad_hoc", "training"] as const;
export const MEETING_REVIEW_STATUSES = ["new", "reviewed", "actioned", "not_needed"] as const;
export const CLIENT_SENTIMENTS = ["excellent", "good", "neutral", "friction"] as const;
export const ACTION_ITEM_KINDS = ["quick_admin", "internal_work", "client_dependency", "build_candidate", "scope_risk"] as const;

export type MeetingKind = (typeof MEETING_KINDS)[number];
export type MeetingReviewStatus = (typeof MEETING_REVIEW_STATUSES)[number];
export type ClientSentiment = (typeof CLIENT_SENTIMENTS)[number];
export type ActionItemKind = (typeof ACTION_ITEM_KINDS)[number];
export type ActionItemStatus = "proposed" | "accepted" | "discarded" | "task" | "change_order" | "activity";
export type Conversion = "task" | "change_order" | "activity";

export const MEETING_KIND_LABELS: Record<MeetingKind, string> = {
  discovery: "Discovery",
  kickoff: "Kickoff",
  sprint_review: "Sprint Review",
  alignment: "Alineación",
  issue_resolution: "Resolución de issues",
  change_discussion: "Change discussion",
  ad_hoc: "Ad-hoc",
  training: "Training",
};
export const REVIEW_STATUS_LABELS: Record<MeetingReviewStatus, string> = { new: "Nueva sin procesar", reviewed: "Revisada", actioned: "Accionada", not_needed: "No necesaria" };
export const CLIENT_SENTIMENT_LABELS: Record<ClientSentiment, string> = { excellent: "Excelente", good: "Bien", neutral: "Neutral", friction: "Fricción" };
export const CLIENT_SENTIMENT_TONE: Record<ClientSentiment, Tone> = { excellent: "ok", good: "ok", neutral: "neutral", friction: "danger" };
export const ACTION_ITEM_KIND_LABELS: Record<ActionItemKind, string> = {
  quick_admin: "Admin rápido",
  internal_work: "Trabajo interno",
  client_dependency: "Dependencia del cliente",
  build_candidate: "Candidato a construir",
  scope_risk: "Riesgo de alcance",
};
export const ACTION_ITEM_STATUS_LABELS: Record<ActionItemStatus, string> = {
  proposed: "Propuesto",
  accepted: "Aceptado",
  discarded: "Descartado",
  task: "Convertido en tarea",
  change_order: "Convertido en change order",
  activity: "Convertido en actividad",
};

export interface ActionItem {
  id: string;
  text: string;
  kind: ActionItemKind | null;
  /** Responsable que mencionó la reunión (texto) y el usuario asignado. */
  ownerName: string | null;
  owner: { id: string; name: string | null } | null;
  projectedHours: number | null;
  phase: string | null;
  status: ActionItemStatus;
  taskId: string | null;
  changeOrderId: string | null;
  activityId: string | null;
}

export interface Meeting {
  id: string;
  title: string;
  heldAt: string;
  source: "read_ai" | "manual";
  kind: MeetingKind | null;
  durationMinutes: number | null;
  url: string | null;
  deal: { id: string; dealCode: string; title: string } | null;
  attendees: { id: string; name: string | null }[];
  participants: { name: string; email: string | null }[];
  /** Estado técnico del procesamiento con Claude. */
  status: "pending" | "processing" | "processed" | "failed";
  /** Estado de proceso que lleva una persona. */
  reviewStatus: MeetingReviewStatus;
  summary: string;
  feedback: string[];
  actionItems: ActionItem[];
  clientSentiment: ClientSentiment | null;
  engagement: MeetingEngagement | null;
  readAi: { summary: string; actionItems: string[]; topics: string[]; keyQuestions: string[] } | null;
  processingError: string | null;
  processedAt: string | null;
  transcriptLength: number;
}

export const MEETING_ENGAGEMENTS = ["low", "neutral", "good", "excellent"] as const;
export type MeetingEngagement = (typeof MEETING_ENGAGEMENTS)[number];
export const ENGAGEMENT_LABELS: Record<MeetingEngagement, string> = { low: "Bajo", neutral: "Neutral", good: "Bueno", excellent: "Excelente" };
export const ENGAGEMENT_TONE: Record<MeetingEngagement, Tone> = { low: "danger", neutral: "neutral", good: "info", excellent: "ok" };

type MeetingRef<T> = T | null;

/** Fila de la tabla de Meetings. */
export interface MeetingRow {
  id: string;
  title: string;
  heldAt: string;
  durationMinutes: number | null;
  source: "read_ai" | "manual";
  status: Meeting["status"];
  engagement: MeetingEngagement | null;
  team: MeetingRef<{ id: string; name: string }>;
  project: MeetingRef<{ id: string; name: string }>;
  lead: MeetingRef<{ id: string; title: string }>;
}

/** Reunión completa para el pop-up de la tabla de Meetings. */
export interface MeetingDetail extends Meeting {
  team: MeetingRef<{ id: string; name: string }>;
  project: MeetingRef<{ id: string; name: string }>;
  lead: MeetingRef<{ id: string; title: string }>;
  candidates: { kind: "project" | "lead"; id: string; name: string }[];
}

export interface ActivityUpdate {
  id: string;
  kind: "manual" | "system";
  body: string;
  authorName: string;
  createdAt: string;
}

export const activityKeys = {
  meetings: (base: string) => ["activity", base, "meetings"] as const,
  updates: (base: string) => ["activity", base, "updates"] as const,
};

const send = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

export const meetingsQuery = (base: string) => ({
  queryKey: activityKeys.meetings(base),
  queryFn: () => apiFetch<{ meetings: Meeting[]; processingAvailable: boolean; conversions: Conversion[] }>(`${base}/meetings`),
  // Mientras haya reuniones procesándose, se refresca sola.
  refetchInterval: (query: { state: { data?: { meetings: Meeting[] } } }) =>
    query.state.data?.meetings.some((m) => m.status === "pending" || m.status === "processing") ? 5000 : false,
});

export const updatesQuery = (base: string) => ({
  queryKey: activityKeys.updates(base),
  queryFn: async () => (await apiFetch<{ updates: ActivityUpdate[] }>(`${base}/updates`)).updates,
});

export const createMeeting = (
  base: string,
  input: { title: string; heldAt: string; kind?: MeetingKind | null; transcript?: string; summary?: string; feedback?: string[]; actionItems?: string[]; url?: string | null; durationMinutes?: number | null },
) => apiFetch<{ meeting: Meeting }>(`${base}/meetings`, send("POST", input));
export const updateMeeting = (
  base: string,
  meetingId: string,
  patch: Partial<{ title: string; kind: MeetingKind | null; reviewStatus: MeetingReviewStatus; clientSentiment: ClientSentiment | null; dealId: string | null; attendeeContactIds: string[]; summary: string }>,
) => apiFetch<{ meeting: Meeting }>(`${base}/meetings/${meetingId}`, send("PATCH", patch));
export const updateActionItem = (
  base: string,
  meetingId: string,
  itemId: string,
  patch: Partial<{ text: string; kind: ActionItemKind | null; ownerUserId: string | null; projectedHours: number | null; phase: string | null; status: "proposed" | "accepted" | "discarded" }>,
) => apiFetch<{ meeting: Meeting }>(`${base}/meetings/${meetingId}/action-items/${itemId}`, send("PATCH", patch));
export const convertActionItem = (
  base: string,
  meetingId: string,
  itemId: string,
  input: { to: Conversion; dealId?: string; title?: string; hours?: number; assigneeUserId?: string | null; dueDate?: string | null },
) => apiFetch<{ created: { id: string; label: string }; meeting: Meeting }>(`${base}/meetings/${meetingId}/action-items/${itemId}/convert`, send("POST", input));

// ---- tabla de Meetings ------------------------------------------------------------

export const MEETING_FILTERS = ["teamId", "engagement"] as const;
export const meetingsTableKey = ["activity", "meetings-table"] as const;
export const meetingKey = (id: string) => ["activity", "meeting", id] as const;
export const meetingDetailQuery = (id: string) => ({
  queryKey: meetingKey(id),
  queryFn: () => apiFetch<{ meeting: MeetingDetail; permissions: { assign: boolean; team: boolean; discard: boolean } }>(`/api/meetings/${id}`),
});
export const assignMeeting = (id: string, target: { projectId: string } | { leadId: string }) =>
  apiFetch<{ ok: true; assigned: { kind: "project" | "lead"; id: string } }>(`/api/meetings/${id}/assign`, send("POST", target));
export const setMeetingTeam = (id: string, teamId: string | null) => apiFetch<{ ok: true }>(`/api/meetings/${id}`, send("PATCH", { teamId }));
export const discardMeeting = (id: string) => apiFetch<{ ok: true }>(`/api/meetings/${id}`, send("DELETE"));

export const processMeeting = (base: string, meetingId: string) => apiFetch<{ meeting: Meeting }>(`${base}/meetings/${meetingId}/process`, send("POST"));
export const createUpdate = (base: string, body: string) => apiFetch<{ update: ActivityUpdate }>(`${base}/updates`, send("POST", { body }));

/** Fecha y hora con el formato único del panel. */
export const dateText = (iso: string) => formatDateTime(iso);
