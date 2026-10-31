import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { type Filter, MongoServerError } from "mongodb";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import type { SessionUser } from "../auth/users.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { runTableQuery, tableQuerySchema } from "../lib/table-query.js";
import type { MeetingProcessing } from "../meetings/processing.js";
import { meetingFromReadAi, readAiPayloadSchema, readAiSignatureMatches } from "../meetings/read-ai.js";
import { actionItemsOf, meetingViews, processedNote } from "../meetings/routes.js";
import { teamFromParticipants } from "../meetings/teams.js";
import { MEETING_ENGAGEMENTS, type MeetingDoc } from "../ops/models.js";
import { leadTitle } from "../sales/models.js";
import type { AdminStore } from "../store/admin-store.js";
import { meetingContext } from "./ops.js";
import { leadMeetingContext } from "./sales.js";

const BODY_LIMIT = 6 * 1024 * 1024;
const idParams = z.object({ id: z.string().uuid() });
const assignSchema = z
  .object({ projectId: z.string().uuid().optional(), leadId: z.string().uuid().optional() })
  .strict()
  .refine((v) => Boolean(v.projectId) !== Boolean(v.leadId), "Elige un proyecto o un lead.");
const updateSchema = z.object({ teamId: z.string().uuid().nullable() }).strict();
const listQuery = tableQuerySchema.extend({
  /** Un equipo, o "none" para las que aún no tienen equipo. */
  teamId: z.union([z.string().uuid(), z.literal("none")]).optional(),
  engagement: z.enum(MEETING_ENGAGEMENTS).optional()
});

/** Usuario "sistema" para las novedades y la auditoría de lo que llega por el webhook. */
const READ_AI_ACTOR = { username: "source:read.ai", name: "Read.ai" } as SessionUser;

type Target = { kind: "project" | "lead"; id: string; name: string };

const forbidden = (reply: FastifyReply) => reply.code(403).send({ error: "No tienes permiso para esta acción." });

/**
 * Qué reuniones ve cada rol (§6): CEO/CCO y Financiera, todas; Comercial, las de leads y las que
 * no son de un proyecto; Team Leader y Developer, las de su equipo.
 */
function scope(user: SessionUser): Filter<MeetingDoc> {
  if (user.role === "boss" || user.role === "finance") return {};
  if (user.role === "commercial") return { projectId: null };
  return user.teamId ? { teamId: user.teamId } : { _id: "__none__" };
}

/**
 * Meetings (tabla única, docs/rework-plataforma.md §4.2). El webhook de Read.ai llega cuando el
 * reporte está listo; se verifica la firma y se descarta lo repetido. Cada reunión toma el equipo
 * del Team Leader que participó (por su correo en Usuarios) y, además, se liga sola a su proyecto o
 * lead por los correos de los contactos. Claude la procesa: resumen, engagement y action items.
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

  /** Un solo proyecto gana; si no hay proyecto, un solo lead. Si no, queda sin ligar. */
  const pick = (candidates: Target[]): Target | null => {
    const projects = candidates.filter((c) => c.kind === "project");
    if (projects.length === 1) return projects[0];
    if (projects.length === 0 && candidates.length === 1) return candidates[0];
    return null;
  };

  /** Procesa la reunión con el contexto de su proyecto, de su lead o, sin ellos, de sus participantes. */
  async function startProcessing(meeting: MeetingDoc, user: Pick<SessionUser, "username" | "name">) {
    if (!meeting.transcript || meeting.status === "processed") return;
    if (meeting.projectId) {
      const project = await store.opsProjects.findOne({ _id: meeting.projectId });
      if (project) return processing.start(store.meetings, meeting._id, meetingContext(project), (m) => projectNote(user, project._id, processedNote(m)));
    }
    if (meeting.leadId) {
      const lead = await store.leads.findOne({ _id: meeting.leadId });
      if (lead) return processing.start(store.meetings, meeting._id, leadMeetingContext(lead), (m) => leadNote(user, lead._id, processedNote(m)));
    }
    const names = (meeting.participants ?? []).map((p) => p.name).join(", ");
    processing.start(store.meetings, meeting._id, `Reunión registrada por Read.ai, aún sin proyecto ni lead. Participantes: ${names || "sin datos"}.`);
  }

  /** Liga la reunión a su proyecto o lead: novedad y auditoría en el dueño. */
  async function linkTo(meeting: MeetingDoc, target: Target, user: Pick<SessionUser, "username" | "name">) {
    if (target.kind === "project") {
      const project = await store.opsProjects.findOne({ _id: target.id }, { projection: { name: 1, teamId: 1 } });
      if (!project) return null;
      await store.meetings.updateOne({ _id: meeting._id }, { $set: { projectId: project._id, leadId: null, teamId: meeting.teamId ?? project.teamId, updatedAt: new Date() }, $unset: { candidates: "" } });
      await projectNote(user, project._id, `Reunión de Read.ai: «${meeting.title}».`);
      await store.audit({ actor: user.username, action: "ops.meeting_created", clientId: `ops:${project._id}`, target: project.name, details: { meeting: meeting.title, source: "read_ai" } });
    } else {
      const lead = await store.leads.findOne({ _id: target.id }, { projection: { company: 1, contactName: 1, email: 1 } });
      if (!lead) return null;
      await store.meetings.updateOne({ _id: meeting._id }, { $set: { leadId: lead._id, projectId: null, updatedAt: new Date() }, $unset: { candidates: "" } });
      await leadNote(user, lead._id, `Reunión de Read.ai: «${meeting.title}».`);
      await store.audit({ actor: user.username, action: "sales.meeting_created", clientId: `sales:${lead._id}`, target: leadTitle(lead), details: { meeting: meeting.title, source: "read_ai" } });
    }
    return store.meetings.findOne({ _id: meeting._id });
  }

  await app.register(async (scoped) => {
    // La firma se calcula sobre el cuerpo crudo: en esta ruta el JSON se lee como bytes.
    scoped.removeContentTypeParser(["application/json"]);
    scoped.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: BODY_LIMIT }, (_request, body, done) => done(null, body));

    scoped.post("/api/webhooks/read-ai", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
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
      if (await store.meetings.findOne({ externalId: data.externalId }, { projection: { _id: 1 } })) return reply.code(200).send({ ok: true, duplicate: true });

      const emails = data.participants.map((p) => p.email).filter((e): e is string => Boolean(e) && e !== data.ownerEmail);
      const [{ contactIds, candidates }, teamId] = await Promise.all([candidatesFor(emails), teamFromParticipants(store, data.participants, data.ownerEmail)]);
      const at = new Date(now());
      const hasTranscript = Boolean(data.transcript);
      const target = pick(candidates);
      const meeting: MeetingDoc = {
        _id: randomUUID(),
        projectId: null,
        leadId: null,
        teamId,
        ...(target ? {} : { candidates }),
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
        engagement: null,
        readAi: data.readAi,
        processingError: null,
        createdBy: READ_AI_ACTOR.username,
        createdAt: at,
        updatedAt: at
      };
      try {
        await store.meetings.insertOne(meeting);
      } catch (error) {
        // El mismo session_id llegó dos veces a la vez: gana el primero.
        if (error instanceof MongoServerError && error.code === 11000) return reply.code(200).send({ ok: true, duplicate: true });
        throw error;
      }
      const linked = target ? await linkTo(meeting, target, READ_AI_ACTOR) : null;
      await startProcessing(linked ?? meeting, READ_AI_ACTOR);
      await store.audit({ actor: READ_AI_ACTOR.username, action: "meetings.received", clientId: "meetings", target: meeting.title, details: { team: Boolean(teamId), linked: target?.kind ?? "none" } });
      return reply.code(201).send({ ok: true, assigned: linked ? target!.kind : null, teamId });
    });
  });

  // ---- tabla de Meetings -----------------------------------------------------------

  /** Nombres de equipos, proyectos y leads de un grupo de reuniones. */
  async function refs(rows: MeetingDoc[]) {
    const ids = (pickId: (m: MeetingDoc) => string | null | undefined) => [...new Set(rows.map(pickId).filter((v): v is string => Boolean(v)))];
    const [teams, projects, leads] = await Promise.all([
      store.teams.find({ _id: { $in: ids((m) => m.teamId) } }, { projection: { name: 1 } }).toArray(),
      store.opsProjects.find({ _id: { $in: ids((m) => m.projectId) } }, { projection: { name: 1 } }).toArray(),
      store.leads.find({ _id: { $in: ids((m) => m.leadId) } }, { projection: { company: 1, contactName: 1, email: 1 } }).toArray()
    ]);
    const team = new Map(teams.map((t) => [t._id, { id: t._id, name: t.name }]));
    const project = new Map(projects.map((p) => [p._id, { id: p._id, name: p.name }]));
    const lead = new Map(leads.map((l) => [l._id, { id: l._id, title: leadTitle(l) }]));
    return (m: MeetingDoc) => ({
      team: m.teamId ? (team.get(m.teamId) ?? null) : null,
      project: m.projectId ? (project.get(m.projectId) ?? null) : null,
      lead: m.leadId ? (lead.get(m.leadId) ?? null) : null
    });
  }

  /** Quién liga la reunión a un proyecto o lead, o la descarta. */
  const canAssign = (user: SessionUser, meeting: MeetingDoc) => user.role === "boss" || (user.role === "commercial" && !meeting.projectId);

  async function readable(user: SessionUser, id: string, reply: FastifyReply) {
    const meeting = await store.meetings.findOne({ _id: id, ...scope(user) } as Filter<MeetingDoc>);
    if (!meeting) {
      void reply.code(404).send({ error: "Reunión no encontrada." });
      return null;
    }
    return meeting;
  }

  /** Tabla de Meetings: nombre, fecha, equipo y engagement; agrupable por equipo. */
  app.get("/api/meetings", { preHandler: requireAuth }, async (request, reply) => {
    const query = listQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Filtros inválidos." });
    const user = request.user!;
    const { teamId, engagement } = query.data;
    const result = await runTableQuery(store.meetings, {
      match: {
        ...scope(user),
        ...(teamId ? { teamId: teamId === "none" ? null : teamId } : {}),
        ...(engagement ? { engagement } : {})
      } as Filter<MeetingDoc>,
      query: query.data,
      sortable: { title: "title", heldAt: "heldAt", engagement: { field: "engagement", order: MEETING_ENGAGEMENTS } },
      defaultSort: { key: "heldAt", dir: "desc" },
      search: ["title", "participants.name", "participants.email"],
      facetField: "teamId",
      projection: { transcript: 0 }
    });
    const ref = await refs(result.rows);
    return {
      ...result,
      rows: result.rows.map((m) => ({
        id: m._id,
        title: m.title,
        heldAt: m.heldAt,
        durationMinutes: m.durationMinutes ?? null,
        source: m.source,
        status: m.status,
        engagement: m.engagement ?? null,
        ...ref(m)
      }))
    };
  });

  /** Detalle para el pop-up: resumen de Claude y lo que mandó Read.ai. */
  app.get("/api/meetings/:id", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const user = request.user!;
    const meeting = await readable(user, params.data.id, reply);
    if (!meeting) return reply;
    const [view, ref] = await Promise.all([meetingViews(store, [meeting]), refs([meeting])]);
    return {
      meeting: { ...view(meeting), ...ref(meeting), candidates: meeting.candidates ?? [] },
      permissions: { assign: canAssign(user, meeting), team: user.role === "boss", discard: canAssign(user, meeting) && !meeting.projectId && !meeting.leadId }
    };
  });

  /** El CEO/CCO fija el equipo cuando no salió del correo del Team Leader. */
  app.patch("/api/meetings/:id", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = updateSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Datos inválidos." });
    const user = request.user!;
    if (user.role !== "boss") return forbidden(reply);
    const meeting = await readable(user, params.data.id, reply);
    if (!meeting) return reply;
    if (body.data.teamId && !(await store.teams.findOne({ _id: body.data.teamId }, { projection: { _id: 1 } }))) return reply.code(400).send({ error: "El equipo no existe." });
    await store.meetings.updateOne({ _id: meeting._id }, { $set: { teamId: body.data.teamId, updatedAt: new Date() } });
    await store.audit({ actor: user.username, action: "meetings.team_set", clientId: "meetings", target: meeting.title });
    return { ok: true };
  });

  /** Liga la reunión a un proyecto (CEO/CCO) o a un lead (CEO/CCO y Comercial). */
  app.post("/api/meetings/:id/assign", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = assignSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? "Datos inválidos." });
    const user = request.user!;
    const meeting = await readable(user, params.data.id, reply);
    if (!meeting) return reply;
    if (!canAssign(user, meeting)) return forbidden(reply);
    if (body.data.projectId && user.role !== "boss") return reply.code(403).send({ error: "Solo el CEO/CCO liga reuniones a un proyecto." });
    const target: Target = body.data.projectId ? { kind: "project", id: body.data.projectId, name: "" } : { kind: "lead", id: body.data.leadId!, name: "" };
    const linked = await linkTo(meeting, target, user);
    if (!linked) return reply.code(400).send({ error: target.kind === "project" ? "El proyecto no existe." : "El lead no existe." });
    await startProcessing(linked, user);
    return { ok: true, assigned: { kind: target.kind, id: target.id } };
  });

  /** Reuniones internas o que no son de un cliente: se descartan (queda en la auditoría). */
  app.delete("/api/meetings/:id", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const user = request.user!;
    const meeting = await readable(user, params.data.id, reply);
    if (!meeting) return reply;
    if (!canAssign(user, meeting) || meeting.projectId || meeting.leadId) return forbidden(reply);
    await store.meetings.deleteOne({ _id: meeting._id });
    await store.audit({ actor: user.username, action: "meetings.discarded", clientId: "meetings", target: meeting.title });
    return { ok: true };
  });
}
