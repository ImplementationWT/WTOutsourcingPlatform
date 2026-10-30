import type { Sealed } from "../lib/server-cipher.js";

// ---- catálogos -----------------------------------------------------------------

/** Etapas del proyecto, en orden. "completed" es para los proyectos que ya salen de la empresa. */
export const PROJECT_STAGES = ["kickoff", "structure", "automation_layer", "stabilization", "maintenance", "no_pending_items", "completed"] as const;
export const HEALTH_SCORES = ["champion", "very_happy", "happy", "mixed", "neutral", "concerned", "escalated", "at_risk"] as const;
export const PRIORITIES = ["critical", "high", "medium", "low"] as const;
export const DEAL_STATUSES = ["draft", "proposed", "approved", "in_progress", "delivered", "invoiced", "paid", "cancelled"] as const;
export const TASK_STATUSES = ["todo", "in_progress", "review", "done"] as const;
export const ACCOUNT_KINDS = ["web", "email", "api", "database", "server", "social", "other"] as const;
export const MEETING_SOURCES = ["read_ai", "manual"] as const;
export const MEETING_STATUSES = ["pending", "processed", "failed"] as const;

export type ProjectStage = (typeof PROJECT_STAGES)[number];
export type HealthScore = (typeof HEALTH_SCORES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type DealStatus = (typeof DEAL_STATUSES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

// ---- documentos ----------------------------------------------------------------

/** Proyecto del cliente (negocio). La app aprovisionada, si existe, se enlaza con `clientSlug`. */
export interface OpsProjectDoc {
  _id: string; // uuid
  name: string;
  customerName: string;
  /** Equipo asignado (Team Leader + Developer). */
  teamId: string;
  leadUserId: string | null;
  developerUserId: string | null;
  /** Slug de la app aprovisionada en Infraestructura, si ya se creó. */
  clientSlug: string | null;
  /** Propuesta (web) con la que arrancó el proyecto. */
  proposalUrl: string | null;
  stage: ProjectStage;
  health: HealthScore;
  /** Entero de 0 a 100. */
  sentimentScore: number;
  priority: Priority;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Trato por funcionalidades o módulos, vendido por horas. */
export interface DealDoc {
  _id: string;
  projectId: string;
  title: string;
  description: string;
  /** Horas vendidas. */
  hours: number;
  /** Tarifa por hora en centavos. */
  rateCents: number;
  /** Siempre horas × tarifa, calculado en el servidor. */
  amountCents: number;
  currency: string;
  status: DealStatus;
  proposalUrl: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  /** Cuándo pasó a "paid" (base de las comisiones, Fase 3). */
  paidAt?: Date;
}

export interface OpsTaskDoc {
  _id: string;
  projectId: string;
  /** Deal al que se imputa la tarea: base de la comisión. */
  dealId: string | null;
  title: string;
  assigneeUserId: string | null;
  estimatedHours: number;
  status: TaskStatus;
  dueDate: string | null; // YYYY-MM-DD
  completedAt?: Date;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Cuenta de un servicio del cliente. El valor secreto solo existe cifrado. */
export interface VaultAccountDoc {
  _id: string;
  projectId: string;
  label: string;
  kind: AccountKind;
  url: string | null;
  username: string | null;
  notes: string;
  /** AES-256-GCM con contexto `vault:<projectId>:<id>`. */
  sealed: Sealed | null;
  rotatedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectUpdateDoc {
  _id: string;
  projectId: string;
  /** "manual": lo escribió una persona. "system": cambio de etapa, salud, etc. */
  kind: "manual" | "system";
  body: string;
  authorUsername: string;
  authorName: string;
  createdAt: Date;
}

export interface MeetingDoc {
  _id: string;
  projectId: string;
  title: string;
  heldAt: Date;
  source: (typeof MEETING_SOURCES)[number];
  /** Id de la reunión en el origen (Read.ai); evita duplicados al reenviar el webhook. */
  externalId: string | null;
  transcript: string;
  summary: string;
  feedback: string[];
  actionItems: string[];
  status: (typeof MEETING_STATUSES)[number];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// ---- reglas de negocio ---------------------------------------------------------

/** Monto de un deal: horas × tarifa en centavos, redondeado. Nunca lo envía el navegador. */
export const dealAmountCents = (hours: number, rateCents: number) => Math.round(hours * rateCents);
