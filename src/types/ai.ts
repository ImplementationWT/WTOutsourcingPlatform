// Contrato de /api/ai (apps/api/src/routes/ai.ts y apps/api/src/ai/events.ts).

export type AiSessionStatus = "active" | "merged" | "closed";
export type AgentState = "running" | "idle" | "waiting" | "budget" | "error" | "refused" | "terminated";

export interface AiSession {
  id: string;
  clientId: string;
  title: string;
  status: AiSessionStatus;
  branch: string;
  baseBranch: string;
  repository: string;
  createdBy: string;
  createdAt: string;
  lastMessageAt: string | null;
  pullRequest: { number: number; url: string; createdAt: string; createdBy: string } | null;
  merge: { sha: string; at: string; by: string } | null;
  closedAt: string | null;
  /** Rastro completo de la sesión en la consola de Anthropic. */
  consoleUrl: string | null;
}

/** Archivo .md adjuntado a un mensaje (Claude lo recibe como documento). */
export interface MarkdownAttachment {
  name: string;
  content: string;
}

export interface AgentUsage {
  status: "rescheduling" | "running" | "idle" | "terminated";
  costCents: number;
  budgetCents: number | null;
}

type Base = { id: string; at: string | null };
export type ChatEvent =
  | (Base & { kind: "user"; text: string; attachments?: string[] })
  | (Base & { kind: "assistant"; text: string })
  | (Base & { kind: "thinking" })
  | (Base & { kind: "tool"; tool: string; summary: string; needsConfirmation: boolean; denied: boolean })
  | (Base & { kind: "tool_result"; toolUseId: string; ok: boolean; output: string })
  | (Base & { kind: "confirmation"; toolUseId: string; allowed: boolean })
  | (Base & { kind: "status"; state: AgentState })
  | (Base & { kind: "error"; message: string })
  | (Base & { kind: "cost"; costCents: number });

export interface DiffFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface BranchDiff {
  aheadBy: number;
  behindBy: number;
  url: string;
  truncated: boolean;
  commits: { sha: string; message: string; author: string | null; date: string | null }[];
  files: DiffFile[];
}

export interface AiReview {
  pullRequest: { number: number; url: string; state: "open" | "closed"; merged: boolean; mergeable: boolean | null; headSha: string } | null;
  checks: { total: number; pending: number; failed: number; checks: { name: string; status: string; conclusion: string | null; url: string | null }[] } | null;
  mainTouched: boolean;
}

export type AiPreviewStatus = "installing" | "building" | "ready" | "failed" | "stopped";

export interface AiPreview {
  status: AiPreviewStatus;
  url: string;
  /** URL del iframe con un pase de un solo uso (solo con status ready). */
  frameUrl: string | null;
  sha: string | null;
  /** La rama tiene commits que la vista previa aún no muestra. */
  outdated: boolean;
  /** Trayendo los últimos cambios de Claude (se aplican en caliente, sin recargar). */
  updating: boolean;
  updateError: string | null;
  requestedAt: string;
  readyAt: string | null;
  expiresAt: string | null;
  error: string | null;
}
