import type { MeetingCore } from "../ops/models.js";

// ---- catálogos -----------------------------------------------------------------

/**
 * Etapa común del lead (§3). "won" solo se alcanza al convertirlo en cliente. `nurturing` y
 * `unqualified` (más `lost`) forman la vista de leads fríos ("Cold Leads" de Monday).
 */
export const LEAD_STATUSES = ["new", "contacted", "demo", "proposal_sent", "won", "lost", "nurturing", "unqualified"] as const;
/** Leads activos y fríos: una sola tabla, dos vistas. */
export const ACTIVE_LEAD_STATUSES = ["new", "contacted", "demo", "proposal_sent"] as const;
export const COLD_LEAD_STATUSES = ["nurturing", "unqualified", "lost"] as const;
/** Funnel de origen (§4.1). */
export const LEAD_FUNNELS = ["lht", "upwork", "guide", "outreach", "aitp", "other"] as const;
export const LEAD_TEMPERATURES = ["hot", "warm", "nurturing"] as const;
export const PARTNER_KINDS = ["referral", "agency", "platform", "consultant", "other"] as const;
export const ACTIVITY_KINDS = ["call", "email", "meeting", "follow_up", "task", "other"] as const;
export const ACTIVITY_STATUSES = ["pending", "done", "cancelled"] as const;
export const DEMO_STATUSES = ["scheduled", "done", "cancelled", "no_show"] as const;
export const PROPOSAL_STATUSES = ["draft", "sent", "accepted", "rejected"] as const;
export const SOURCE_KINDS = ["webhook", "form", "manual", "import"] as const;
/** Campos del lead que se pueden llenar desde los datos de un source. */
export const LEAD_FIELDS = ["company", "contactName", "email", "phone", "notes", "externalId"] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];
export type DemoStatus = (typeof DEMO_STATUSES)[number];
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
export type SourceKind = (typeof SOURCE_KINDS)[number];
export type LeadField = (typeof LEAD_FIELDS)[number];
export type LeadFunnel = (typeof LEAD_FUNNELS)[number];
export type LeadTemperature = (typeof LEAD_TEMPERATURES)[number];
export type PartnerKind = (typeof PARTNER_KINDS)[number];
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

// ---- documentos ----------------------------------------------------------------

/** Origen de leads (web, ads, formularios…). Cada uno manda datos distintos: se mapean aquí. */
export interface LeadSourceDoc {
  _id: string;
  name: string;
  kind: SourceKind;
  /** SHA-256 de la clave de ingesta; la clave solo se muestra al crearla o rotarla. */
  ingestKeyHash: string | null;
  /** Últimos 4 caracteres, para reconocerla. */
  keyHint: string | null;
  /** Campo del origen (ruta con puntos, p. ej. "contact.mail") → campo del lead. */
  mapping: { from: string; to: LeadField }[];
  active: boolean;
  received: number;
  lastReceivedAt: Date | null;
  /** Campos vistos en el último envío: ayudan a armar el mapeo. */
  sampleKeys: string[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface LeadDoc {
  _id: string;
  sourceId: string | null;
  sourceName: string;
  /** Id del lead en el origen (si se mapeó): evita duplicarlo al reenviarlo. */
  externalId: string | null;
  status: LeadStatus;
  company: string;
  contactName: string;
  email: string | null;
  phone: string | null;
  notes: string;
  /** Todos los datos recibidos, ya aplanados (clave con puntos → texto). */
  fields: { key: string; value: string }[];
  /** El cuerpo original tal como llegó (JSON en texto, con tope de tamaño). */
  rawJson: string | null;
  /** Responsables (§4.1): el Setter agenda la reunión y el Closer cierra la venta. */
  setterUserId?: string | null;
  closerUserId?: string | null;
  /** Responsable de la v1; la migración lo pasa a `closerUserId`. */
  ownerUserId?: string | null;
  funnel?: LeadFunnel | null;
  temperature?: LeadTemperature | null;
  /** Fecha en que llegó el formulario o el contacto (AAAA-MM-DD). */
  submittedAt?: string | null;
  /** Fecha de la primera reunión (AAAA-MM-DD); la respuesta en días se calcula. */
  meetingAt?: string | null;
  proposalUrl?: string | null;
  lostReason: string | null;
  customerId: string | null;
  projectId: string | null;
  /** Contacto y Empresa del núcleo compartido (se enlazan a mano o al convertir el lead). */
  contactId?: string | null;
  companyId?: string | null;
  dealId?: string | null;
  mondayId?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DemoDoc {
  _id: string;
  leadId: string;
  title: string;
  scheduledAt: Date;
  url: string | null;
  notes: string;
  status: DemoStatus;
  /** Aprendizajes de la demo (§4.1): texto ligado a la demo. */
  learnings?: { _id: string; text: string; authorName: string; createdAt: Date }[];
  mondayId?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Partner que origina deals; su comisión es aparte (§5.2): comisión % × valor del deal. */
export interface PartnerDoc {
  _id: string;
  name: string;
  kind: PartnerKind;
  /** Comisión por defecto (%) que toman sus deals nuevos. */
  commissionPct: number;
  contactId: string | null;
  notes: string;
  active: boolean;
  mondayId?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Actividad comercial ("Commercial Tasks" de Monday), ligada a un lead o a un deal. */
export interface ActivityDoc {
  _id: string;
  title: string;
  kind: ActivityKind;
  ownerUserId: string | null;
  dueDate: string | null; // AAAA-MM-DD
  status: ActivityStatus;
  leadId: string | null;
  dealId: string | null;
  notes: string;
  completedAt?: Date;
  mondayId?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Catálogo de productos que se cotizan (Products DB). */
export interface ProductDoc {
  _id: string;
  name: string;
  description: string;
  /** Tarifa por hora sugerida, en centavos. */
  defaultRateCents: number;
  active: boolean;
  mondayId?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Casos de uso (Use Cases) que respaldan las cotizaciones. */
export interface UseCaseDoc {
  _id: string;
  title: string;
  description: string;
  industry: string | null;
  productId: string | null;
  mondayId?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Línea de una cotización: producto × horas × tarifa; el subtotal lo calcula el servidor. */
export interface ProposalLineDoc {
  _id: string;
  productId: string | null;
  description: string;
  hours: number;
  rateCents: number;
  subtotalCents: number;
}

/** Propuesta (web). Nace en Comercial (lead) o en Operativa (proyecto, opcionalmente un deal). */
export interface ProposalDoc {
  _id: string;
  leadId: string | null;
  projectId: string | null;
  dealId: string | null;
  title: string;
  url: string;
  amountCents: number | null;
  currency: string;
  status: ProposalStatus;
  area: "commercial" | "operations";
  /** Con líneas, el monto es la suma de sus subtotales (calc). */
  lines?: ProposalLineDoc[];
  useCaseIds?: string[];
  mondayId?: string;
  sentAt?: Date;
  decidedAt?: Date;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Cliente: nace al convertir un lead ganado. */
export interface CustomerDoc {
  _id: string;
  name: string;
  contactName: string;
  email: string | null;
  phone: string | null;
  leadId: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface LeadUpdateDoc {
  _id: string;
  leadId: string;
  kind: "manual" | "system";
  body: string;
  authorUsername: string;
  authorName: string;
  createdAt: Date;
}

export interface LeadMeetingDoc extends MeetingCore {
  leadId: string;
}

/** Bitácora comercial de un deal (§4.1: updates por lead/deal). */
export interface DealUpdateDoc {
  _id: string;
  dealId: string;
  kind: "manual" | "system";
  body: string;
  authorUsername: string;
  authorName: string;
  createdAt: Date;
}

// ---- reglas de negocio ---------------------------------------------------------

/**
 * Orden del embudo: una demo o una propuesta adelantan el lead, nunca lo atrasan. Un lead frío
 * vuelve al embudo activo con una demo o una propuesta (una nota sola no lo mueve).
 */
export const advanceTo = (current: LeadStatus, next: LeadStatus): LeadStatus => {
  if (current === "won" || current === "lost") return current;
  if (current === "nurturing" || current === "unqualified") return next === "contacted" ? current : next;
  return ACTIVE_LEAD_STATUSES.indexOf(next as (typeof ACTIVE_LEAD_STATUSES)[number]) > ACTIVE_LEAD_STATUSES.indexOf(current as (typeof ACTIVE_LEAD_STATUSES)[number]) ? next : current;
};

/** Días entre la llegada del lead y su primera reunión (calc); null si falta alguna fecha. */
export function responseDays(submittedAt: string | null | undefined, meetingAt: string | null | undefined) {
  if (!submittedAt || !meetingAt) return null;
  return Math.round((Date.parse(`${meetingAt}T00:00:00Z`) - Date.parse(`${submittedAt}T00:00:00Z`)) / 86_400_000);
}

/** Subtotal de una línea y monto de una cotización (calc). */
export const lineSubtotalCents = (hours: number, rateCents: number) => Math.round(hours * rateCents);
export const linesTotalCents = (lines: Pick<ProposalLineDoc, "subtotalCents">[]) => lines.reduce((sum, l) => sum + l.subtotalCents, 0);
