import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { SessionUser } from "../auth/users.js";
import type { CommunicationDoc } from "../routes/communications.js";
import type { AdminStore } from "../store/admin-store.js";
import { matchCustomer, type CustomerMatch } from "./matching.js";
import { MODULE_ACCESS } from "../auth/modules.js";
import { addresses, buildMime, displayName, domainOf, htmlToText, replySubject } from "./message.js";
import { MailError, type Mailbox, type MailProvider, type RawMessage } from "./provider.js";

/** Buzón conectado de una persona. Una por usuario; el buzón es siempre el correo de su cuenta. */
export interface MailConnectionDoc {
  _id: string;
  userId: string;
  provider: "gmail";
  email: string;
  status: "active" | "error" | "disconnected";
  /** Punto del historial de Gmail hasta donde ya se procesó. */
  cursor: string | null;
  lastSyncAt: Date | null;
  lastError: string | null;
  watchExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MailConfig {
  /** Dominio de las cuentas corporativas (whatever.tech): solo esas se conectan. */
  domain: string;
  /** Tópico de Pub/Sub para los avisos push (projects/<p>/topics/<t>); sin él, solo sondeo. */
  topic?: string;
  /** Días de correo que se cargan al conectar. */
  backfillDays?: number;
}

/** Etiquetas que nunca se registran. */
const SKIP_LABELS = new Set(["SPAM", "TRASH", "DRAFT", "CHAT"]);
const MAX_BODY = 20_000;
/** La firma se relee de Gmail cada 10 minutos (si la persona la cambia, se nota pronto). */
const SIGNATURE_TTL_MS = 10 * 60_000;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Sugerencia de destinatario: de dónde sale (para mostrarlo) y su nombre si se conoce. */
export interface RecipientSuggestion {
  email: string;
  name: string | null;
  source: "history" | "contact" | "lead" | "team";
}

export class MailServiceError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/**
 * Sincroniza y envía correos del buzón de cada persona. Reglas de aislamiento:
 * - El buzón se resuelve SIEMPRE desde el usuario autenticado (su correo de la app); nunca llega
 *   como parámetro.
 * - Solo se guardan los correos que coinciden con un cliente (contacto, lead o hilo ya asociado);
 *   los demás ni se guardan ni se registran.
 */
export class MailService {
  readonly connections;
  readonly comms;
  private readonly running = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private readonly signatures = new Map<string, { html: string | null; at: number }>();

  constructor(
    readonly store: AdminStore,
    readonly provider: MailProvider | undefined,
    private readonly config: MailConfig,
    private readonly log: FastifyBaseLogger
  ) {
    this.connections = store.db.collection<MailConnectionDoc>("mail_connections");
    this.comms = store.db.collection<CommunicationDoc>("core_communications");
  }

  async init() {
    await Promise.all([
      this.connections.createIndex({ userId: 1 }, { unique: true }),
      this.connections.createIndex({ email: 1 }),
      // Un mensaje de Gmail entra una sola vez por buzón (aunque llegue por push y por sondeo).
      this.comms.createIndex({ ownerUserId: 1, providerMessageId: 1 }, { unique: true, partialFilterExpression: { providerMessageId: { $type: "string" } }, name: "one_message_per_mailbox" }),
      this.comms.createIndex({ ownerUserId: 1, providerThreadId: 1 }, { partialFilterExpression: { providerThreadId: { $type: "string" } } })
    ]);
  }

  get available() {
    return Boolean(this.provider);
  }
  get pushEnabled() {
    return Boolean(this.provider && this.config.topic);
  }

  /** Correo corporativo del usuario (de la app), o null si no tiene o no es del dominio. */
  async corporateEmail(userId: string) {
    const user = await this.store.users.findOne({ _id: userId, active: true }, { projection: { email: 1 } });
    const email = user?.email?.trim().toLowerCase();
    return email && domainOf(email) === this.config.domain.toLowerCase() ? email : null;
  }

  connectionOf(userId: string) {
    return this.connections.findOne({ userId });
  }

  private mailbox(email: string): Mailbox {
    if (!this.provider) throw new MailServiceError(503, "La integración con Gmail no está configurada en el servidor.");
    return this.provider.mailbox(email);
  }

  /** Conecta el buzón del usuario: prueba la cadena de delegación, guarda el punto de partida y carga lo reciente. */
  async connect(user: SessionUser) {
    const email = await this.corporateEmail(user.id);
    if (!email) throw new MailServiceError(400, `Tu usuario no tiene un correo @${this.config.domain}. Pide a un CEO/CCO que lo agregue en Usuarios.`);
    const box = this.mailbox(email);
    let profile: { email: string; cursor: string };
    try {
      profile = await box.profile();
    } catch (error) {
      throw this.asServiceError(error);
    }
    if (profile.email !== email) throw new MailServiceError(409, "Google devolvió otro buzón; revisa el alias de la cuenta.");
    const at = new Date();
    let cursor = profile.cursor;
    let watchExpiresAt: Date | null = null;
    if (this.config.topic) {
      try {
        const w = await box.watch(this.config.topic);
        cursor = w.cursor;
        watchExpiresAt = w.expiresAt;
      } catch (error) {
        // Sin push sigue funcionando por sondeo; se registra para revisarlo.
        this.log.warn({ code: error instanceof MailError ? error.code : "unknown", status: error instanceof MailError ? error.status : undefined }, "gmail watch failed");
      }
    }
    await this.connections.updateOne(
      { userId: user.id },
      { $set: { provider: "gmail", email, status: "active", cursor, lastError: null, watchExpiresAt, updatedAt: at }, $setOnInsert: { _id: randomUUID(), userId: user.id, lastSyncAt: null, createdAt: at } },
      { upsert: true }
    );
    await this.store.audit({ actor: user.username, action: "mail.connected", clientId: `user:${user.id}`, target: email });
    // Carga inicial en segundo plano: los correos recientes con clientes.
    this.kick(user.id, { backfill: true });
    return (await this.connectionOf(user.id))!;
  }

  async disconnect(user: SessionUser) {
    const conn = await this.connectionOf(user.id);
    if (!conn || conn.status === "disconnected") return conn;
    if (this.provider && conn.watchExpiresAt) await this.provider.mailbox(conn.email).stopWatch().catch(() => undefined);
    await this.connections.updateOne({ _id: conn._id }, { $set: { status: "disconnected", watchExpiresAt: null, updatedAt: new Date() } });
    await this.store.audit({ actor: user.username, action: "mail.disconnected", clientId: `user:${user.id}`, target: conn.email });
    return this.connectionOf(user.id);
  }

  /** Lanza una sincronización (si ya corre una para ese buzón, se repite al terminar). */
  kick(userId: string, opts: { backfill?: boolean } = {}) {
    if (this.running.has(userId)) {
      this.again.add(userId);
      return this.running.get(userId)!;
    }
    const run = this.syncNow(userId, opts)
      .catch((error) => this.log.warn({ err: error instanceof MailError ? { code: error.code, status: error.status } : { message: String((error as Error)?.message ?? error) } }, "mail sync failed"))
      .finally(() => {
        this.running.delete(userId);
        if (this.again.delete(userId)) void this.kick(userId);
      });
    this.running.set(userId, run);
    return run;
  }

  /** ¿Se está sincronizando ahora el buzón de este usuario? (el panel muestra el spinner). */
  syncing(userId: string) {
    return this.running.has(userId);
  }

  /** Espera a que terminen las sincronizaciones en curso (tests y apagado). */
  async idle() {
    while (this.running.size) await Promise.all([...this.running.values()]);
  }

  private async syncNow(userId: string, { backfill = false }: { backfill?: boolean }) {
    const conn = await this.connectionOf(userId);
    if (!conn || conn.status === "disconnected" || !this.provider) return;
    const box = this.provider.mailbox(conn.email);
    try {
      let ids: string[];
      let cursor = conn.cursor;
      if (backfill || !cursor) {
        ids = await box.recent(this.config.backfillDays ?? 14, 300);
        cursor ??= (await box.profile()).cursor;
      } else {
        try {
          const changes = await box.changes(cursor);
          ids = changes.messageIds;
          cursor = changes.cursor;
        } catch (error) {
          if (!(error instanceof MailError && error.code === "cursor_expired")) throw error;
          // Punto perdido (servicio caído varios días): se recargan los últimos días y se sigue.
          ids = await box.recent(7, 300);
          cursor = (await box.profile()).cursor;
        }
      }
      for (const id of ids) await this.ingest(conn, box, id);
      await this.connections.updateOne({ _id: conn._id, status: { $ne: "disconnected" } }, { $set: { cursor, status: "active", lastSyncAt: new Date(), lastError: null, updatedAt: new Date() } });
    } catch (error) {
      const message = error instanceof MailError ? error.message : "No se pudo sincronizar el buzón.";
      await this.connections.updateOne({ _id: conn._id, status: { $ne: "disconnected" } }, { $set: { status: "error", lastError: message, updatedAt: new Date() } });
      throw error;
    }
  }

  /** Guarda un mensaje si es de un cliente; si ya estaba o no coincide, no hace nada. */
  private async ingest(conn: MailConnectionDoc, box: Mailbox, id: string, forced?: CustomerMatch & { sentFromApp?: boolean }) {
    if (!forced && (await this.comms.findOne({ ownerUserId: conn.userId, providerMessageId: id }, { projection: { _id: 1 } }))) return null;
    const m = await box.message(id);
    if (m.labelIds.some((l) => SKIP_LABELS.has(l))) return null;
    const parsed = parse(m, conn.email, this.config.domain);
    const match = forced ?? (await matchCustomer(this.store, this.comms, { ownerUserId: conn.userId, threadId: m.threadId, external: parsed.external }));
    if (!match) return null;
    const at = new Date();
    const doc: CommunicationDoc = {
      _id: randomUUID(),
      kind: "email",
      direction: parsed.direction,
      subject: parsed.subject.slice(0, 200),
      body: parsed.text.slice(0, MAX_BODY),
      ownerUserId: conn.userId,
      contactName: (match.contactName ?? parsed.contactName).slice(0, 120),
      date: parsed.sentAt.toISOString().slice(0, 10),
      projectId: match.projectId,
      leadId: match.leadId,
      followUpDate: null,
      followUpDone: false,
      deletedAt: null,
      createdBy: "gmail",
      createdAt: at,
      updatedAt: at,
      source: "gmail",
      provider: "gmail",
      providerMessageId: m.id,
      providerThreadId: m.threadId,
      rfcMessageId: m.headers["message-id"] ?? null,
      from: parsed.from,
      to: parsed.to,
      cc: parsed.cc,
      sentAt: parsed.sentAt,
      contactId: match.contactId,
      dealId: null,
      matchedBy: match.matchedBy,
      sentFromApp: Boolean(forced?.sentFromApp)
    };
    try {
      await this.comms.insertOne(doc);
    } catch (error) {
      if ((error as { code?: number }).code === 11000) return this.comms.findOne({ ownerUserId: conn.userId, providerMessageId: id });
      throw error;
    }
    return doc;
  }

  /**
   * Firma HTML de Gmail del buzón conectado (null si no tiene o no se pudo leer). Se guarda en memoria
   * unos minutos; nunca se persiste.
   */
  async signatureOf(userId: string) {
    const conn = await this.connectionOf(userId);
    if (!conn || conn.status === "disconnected" || !this.provider) return null;
    const cached = this.signatures.get(conn.email);
    if (cached && Date.now() - cached.at < SIGNATURE_TTL_MS) return cached.html;
    const box = this.provider.mailbox(conn.email);
    if (!box.signature) return null;
    try {
      const html = await box.signature();
      this.signatures.set(conn.email, { html, at: Date.now() });
      return html;
    } catch (error) {
      this.log.warn({ code: error instanceof MailError ? error.code : "unknown", status: error instanceof MailError ? error.status : undefined }, "gmail signature unavailable");
      return null;
    }
  }

  /** Firma en texto (vista previa del panel: nunca se pinta el HTML de la firma en la app). */
  async signatureText(userId: string) {
    const html = await this.signatureOf(userId);
    return html ? htmlToText(html) || null : null;
  }

  /**
   * Destinatarios que empiezan o contienen `q`: primero a quienes la persona ya les escribió (su
   * propio buzón en la app), luego contactos y leads (si ve Comercial) y por último la gente de la app.
   */
  async recipients(user: SessionUser, q: string, limit = 8): Promise<RecipientSuggestion[]> {
    const needle = q.trim().toLowerCase();
    if (needle.length < 2) return [];
    const re = new RegExp(escapeRegex(needle), "i");
    const mine = (await this.connectionOf(user.id))?.email ?? (await this.corporateEmail(user.id));
    const out = new Map<string, RecipientSuggestion>();
    const add = (raw: string | null | undefined, name: string | null | undefined, source: RecipientSuggestion["source"]) => {
      const email = raw?.trim().toLowerCase();
      if (!email || email === mine || out.has(email) || !VALID_EMAIL.test(email)) return;
      const label = name?.trim() || null;
      if (!email.includes(needle) && !label?.toLowerCase().includes(needle)) return;
      out.set(email, { email, name: label, source });
    };

    const history = await this.comms
      .find({ ownerUserId: user.id, source: "gmail", deletedAt: null, $or: [{ from: re }, { to: re }, { cc: re }, { contactName: re }] }, { projection: { from: 1, to: 1, cc: 1, contactName: 1, direction: 1 } })
      .sort({ sentAt: -1 })
      .limit(60)
      .toArray();
    for (const c of history) {
      // El nombre del contacto es el de la otra persona: el remitente si se recibió, el primer destinatario si se envió.
      const counterpart = c.direction === "received" ? c.from : c.to?.[0];
      for (const e of [c.from, ...(c.to ?? []), ...(c.cc ?? [])]) add(e, e === counterpart ? c.contactName : null, "history");
    }

    if ((MODULE_ACCESS.communications as readonly string[]).includes(user.role)) {
      const [contacts, leads] = await Promise.all([
        this.store.contacts.find({ $or: [{ emails: re }, { name: re }] }, { projection: { name: 1, emails: 1 } }).limit(20).toArray(),
        this.store.leads.find({ $or: [{ email: re }, { corporateEmail: re }, { contactName: re }] }, { projection: { email: 1, corporateEmail: 1, contactName: 1 } }).limit(20).toArray()
      ]);
      for (const c of contacts) for (const e of c.emails ?? []) add(e, c.name, "contact");
      for (const l of leads) for (const e of [l.email, l.corporateEmail]) add(e, l.contactName, "lead");
    }

    const team = await this.store.users.find({ active: true, email: { $type: "string" }, $or: [{ email: re }, { name: re }, { username: re }] }, { projection: { email: 1, name: 1 } }).limit(20).toArray();
    for (const u of team) {
      // Coincide por usuario («manu» → manuel@…): se acepta aunque el texto no esté en el correo ni el nombre.
      const email = u.email?.trim().toLowerCase();
      if (email && email !== mine && !out.has(email) && VALID_EMAIL.test(email)) out.set(email, { email, name: u.name, source: "team" });
    }
    return [...out.values()].slice(0, limit);
  }

  /**
   * Envía un correo desde el buzón del usuario. Con `replyTo` (un correo de SU buzón) responde en ese
   * hilo y hereda su proyecto o lead; si no, el correo queda en el proyecto o lead indicado.
   */
  async send(user: SessionUser, input: { to: string[]; cc: string[]; subject: string; body: string; projectId: string | null; leadId: string | null; replyTo: CommunicationDoc | null; signature?: boolean }) {
    const conn = await this.connectionOf(user.id);
    if (!conn || conn.status === "disconnected") throw new MailServiceError(409, "Conecta tu Gmail antes de enviar correos.");
    // El buzón sigue siendo el de su cuenta (si cambió el correo del usuario, debe reconectar).
    if ((await this.corporateEmail(user.id)) !== conn.email) throw new MailServiceError(409, "Tu correo cambió; vuelve a conectar Gmail.");
    const box = this.mailbox(conn.email);
    const reply = input.replyTo;
    const subject = reply ? (input.subject.trim() || replySubject(reply.subject)) : input.subject.trim();
    // La firma se lee de Gmail en el servidor (no la manda el navegador); si no se puede leer, el correo sale sin ella.
    const signatureHtml = input.signature === false ? null : await this.signatureOf(user.id);
    const mime = buildMime({ from: conn.email, fromName: user.name, to: input.to, cc: input.cc, subject, body: input.body, inReplyTo: reply?.rfcMessageId ?? null, signatureHtml });
    let sent: { id: string; threadId: string };
    try {
      sent = await box.send(mime, reply?.providerThreadId);
    } catch (error) {
      throw this.asServiceError(error);
    }
    const projectId = reply ? reply.projectId : input.projectId;
    const leadId = reply ? reply.leadId : input.leadId;
    const doc = await this.ingest(conn, box, sent.id, { projectId, leadId, contactId: reply?.contactId ?? null, contactName: reply?.contactName || null, matchedBy: reply ? (reply.matchedBy ?? "thread") : "manual", sentFromApp: true }).catch((error: unknown) => {
      // Ya se envió: si no se puede leer de vuelta, la sincronización lo traerá después.
      this.log.warn({ code: error instanceof MailError ? error.code : "unknown" }, "sent message not stored yet");
      return null;
    });
    await this.store.audit({
      actor: user.username,
      action: "email.sent",
      clientId: projectId ? `ops:${projectId}` : `lead:${leadId}`,
      target: subject || "(sin asunto)",
      details: { from: conn.email, to: input.to, cc: input.cc, messageId: sent.id, threadId: sent.threadId, reply: Boolean(reply), viaApp: true, signature: Boolean(signatureHtml) }
    });
    return { messageId: sent.id, threadId: sent.threadId, communicationId: doc?._id ?? null, signature: Boolean(signatureHtml) };
  }

  /** Aviso push de Gmail: sincroniza ese buzón si está conectado. */
  async onPush(email: string) {
    const conn = await this.connections.findOne({ email: email.toLowerCase(), status: { $ne: "disconnected" } });
    if (conn) void this.kick(conn.userId);
  }

  /**
   * Recuperación periódica: sincroniza todos los buzones (cubre avisos push perdidos o reinicios)
   * y renueva el watch de Gmail antes de que venza (dura 7 días).
   */
  async sweep() {
    if (!this.provider) return;
    const conns = await this.connections.find({ status: { $ne: "disconnected" } }).toArray();
    for (const conn of conns) {
      if (this.config.topic && (!conn.watchExpiresAt || conn.watchExpiresAt.getTime() - Date.now() < 24 * 3_600_000)) {
        try {
          const w = await this.provider.mailbox(conn.email).watch(this.config.topic);
          await this.connections.updateOne({ _id: conn._id }, { $set: { watchExpiresAt: w.expiresAt, updatedAt: new Date() } });
        } catch (error) {
          this.log.warn({ code: error instanceof MailError ? error.code : "unknown" }, "gmail watch renewal failed");
        }
      }
      await this.kick(conn.userId);
    }
  }

  private asServiceError(error: unknown) {
    if (error instanceof MailServiceError) return error;
    if (error instanceof MailError) return new MailServiceError(error.code === "mailbox_unavailable" ? 409 : 502, error.message);
    return new MailServiceError(502, "Gmail no respondió; inténtalo de nuevo.");
  }
}

/** Datos del mensaje que importan para el registro. */
function parse(m: RawMessage, mailbox: string, domain: string) {
  const from = addresses(m.headers.from)[0] ?? "";
  const to = addresses(m.headers.to);
  const cc = addresses(m.headers.cc);
  const internal = (e: string) => domainOf(e) === domain.toLowerCase() || e === mailbox;
  const direction: "sent" | "received" = m.labelIds.includes("SENT") || from === mailbox ? "sent" : "received";
  const external = [...new Set([from, ...to, ...cc].filter((e) => e && !internal(e)))];
  const contactName = direction === "received" ? displayName(m.headers.from) : displayName(m.headers.to);
  return { from, to, cc, direction, external, contactName: contactName || external[0] || "", subject: m.headers.subject ?? "", text: m.text, sentAt: new Date(m.internalDate) };
}
