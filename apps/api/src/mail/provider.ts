/**
 * Contrato de un proveedor de correo (hoy Gmail; mañana Outlook/Microsoft Graph). El resto del
 * módulo (sincronización, matching, rutas) solo habla con estas interfaces.
 */

/** Mensaje tal como lo entrega el proveedor (sin parsear). */
export interface RawMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  /** Milisegundos desde epoch. */
  internalDate: number;
  headers: Record<string, string>;
  /** Texto plano del cuerpo (ya decodificado; si solo había HTML, convertido a texto). */
  text: string;
}

/** Cambios desde un punto del historial: ids de mensajes nuevos y el nuevo punto. */
export interface MailboxChanges {
  messageIds: string[];
  cursor: string;
}

/** Buzón de una persona (actúa en su nombre: lo que ve y envía es suyo). */
export interface Mailbox {
  /** Dirección real del buzón y el punto actual de su historial. */
  profile(): Promise<{ email: string; cursor: string }>;
  /** Mensajes nuevos desde `cursor`. Lanza MailError("cursor_expired") si el punto es muy viejo. */
  changes(cursor: string): Promise<MailboxChanges>;
  /** Ids de los mensajes recientes (recuperación y carga inicial). */
  recent(days: number, max: number): Promise<string[]>;
  message(id: string): Promise<RawMessage>;
  /** Envía un MIME ya armado; con threadId lo deja en ese hilo. */
  send(mime: string, threadId?: string): Promise<{ id: string; threadId: string }>;
  /** Avisos push (Gmail watch → Pub/Sub). Devuelve cuándo vence. */
  watch(topic: string): Promise<{ cursor: string; expiresAt: Date }>;
  stopWatch(): Promise<void>;
}

export interface MailProvider {
  readonly name: "gmail";
  mailbox(email: string): Mailbox;
}

export type MailErrorCode =
  | "base_auth" // la credencial base del backend no sirve (vencida o revocada)
  | "sign_denied" // la identidad base no puede firmar como la Service Account
  | "delegation_denied" // la delegación de dominio no autoriza a la Service Account o sus scopes
  | "mailbox_unavailable" // el buzón no existe, está suspendido o no tiene Gmail
  | "cursor_expired" // el punto del historial ya no existe: hay que recargar lo reciente
  | "provider"; // cualquier otra respuesta del proveedor

/** Error del proveedor con un mensaje para el panel (nunca incluye tokens ni respuestas crudas). */
export class MailError extends Error {
  constructor(
    readonly code: MailErrorCode,
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "MailError";
  }
}
