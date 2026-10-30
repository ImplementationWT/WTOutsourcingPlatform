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
export const MEETING_STATUSES = ["pending", "processing", "processed", "failed"] as const;
/** Etapa comercial del deal (estadoVenta), aparte del estado operativo. */
export const SALES_STAGES = ["new", "discovery", "demo", "proposal", "negotiation", "confirmed", "won", "lost", "ghosted", "on_hold"] as const;
export const SALE_TYPES = ["new_project", "upsell", "change_order"] as const;
export const CHANGE_ORDER_STATUSES = ["draft", "proposed", "approved", "rejected", "canceled"] as const;
export const PAYMENT_TYPES = ["upwork", "stripe", "direct_pe", "direct_us", "paypal", "revolut"] as const;
export const NEXT_ACTIONS = ["contact", "follow_up", "prepare_proposal", "internal_review", "none"] as const;

export type ProjectStage = (typeof PROJECT_STAGES)[number];
export type HealthScore = (typeof HEALTH_SCORES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type DealStatus = (typeof DEAL_STATUSES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type AccountKind = (typeof ACCOUNT_KINDS)[number];
export type SalesStage = (typeof SALES_STAGES)[number];
export type SaleType = (typeof SALE_TYPES)[number];
export type ChangeOrderStatus = (typeof CHANGE_ORDER_STATUSES)[number];
export type PaymentType = (typeof PAYMENT_TYPES)[number];
export type NextAction = (typeof NEXT_ACTIONS)[number];

/** Sentiment derivado del Health (sección 3 del documento): no se escribe a mano. */
export const SENTIMENT_BY_HEALTH: Record<HealthScore, number> = {
  champion: 100,
  very_happy: 90,
  happy: 80,
  mixed: 65,
  neutral: 55,
  concerned: 40,
  at_risk: 20,
  escalated: 10
};
export const sentimentOf = (health: HealthScore) => SENTIMENT_BY_HEALTH[health];

/** Deals que cuentan como vendidos para las horas del proyecto (aprobados en adelante, sin cancelar). */
export const SOLD_DEAL_STATUSES: readonly DealStatus[] = ["approved", "in_progress", "delivered", "invoiced", "paid"];

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
  /** Empresa cliente (Empresas); `customerName` guarda su nombre para mostrarlo sin consultarla. */
  companyId?: string | null;
  /** Clientes de la Fase 1 (migrados a Empresas con el mismo id). */
  customerId?: string | null;
  leadId?: string | null;
  contactIds?: string[];
  stage: ProjectStage;
  health: HealthScore;
  /** Fase 1: se escribía a mano. Hoy el Sentiment se deriva del Health (`sentimentOf`). */
  sentimentScore?: number;
  priority: Priority;
  kickoffDate?: string | null; // YYYY-MM-DD
  /** Project Plan y SOW: enlaces a los archivos (no hay almacenamiento de archivos aún). */
  projectPlanUrl?: string | null;
  sowUrl?: string | null;
  paymentType?: PaymentType | null;
  nextAction?: NextAction | null;
  mondayId?: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Change order: cambio de alcance sobre un deal (horas y tarifa propias). */
export interface ChangeOrderDoc {
  _id: string;
  description: string;
  hours: number;
  rateCents: number;
  /** Horas × tarifa, calculado en el servidor. */
  amountCents: number;
  status: ChangeOrderStatus;
  approvedAt: Date | null;
  /** Quién firmó la aprobación (nombre). */
  signedBy: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Deal: la tabla puente entre Comercial y Operativa. Nace sin proyecto (Comercial) y se liga a uno
 * al ganarse. `teamId` repite el equipo del proyecto para el aislamiento por equipo.
 */
export interface DealDoc {
  _id: string;
  /** DL-0001, autoincremental. */
  dealCode: string;
  projectId: string | null;
  teamId: string | null;
  leadId: string | null;
  /** Partners llega en el paso 3: el campo ya existe para la migración. */
  partnerId: string | null;
  contactIds: string[];
  ownerUserId: string | null;
  title: string;
  description: string;
  salesStage: SalesStage;
  status: DealStatus;
  /** Horas vendidas. */
  hours: number;
  /** Tarifa por hora en centavos. */
  rateCents: number;
  /** Valor: siempre horas × tarifa, calculado en el servidor. */
  amountCents: number;
  /** Probabilidad de cierre, 0 a 100. */
  probability: number;
  /** Valor × probabilidad, calculado en el servidor. */
  projectedCents: number;
  currency: string;
  expectedCloseDate: string | null; // YYYY-MM-DD
  actualCloseDate: string | null;
  saleType: SaleType | null;
  product: string | null;
  channel: string | null;
  lostReason: string | null;
  partnerCommissionPct: number | null;
  proposalUrl: string | null;
  /** SOW: enlace al archivo. */
  sowUrl: string | null;
  changeOrders: ChangeOrderDoc[];
  mondayId?: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  /** Cuándo pasó a "paid" (base de las comisiones). */
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

/** Reunión de un proyecto (Operativa) o de un lead (Comercial): mismo formato y procesamiento. */
export interface MeetingCore {
  _id: string;
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
  /** Sentimiento del cliente (0–100) que propone el procesamiento; no cambia el proyecto solo. */
  sentimentSignal?: number | null;
  /** Motivo del último fallo de procesamiento, sin detalles internos. */
  processingError?: string | null;
  processedAt?: Date;
  usage?: { inputTokens: number; outputTokens: number };
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MeetingDoc extends MeetingCore {
  projectId: string;
}

// ---- reglas de negocio ---------------------------------------------------------

/** Monto de un deal: horas × tarifa en centavos, redondeado. Nunca lo envía el navegador. */
export const dealAmountCents = (hours: number, rateCents: number) => Math.round(hours * rateCents);

/** Valor proyectado: valor × probabilidad. */
export const projectedCents = (amountCents: number, probability: number) => Math.round((amountCents * probability) / 100);

/** "DL-0001" a partir del número de la secuencia. */
export const dealCodeOf = (n: number) => `DL-${String(n).padStart(4, "0")}`;
