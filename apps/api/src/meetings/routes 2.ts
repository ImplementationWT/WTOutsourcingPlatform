import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Collection, Filter } from "mongodb";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import type { SessionUser } from "../auth/users.js";
import { MEETING_SOURCES, type MeetingCore } from "../ops/models.js";
import type { MeetingProcessing } from "./processing.js";

const idParams = z.object({ id: z.string().uuid() });
const idsParams = z.object({ id: z.string().uuid(), childId: z.string().uuid() });
const text = (max: number) => z.string().trim().max(max);

const createMeetingSchema = z
  .object({
    title: text(160).min(3),
    heldAt: z.string().datetime({ offset: true }),
    source: z.enum(MEETING_SOURCES).optional(),
    externalId: text(120).min(1).optional(),
    transcript: z.string().max(300_000).optional(),
    summary: text(8000).optional(),
    feedback: z.array(text(1000).min(1)).max(50).optional(),
    actionItems: z.array(text(500).min(1)).max(50).optional()
  })
  .strict();

/** Dueño de las reuniones (proyecto o lead) ya cargado y con los permisos del usuario. */
export interface MeetingOwner {
  id: string;
  /** Registrar y reprocesar reuniones. */
  canWork: boolean;
  /** Contexto para el modelo: de quién es la reunión. */
  context: string;
  /** Deja una novedad del sistema en el dueño. */
  note(user: SessionUser, body: string): Promise<unknown>;
  audit(user: SessionUser, action: string, details: Record<string, string | number | boolean>): Promise<unknown>;
}

export const meetingView = (meeting: MeetingCore, withTranscript = false) => ({
  id: meeting._id,
  title: meeting.title,
  heldAt: meeting.heldAt,
  source: meeting.source,
  status: meeting.status,
  summary: meeting.summary,
  feedback: meeting.feedback,
  actionItems: meeting.actionItems,
  sentimentSignal: meeting.sentimentSignal ?? null,
  processingError: meeting.processingError ?? null,
  processedAt: meeting.processedAt ?? null,
  transcriptLength: meeting.transcript.length,
  ...(withTranscript ? { transcript: meeting.transcript } : {})
});

const invalid = (reply: FastifyReply, error: z.ZodError) =>
  reply.code(400).send({ error: "Datos inválidos.", issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });

/**
 * Log de reuniones de un proyecto o de un lead: listado, detalle con transcripción, registro y
 * reprocesamiento. Una reunión con transcripción y sin resumen se procesa sola con Claude.
 */
export function registerMeetingRoutes<T extends MeetingCore>(
  app: FastifyInstance,
  {
    base,
    collection,
    ownerKey,
    processing,
    resolve
  }: {
    /** Ruta del dueño, p. ej. "/api/ops/projects/:id". */
    base: string;
    collection: Collection<T>;
    ownerKey: "projectId" | "leadId";
    processing: MeetingProcessing;
    /** Carga el dueño si el usuario puede verlo; si no, responde (404/403) y devuelve null. */
    resolve(request: FastifyRequest, reply: FastifyReply, id: string): Promise<MeetingOwner | null>;
  }
) {
  const owned = (ownerId: string, extra: Record<string, unknown> = {}) => ({ [ownerKey]: ownerId, ...extra }) as Filter<T>;

  const processed = (owner: MeetingOwner, user: SessionUser) => (meeting: T) =>
    owner.note(user, `Reunión procesada: «${meeting.title}». Sentimiento sugerido: ${meeting.sentimentSignal ?? "-"}/100 · ${meeting.actionItems.length} action items.`);

  app.get(`${base}/meetings`, { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const owner = await resolve(request, reply, params.data.id);
    if (!owner) return reply;
    const meetings = await collection.find(owned(owner.id)).sort({ heldAt: -1 }).limit(200).toArray();
    return { meetings: meetings.map((m) => meetingView(m as T)), processingAvailable: processing.available };
  });

  app.get(`${base}/meetings/:childId`, { preHandler: requireAuth }, async (request, reply) => {
    const params = idsParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const owner = await resolve(request, reply, params.data.id);
    if (!owner) return reply;
    const meeting = await collection.findOne(owned(owner.id, { _id: params.data.childId }));
    if (!meeting) return reply.code(404).send({ error: "Reunión no encontrada." });
    return { meeting: meetingView(meeting as T, true) };
  });

  app.post(`${base}/meetings`, { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = createMeetingSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const owner = await resolve(request, reply, params.data.id);
    if (!owner) return reply;
    const user = request.user!;
    if (!owner.canWork) return reply.code(403).send({ error: "No tienes permiso para esta acción." });
    if (body.data.externalId && (await collection.findOne(owned(owner.id, { externalId: body.data.externalId })))) {
      return reply.code(409).send({ error: "Esta reunión ya está registrada." });
    }
    const at = new Date();
    const hasSummary = Boolean(body.data.summary);
    const transcript = body.data.transcript?.trim() ?? "";
    const meeting = {
      _id: randomUUID(),
      [ownerKey]: owner.id,
      title: body.data.title,
      heldAt: new Date(body.data.heldAt),
      source: body.data.source ?? "manual",
      externalId: body.data.externalId ?? null,
      transcript,
      summary: body.data.summary ?? "",
      feedback: body.data.feedback ?? [],
      actionItems: body.data.actionItems ?? [],
      // Con resumen escrito a mano no hay nada que procesar; con transcripción la procesa Claude.
      status: hasSummary ? "processed" : "pending",
      sentimentSignal: null,
      processingError: null,
      createdBy: user.username,
      createdAt: at,
      updatedAt: at
    } as unknown as T;
    await collection.insertOne(meeting as never);
    await owner.audit(user, "meeting_created", { meeting: meeting.title });
    if (!hasSummary && transcript) processing.start(collection, meeting._id, owner.context, processed(owner, user));
    return reply.code(201).send({ meeting: meetingView(meeting) });
  });

  /** Procesa (o reintenta) una reunión con transcripción y espera el resultado. */
  app.post(`${base}/meetings/:childId/process`, { preHandler: requireAuth }, async (request, reply) => {
    const params = idsParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const owner = await resolve(request, reply, params.data.id);
    if (!owner) return reply;
    if (!owner.canWork) return reply.code(403).send({ error: "No tienes permiso para esta acción." });
    if (!processing.available) return reply.code(503).send({ error: "El procesamiento automático no está disponible: falta la clave de Anthropic en el servidor." });
    const meeting = await collection.findOne(owned(owner.id, { _id: params.data.childId }));
    if (!meeting) return reply.code(404).send({ error: "Reunión no encontrada." });
    if (!meeting.transcript) return reply.code(409).send({ error: "La reunión no tiene transcripción que procesar." });
    if (meeting.status === "processed") return reply.code(409).send({ error: "La reunión ya está procesada." });
    const result = await processing.process(collection, meeting._id, owner.context, processed(owner, request.user!));
    if (!result) return reply.code(409).send({ error: "La reunión ya se está procesando." });
    return { meeting: meetingView(result) };
  });
}
