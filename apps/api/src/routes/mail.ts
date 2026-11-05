import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { MailServiceError, type MailConnectionDoc, type MailService } from "../mail/service.js";
import { canWriteCommunication, type CommunicationDoc } from "./communications.js";

const email = z.string().trim().toLowerCase().email("Hay un correo inválido.").max(254);
const sendSchema = z
  .object({
    to: z.array(email).min(1, "Agrega al menos un destinatario.").max(20),
    cc: z.array(email).max(20).default([]),
    subject: z.string().trim().max(200).default(""),
    body: z.string().max(50_000).refine((b) => b.trim().length > 0, "Escribe el mensaje."),
    projectId: z.string().uuid().nullable().default(null),
    leadId: z.string().uuid().nullable().default(null),
    replyToId: z.string().uuid().nullable().default(null),
    signature: z.boolean().default(true)
  })
  .strict()
  .refine((v) => v.replyToId || Boolean(v.projectId) !== Boolean(v.leadId), "Relaciona el correo con un proyecto o con un lead.")
  .refine((v) => v.replyToId || v.subject.length > 0, "Escribe el asunto.");

const view = (c: MailConnectionDoc | null, syncing = false) =>
  c && { email: c.email, status: c.status, lastSyncAt: c.lastSyncAt?.toISOString() ?? null, lastError: c.lastError, push: Boolean(c.watchExpiresAt && c.watchExpiresAt > new Date()), syncing: syncing && c.status !== "disconnected" };

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof MailServiceError) return reply.code(error.status).send({ error: error.message });
  throw error;
}

/**
 * Correo de cada persona (Gmail con delegación de dominio). Todas las rutas son /api/me/…: el buzón
 * sale de la sesión, nunca de un parámetro, así nadie puede leer ni enviar desde el buzón de otro.
 */
export async function registerMailRoutes(app: FastifyInstance, { mail, pushSecret }: { mail: MailService; pushSecret?: string }) {
  await mail.init();
  const sendLimit = createRateLimiter({ limit: 30, windowMs: 10 * 60_000 });

  app.get("/api/me/mail", { preHandler: requireAuth }, async (request) => {
    const user = request.user!;
    const [corporate, conn] = await Promise.all([mail.corporateEmail(user.id), mail.connectionOf(user.id)]);
    return { available: mail.available, pushEnabled: mail.pushEnabled, email: corporate, canConnect: mail.available && Boolean(corporate), connection: view(conn, mail.syncing(user.id)) };
  });

  /** Firma de Gmail en texto, para la vista previa al redactar. */
  app.get("/api/me/mail/signature", { preHandler: requireAuth }, async (request) => ({ text: await mail.signatureText(request.user!.id) }));

  /** Sugerencias de destinatarios mientras se escribe (a quién ya le escribió, contactos, leads y la gente de la app). */
  app.get("/api/me/mail/recipients", { preHandler: requireAuth }, async (request) => {
    const q = z.string().max(100).catch("").parse((request.query as { q?: unknown }).q);
    return { suggestions: await mail.recipients(request.user!, q) };
  });

  app.post("/api/me/mail/connect", { preHandler: requireAuth }, async (request, reply) => {
    try {
      const user = request.user!;
      return { connection: view(await mail.connect(user), mail.syncing(user.id)) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post("/api/me/mail/disconnect", { preHandler: requireAuth }, async (request) => ({ connection: view(await mail.disconnect(request.user!)) }));

  app.post("/api/me/mail/sync", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user!;
    const conn = await mail.connectionOf(user.id);
    if (!conn || conn.status === "disconnected") return reply.code(409).send({ error: "Conecta tu Gmail primero." });
    await mail.kick(user.id);
    return { connection: view(await mail.connectionOf(user.id)) };
  });

  app.post("/api/me/mail/send", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user!;
    const body = sendSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? "Datos inválidos." });
    if (!sendLimit.take(user.id)) return reply.code(429).send({ error: "Enviaste muchos correos seguidos; espera unos minutos." });
    const input = body.data;
    let replyTo: CommunicationDoc | null = null;
    if (input.replyToId) {
      replyTo = await mail.comms.findOne({ _id: input.replyToId, deletedAt: null });
      // Solo se responde en hilos del buzón propio: el hilo de Gmail es de quien lo recibió.
      if (!replyTo || replyTo.source !== "gmail" || replyTo.ownerUserId !== user.id) return reply.code(404).send({ error: "No encontramos ese correo en tu buzón." });
    }
    const target = replyTo ? { projectId: replyTo.projectId, leadId: replyTo.leadId } : { projectId: input.projectId, leadId: input.leadId };
    if (target.leadId && !(await mail.store.leads.findOne({ _id: target.leadId }, { projection: { _id: 1 } }))) return reply.code(400).send({ error: "El lead no existe." });
    if (!(await canWriteCommunication(mail.store, user, target))) return reply.code(403).send({ error: "No puedes registrar comunicaciones en ese proyecto o lead." });
    try {
      const result = await mail.send(user, { ...input, ...target, replyTo });
      return reply.code(201).send(result);
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * Aviso push de Gmail (suscripción push de Pub/Sub). Pub/Sub llama a
   * /api/mail/gmail/push?key=<secreto>; el cuerpo solo trae el buzón y el historyId, y lo único que
   * dispara es una sincronización de ese buzón (si está conectado).
   */
  app.post("/api/mail/gmail/push", async (request, reply) => {
    if (!pushSecret) return reply.code(503).send({ error: "Avisos push no configurados." });
    const key = String((request.query as { key?: unknown }).key ?? "");
    const a = Buffer.from(key);
    const b = Buffer.from(pushSecret);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return reply.code(401).send({ error: "No autorizado." });
    const parsed = z.object({ message: z.object({ data: z.string().max(4096) }) }).safeParse(request.body);
    if (!parsed.success) return reply.code(204).send();
    try {
      const data = JSON.parse(Buffer.from(parsed.data.message.data, "base64").toString("utf8")) as { emailAddress?: unknown };
      if (typeof data.emailAddress === "string") await mail.onPush(data.emailAddress);
    } catch {
      // Mensaje ilegible: se confirma igual para que Pub/Sub no lo reintente sin fin.
    }
    return reply.code(204).send();
  });
}
