import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { MongoServerError } from "mongodb";
import { z } from "zod";
import { requireRole } from "../auth/session.js";
import type { SessionUser } from "../auth/users.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import type { MeetingProcessing } from "../meetings/processing.js";
import { meetingFromReadAi, readAiPayloadSchema, readAiSignatureMatches } from "../meetings/read-ai.js";
import { actionItemsOf, meetingViews, processedNote } from "../meetings/routes.js";
import type { InboxMeetingDoc, MeetingCore, MeetingDoc } from "../ops/models.js";
import { leadTitle } from "../sales/ingest.js";
import type { LeadMeetingDoc } from "../sales/models.js";
import type { AdminStore } from "../store/admin-store.js";
import { meetingContext } from "./ops.js";
import { leadMeetingContext } from "./sales.js";

const BODY_LIMIT = 6 * 1024 * 1024;
const idParams = z.object({ id: z.string().uuid() });
const assignSchema = z
  .object({ projectId: z.string().uuid().optional(), leadId: z.string().uuid().optional() })
  .strict()
  .refine((v) => Boolean(v.projectId) !== Boolean(v.leadId), "Elige un proyecto o un lead.");

/** La bandeja la ven CEO/CCO y Comercial: aún no se sabe de qué equipo es la reunión. */
const requireInbox = requireRole("boss", "commercial");

/** Usuario "sistema" para las novedades y la auditoría de lo que llega por el webhook. */
const READ_AI_ACTOR = { username: "source:read.ai", name: "Read.ai" } as SessionUser;

type Target = { kind: "project"; id: string; name: string } | { kind: "lead"; id: string; name: string };

/**
 * Reuniones de Read.ai (Paso 4, docs/rework-plataforma.md §4.2). El webhook configurado en Read.ai
 * llega cuando el reporte de la reunión está listo; se verifica la firma, se descarta lo repetido y
 * la reunión se asigna sola por los correos de los participantes: a su proyecto (por los contactos
 * del proyecto) o a su lead. Si no hay uno solo, queda en la bandeja «Por asignar». Después la
 * procesa Claude, que propone; una persona revisa y decide.
 */
export async function registerMeetingInboxRoutes(
  app: FastifyInstance,
  { store, processing, signingKey, now = Date.now }: { store: AdminStore; processing: MeetingProcessing; signingKey?: Buffer; now?: () => number }
) {
  const limiter = createRateLimiter({ limit: 120, windowMs: 60_000, now });

  const projectNote = (user: Pick<SessionUser, "username" | "name">, projectId: string, body: string) =>
    store.projectUpdates.insertOne({ _id: randomUUID(), projectId, kind: "system", body, authorUsername: user.username, authorName: user.name, createdAt: new Date() });
  const leadNote = (user: Pick<SessionUser, "username" | "name">, leadId: string, body: string) =>
    store.leadUpdates.insertOne({ _id: randomUUID(), leadId, kind: "system", body, authorUsername: user.username, authorName: user.name, createdAt: new Date() });

  /** Contactos por correo, y los proyectos (no cerrados) y leads (no ganados) de esos correos. */
  async function candidatesFor(emails: string[]) {
    if (!emails.length) return { contactIds: [] as string[], candidates: [] as Target[] };
    const contacts = await store.contacts.find({ emails: { $in: emails } }, { projection: { _id: 1 } }).toArray();
    const contactIds = contacts.map((c) => c._id);
    const [projects, leads] = await Promise.all([
      contactIds.length ? store.opsProjects.find({ contactIds: { $in: contactIds }, stage: { $ne: "completed" } }, { projection: { name: 1 } }).limit(20).toArray() : [],
      store.leads
        .find({ $or: [{ email: { $in: emails } }, ...(contactIds.length ? [{ contactId: { $in: contactIds } }] : [])], status: { $ne: "won" } }, { projection: { company: 1, contactName: 1, email: 1 } })
        .limit(20)
        .toArray()
    ]);
    const candidates: Target[] = [...projects.map((p) => ({ kind: "project" as const, id: p._id, name: p.name })), ...leads.map((l) => ({ kind: "lead" as const, id: l._id, name: leadTitle(l) }))];
    return { contactIds, candidates };
  }

  /** Un solo proyecto gana; si no hay proyecto, un solo lead. Si no, a la bandeja. */
  const pick = (candidates: Target[]): Target | null => {
    const projects = candidates.filter((c) => c.kind === "project");
    if (projects.length === 1) return projects[0];
    if (projects.length === 0 && candidates.length === 1) return candidates[0];
    return null;
  };

  /** Guarda la reunión en su proyecto o lead y la manda a procesar. */
  async function deliver(meeting: MeetingCore, target: Target, user: Pick<SessionUser, "username" | "name">) {
    if (target.kind === "project") {
      const project = await store.opsProjects.findOne({ _id: target.id });
      if (!project) return null;
      const doc: MeetingDoc = { ...meeting, projectId: project._id };
      await store.meetings.insertOne(doc);
      await projectNote(user, project._id, `Reunión recibida de Read.ai: «${meeting.title}».`);
      await store.audit({ actor: user.username, action: "ops.meeting_created", clientId: `ops:${project._id}`, target: project.name, details: { meeting: meeting.title, source: "read_ai" } });
      if (meeting.transcript && meeting.status === "pending") processing.start(store.meetings, doc._id, meetingContext(project), (m) => projectNote(user, project._id, processedNote(m)));
      return doc;
    }
    const lead = await store.leads.findOne({ _id: target.id });
    if (!lead) return null;
    const doc: LeadMeetingDoc = { ...meeting, leadId: lead._id };
    await store.leadMeetings.insertOne(doc);
    await leadNote(user, lead._id, `Reunión recibida de Read.ai: «${meeting.title}».`);
    await store.audit({ actor: user.username, action: "sales.meeting_created", clientId: `sales:${lead._id}`, target: leadTitle(lead), details: { meeting: meeting.title, source: "read_ai" } });
    if (meeting.transcript && meeting.status === "pending") processing.start(store.leadMeetings, doc._id, leadMeetingContext(lead), (m) => leadNote(user, lead._id, processedNote(m)));
    return doc;
  }

  const alreadyStored = async (externalId: string) =>
    Boolean(
      (await store.meetings.findOne({ externalId }, { projection: { _id: 1 } })) ||
        (await store.leadMeetings.findOne({ externalId }, { projection: { _id: 1 } })) ||
        (await store.meetingInbox.findOne({ externalId }, { projection: { _id: 1 } }))
    );

  await app.register(async (scope) => {
    // La firma se calcula sobre el cuerpo crudo: en esta ruta el JSON se lee como bytes.
    scope.removeContentTypeParser(["application/json"]);
    scope.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: BODY_LIMIT }, (_request, body, done) => done(null, body));

    scope.post("/api/webhooks/read-ai", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
      if (!signingKey) {
        request.log.warn("Read.ai webhook received but READ_AI_SIGNING_KEY_PATH is not configured");
        return reply.code(503).send({ error: "El webhook de Read.ai no está configurado en el servidor." });
      }
      if (!limiter.take(request.ip)) return reply.code(429).send({ error: "Demasiados envíos. Espera un minuto." });
      const raw = request.body;
      const signature = request.headers["x-read-signature"];
      if (!Buffer.isBuffer(raw) || !readAiSignatureMatches(raw, typeof signature === "string" ? signature : undefined, signingKey)) {
        request.log.warn("Read.ai webhook with an invalid signature");
        return reply.code(401).send({ error: "Firma inválida." });
      }
      let json: unknown;
      try {
        json = JSON.parse(raw.toString("utf8"));
      } catch {
        return reply.code(400).send({ error: "JSON inválido." });
      }
      const parsed = readAiPayloadSchema.safeParse(json);
      if (!parsed.success) return reply.code(400).send({ error: "El cuerpo no tiene el formato de Read.ai." });
      const payload = parsed.data;
      // Mismo envío repetido (request_id): se confirma sin volver a guardarlo.
      if (payload.request_id) {
        try {
          await store.webhookDeliveries.insertOne({ _id: `read_ai:${payload.request_id}`, source: "read_ai", receivedAt: new Date(now()) });
        } catch (error) {
          if (error instanceof MongoServerError && error.code === 11000) return reply.code(200).send({ ok: true, duplicate: true });
          throw error;
        }
      }
      // Solo interesa el reporte de la reunión terminada (meeting_start no trae contenido).
      if (payload.trigger !== "meeting_end") return reply.code(202).send({ ok: true, ignored: payload.trigger });
      const data = meetingFromReadAi(payload, new Date(now()));
      if (await alreadyStored(data.externalId)) return reply.code(200).send({ ok: true, duplicate: true });

      const emails = data.participants.map((p) => p.email).filter((e): e is string => Boolean(e) && e !== data.ownerEmail);
      const { contactIds, candidates } = await candidatesFor(emails);
      const at = new Date(now());
      const hasTranscript = Boolean(data.transcript);
      const meeting: MeetingCore = {
        _id: randomUUID(),
        title: data.title,
        heldAt: data.heldAt,
        source: "read_ai",
        externalId: data.externalId,
        kind: null,
        durationMinutes: data.durationMinutes,
        url: data.url,
        dealId: null,
        attendeeContactIds: contactIds,
        participants: data.participants,
        transcript: data.transcript,
        // Sin transcripción no hay nada que procesar: queda el resumen y los action items de Read.ai.
        summary: hasTranscript ? "" : data.readAi.summary,
        feedback: [],
        actionItems: hasTranscript ? [] : actionItemsOf(data.readAi.actionItems),
        status: hasTranscript ? "pending" : "processed",
        reviewStatus: "new",
        clientSentiment: null,
        readAi: data.readAi,
        processingError: null,
        createdBy: READ_AI_ACTOR.username,
        createdAt: at,
        updatedAt: at
      };
      const target = pick(candidates);
      try {
        const delivered = target ? await deliver(meeting, target, READ_AI_ACTOR) : null;
        if (delivered) return reply.code(201).send({ ok: true, assigned: target!.kind });
        await store.meetingInbox.insertOne({ ...meeting, candidates });
      } catch (error) {
        // El mismo session_id llegó dos veces a la vez: gana el primero.
        if (error instanceof MongoServerError && error.code === 11000) return reply.code(200).send({ ok: true, duplicate: true });
        throw error;
      }
      await store.audit({ actor: READ_AI_ACTOR.username, action: "meetings.inbox_received", clientId: "meetings:inbox", target: meeting.title, details: { candidates: candidates.length } });
      return reply.code(201).send({ ok: true, assigned: null });
    });
  });

  // ---- bandeja «Por asignar» -----------------------------------------------------

  const inboxView = async (rows: InboxMeetingDoc[]) => {
    const view = await meetingViews(store, rows);
    return rows.map((m) => ({ ...view(m), candidates: m.candidates }));
  };

  app.get("/api/meetings/inbox", { preHandler: requireInbox }, async () => {
    const rows = await store.meetingInbox.find({}, { projection: { transcript: 0 } }).sort({ heldAt: -1 }).limit(200).toArray();
    // Sin transcripción en la lista; su largo sí (para saber si se procesará).
    const lengths = await store.meetingInbox.aggregate<{ _id: string; n: number }>([{ $project: { n: { $strLenCP: { $ifNull: ["$transcript", ""] } } } }]).toArray();
    const length = new Map(lengths.map((l) => [l._id, l.n]));
    return { meetings: (await inboxView(rows.map((m) => ({ ...m, transcript: "" }) as InboxMeetingDoc))).map((m) => ({ ...m, transcriptLength: length.get(m.id) ?? 0 })) };
  });

  /** Asigna la reunión: el CEO/CCO a un proyecto o un lead; Comercial a un lead. */
  app.post("/api/meetings/inbox/:id/assign", { preHandler: requireInbox }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = assignSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? "Datos inválidos." });
    const user = request.user!;
    if (body.data.projectId && user.role !== "boss") return reply.code(403).send({ error: "Solo el CEO/CCO asigna reuniones a un proyecto." });
    // Se saca de la bandeja de forma atómica: dos asignaciones a la vez no la duplican.
    const meeting = await store.meetingInbox.findOneAndDelete({ _id: params.data.id });
    if (!meeting) return reply.code(404).send({ error: "Reunión no encontrada." });
    const { candidates: _candidates, ...core } = meeting;
    void _candidates;
    const target: Target = body.data.projectId ? { kind: "project", id: body.data.projectId, name: "" } : { kind: "lead", id: body.data.leadId!, name: "" };
    const delivered = await deliver({ ...core, updatedAt: new Date() }, target, user);
    if (!delivered) {
      await store.meetingInbox.insertOne(meeting);
      return reply.code(400).send({ error: target.kind === "project" ? "El proyecto no existe." : "El lead no existe." });
    }
    await store.audit({ actor: user.username, action: "meetings.inbox_assigned", clientId: "meetings:inbox", target: meeting.title, details: { to: target.kind } });
    return { ok: true, assigned: { kind: target.kind, id: target.id } };
  });

  /** Reuniones internas o que no son de un cliente: se descartan (queda en la auditoría). */
  app.delete("/api/meetings/inbox/:id", { preHandler: requireInbox }, async (request, reply: FastifyReply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const meeting = await store.meetingInbox.findOneAndDelete({ _id: params.data.id });
    if (!meeting) return reply.code(404).send({ error: "Reunión no encontrada." });
    await store.audit({ actor: request.user!.username, action: "meetings.inbox_discarded", clientId: "meetings:inbox", target: meeting.title });
    return { ok: true };
  });
}
