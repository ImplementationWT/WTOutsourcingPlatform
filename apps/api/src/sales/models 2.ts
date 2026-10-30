import type { MeetingCore } from "../ops/models.js";

// ---- catálogos -----------------------------------------------------------------

/** Embudo del lead. "won" solo se alcanza al convertirlo en cliente. */
export const LEAD_STATUSES = ["new", "contacted", "demo", "proposal_sent", "won", "lost"] as const;
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
  ownerUserId: string | null;
  lostReason: string | null;
  customerId: string | null;
  projectId: string | null;
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
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
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

// ---- reglas de negocio ---------------------------------------------------------

/** Orden del embudo: una demo o una propuesta adelantan el lead, nunca lo atrasan. */
export const advanceTo = (current: LeadStatus, next: LeadStatus): LeadStatus => {
  if (current === "won" || current === "lost") return current;
  return LEAD_STATUSES.indexOf(next) > LEAD_STATUSES.indexOf(current) ? next : current;
};
