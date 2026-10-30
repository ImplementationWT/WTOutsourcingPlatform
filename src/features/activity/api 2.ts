import { apiFetch } from "@/lib/api-client";

// Reuniones y novedades: mismas rutas bajo un proyecto (/api/ops/projects/:id) o un lead
// (/api/sales/leads/:id). `base` es esa ruta.

export interface Meeting {
  id: string;
  title: string;
  heldAt: string;
  source: "read_ai" | "manual";
  status: "pending" | "processing" | "processed" | "failed";
  summary: string;
  feedback: string[];
  actionItems: string[];
  /** Sentimiento del cliente (0–100) que propone el procesamiento. */
  sentimentSignal: number | null;
  processingError: string | null;
  processedAt: string | null;
  transcriptLength: number;
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
  queryFn: () => apiFetch<{ meetings: Meeting[]; processingAvailable: boolean }>(`${base}/meetings`),
  // Mientras haya reuniones procesándose, se refresca sola.
  refetchInterval: (query: { state: { data?: { meetings: Meeting[] } } }) =>
    query.state.data?.meetings.some((m) => m.status === "pending" || m.status === "processing") ? 5000 : false,
});

export const updatesQuery = (base: string) => ({
  queryKey: activityKeys.updates(base),
  queryFn: async () => (await apiFetch<{ updates: ActivityUpdate[] }>(`${base}/updates`)).updates,
});

export const createMeeting = (base: string, input: { title: string; heldAt: string; transcript?: string; summary?: string; feedback?: string[]; actionItems?: string[] }) =>
  apiFetch<{ meeting: Meeting }>(`${base}/meetings`, send("POST", input));
export const processMeeting = (base: string, meetingId: string) => apiFetch<{ meeting: Meeting }>(`${base}/meetings/${meetingId}/process`, send("POST"));
export const createUpdate = (base: string, body: string) => apiFetch<{ update: ActivityUpdate }>(`${base}/updates`, send("POST", { body }));

export const dateText = (iso: string) => new Date(iso).toLocaleString("es-PE", { dateStyle: "medium", timeStyle: "short" });
