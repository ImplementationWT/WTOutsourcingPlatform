import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Collection, Filter } from "mongodb";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import type { SessionUser } from "../auth/users.js";
import {
  ACTION_ITEM_KINDS,
  type ActionItemDoc,
  CLIENT_SENTIMENTS,
  type ClientSentiment,
  MEETING_KINDS,
  MEETING_REVIEW_STATUSES,
  MEETING_SOURCES,
  type MeetingCore,
  type MeetingReviewStatus
} from "../ops/models.js";
import type { AdminStore } from "../store/admin-store.js";
import type { MeetingProcessing } from "./processing.js";

const idParams = z.object({ id: z.string().uuid() });
const idsParams = z.object({ id: z.string().uuid(), childId: z.string().uuid() });
const itemParams = z.object({ id: z.string().uuid(), childId: z.string().uuid(), itemId: z.string().uuid() });
const text = (max: number) => z.string().trim().max(max);
const url = z
  .string()
  .trim()
  .max(500)
  .refine((v) => /^https?:\/\//i.test(v), "Debe empezar por http:// o https://")
  .nullable();

const meetingFields = {
  title: text(160).min(3),
  kind: z.enum(MEETING_KINDS).nullable(),
  durationMinutes: z.number().int().min(0).max(24 * 60).nullable(),
  url,
  dealId: z.string().uuid().nullable(),
  attendeeContactIds: z.array(z.string().uuid()).max(50)
};

const createMeetingSchema = z
  .object({
    ...meetingFields,
    heldAt: z.string().datetime({ offset: true }),
    source: z.enum(MEETING_SOURCES),
    externalId: text(120).min(1),
    transcript: z.string().max(300_000),
    summary: text(8000),
    feedback: z.array(text(1000).min(1)).max(50),
    actionItems: z.array(text(500).min(1)).max(50)
  })
  .partial()
  .required({ title: true, heldAt: true })
  .strict();

/** Lo que corrige o decide una persona al revisar la reunión. */
const updateMeetingSchema = z
  .object({ ...meetingFields, reviewStatus: z.enum(MEETING_REVIEW_STATUSES), clientSentiment: z.enum(CLIENT_SENTIMENTS).nullable(), summary: text(8000) })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, "No hay nada que cambiar.");

const updateItemSchema = z
  .object({
    text: text(500).min(1),
    kind: z.enum(ACTION_ITEM_KINDS).nullable(),
    ownerUserId: z.string().uuid().nullable(),
    projectedHours: z.number().min(0).max(1000).nullable(),
    phase: text(120).nullable(),
    // Las conversiones tienen su propia ruta; aquí solo se acepta, descarta o vuelve a proponer.
    status: z.enum(["proposed", "accepted", "discarded"])
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, "No hay nada que cambiar.");

export const CONVERSIONS = ["task", "change_order", "activity"] as const;
export type Conversion = (typeof CONVERSIONS)[number];
const convertSchema = z
  .object({
    to: z.enum(CONVERSIONS),
    /** Change order: el deal (si la reunión no tiene uno). */
    dealId: z.string().uuid().optional(),
    title: text(500).min(3).optional(),
    hours: z.number().min(0).max(1000).optional(),
    assigneeUserId: z.string().uuid().nullable().optional(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional()
  })
  .strict();
export type ConvertInput = z.infer<typeof convertSchema>;

const SENTIMENT_LABELS: Record<ClientSentiment, string> = { excellent: "Excelente", good: "Bien", neutral: "Neutral", friction: "Fricción" };
const REVIEW_LABELS: Record<MeetingReviewStatus, string> = { new: "Nueva sin procesar", reviewed: "Revisada", actioned: "Accionada", not_needed: "No necesaria" };

/** Dueño de las reuniones (proyecto o lead) ya cargado y con los permisos del usuario. */
export interface MeetingOwner {
  id: string;
  /** Equipo de las reuniones que se registren aquí (el del proyecto; null en un lead). */
  teamId: string | null;
  /** Registrar, revisar y reprocesar reuniones. */
  canWork: boolean;
  /** Contexto para el modelo: de quién es la reunión. */
  context: string;
  /** Conversiones de action items que admite este dueño. */
  conversions: readonly Conversion[];
  /** El deal debe ser del mismo proyecto o lead. */
  validDeal(dealId: string): Promise<boolean>;
  /** Crea la tarea, el change order o la actividad; responde el error y devuelve null si no se puede. */
  convert(user: SessionUser, meeting: MeetingCore, item: ActionItemDoc, input: ConvertInput, reply: FastifyReply): Promise<{ id: string; label: string } | null>;
  /** Deja una novedad del sistema en el dueño. */
  note(user: SessionUser, body: string): Promise<unknown>;
  audit(user: SessionUser, action: string, details: Record<string, string | number | boolean>): Promise<unknown>;
}

/** Action items de la v1 (texto suelto) o ya tipados. */
export const actionItemsOf = (items: MeetingCore["actionItems"] | string[] | undefined): ActionItemDoc[] =>
  (items ?? []).map((item) =>
    typeof item === "string" ? { _id: randomUUID(), text: item, kind: null, ownerName: null, ownerUserId: null, projectedHours: null, phase: null, status: "proposed" as const } : item
  );

const itemView = (item: ActionItemDoc, users: Map<string, string>) => ({
  id: item._id,
  text: item.text,
  kind: item.kind,
  ownerName: item.ownerName,
  owner: item.ownerUserId ? { id: item.ownerUserId, name: users.get(item.ownerUserId) ?? null } : null,
  projectedHours: item.projectedHours,
  phase: item.phase,
  status: item.status,
  taskId: item.taskId ?? null,
  changeOrderId: item.changeOrderId ?? null,
  activityId: item.activityId ?? null
});

/** Nombres de contactos, deals y responsables de un grupo de reuniones. */
export async function meetingViews(store: AdminStore, meetings: MeetingCore[]) {
  const contactIds = [...new Set(meetings.flatMap((m) => m.attendeeContactIds ?? []))];
  const dealIds = [...new Set(meetings.map((m) => m.dealId).filter((v): v is string => Boolean(v)))];
  const userIds = [...new Set(meetings.flatMap((m) => actionItemsOf(m.actionItems).map((a) => a.ownerUserId)).filter((v): v is string => Boolean(v)))];
  const [contacts, deals, users] = await Promise.all([
    contactIds.length ? store.contacts.find({ _id: { $in: contactIds } }, { projection: { name: 1 } }).toArray() : [],
    dealIds.length ? store.deals.find({ _id: { $in: dealIds } }, { projection: { dealCode: 1, title: 1 } }).toArray() : [],
    userIds.length ? store.users.find({ _id: { $in: userIds } }, { projection: { name: 1 } }).toArray() : []
  ]);
  const contactName = new Map(contacts.map((c) => [c._id, c.name]));
  const deal = new Map(deals.map((d) => [d._id, { id: d._id, dealCode: d.dealCode, title: d.title }]));
  const userName = new Map(users.map((u) => [u._id, u.name]));
  return (meeting: MeetingCore, withTranscript = false) => ({
    id: meeting._id,
    title: meeting.title,
    heldAt: meeting.heldAt,
    source: meeting.source,
    kind: meeting.kind ?? null,
    durationMinutes: meeting.durationMinutes ?? null,
    url: meeting.url ?? null,
    deal: meeting.dealId ? (deal.get(meeting.dealId) ?? null) : null,
    attendees: (meeting.attendeeContactIds ?? []).map((id) => ({ id, name: contactName.get(id) ?? null })),
    participants: meeting.participants ?? [],
    status: meeting.status,
    reviewStatus: meeting.reviewStatus ?? "new",
    summary: meeting.summary,
    feedback: meeting.feedback,
    actionItems: actionItemsOf(meeting.actionItems).map((a) => itemView(a, userName)),
    clientSentiment: meeting.clientSentiment ?? null,
    engagement: meeting.engagement ?? null,
    readAi: meeting.readAi ?? null,
    processingError: meeting.processingError ?? null,
    processedAt: meeting.processedAt ?? null,
    transcriptLength: meeting.transcript.length,
    ...(withTranscript ? { transcript: meeting.transcript } : {})
  });
}

const invalid = (reply: FastifyReply, error: z.ZodError) =>
  reply.code(400).send({ error: "Datos inválidos.", issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
const forbidden = (reply: FastifyReply) => reply.code(403).send({ error: "No tienes permiso para esta acción." });

/** Texto de la novedad al terminar el procesamiento. */
export const processedNote = (meeting: MeetingCore) =>
  `Reunión procesada: «${meeting.title}». Sentimiento del cliente: ${meeting.clientSentiment ? SENTIMENT_LABELS[meeting.clientSentiment] : "-"} · ${actionItemsOf(meeting.actionItems).length} action items propuestos.`;

/**
 * Reuniones de un proyecto o de un lead: listado, detalle con transcripción, registro, revisión,
 * reprocesamiento y conversión de action items. Una reunión con transcripción y sin resumen se
 * procesa sola con Claude; Claude propone y una persona decide (§4.2).
 */
export function registerMeetingRoutes<T extends MeetingCore>(
  app: FastifyInstance,
  {
    base,
    store,
    collection,
    ownerKey,
    processing,
    resolve
  }: {
    /** Ruta del dueño, p. ej. "/api/ops/projects/:id". */
    base: string;
    store: AdminStore;
    collection: Collection<T>;
    ownerKey: "projectId" | "leadId";
    processing: MeetingProcessing;
    /** Carga el dueño si el usuario puede verlo; si no, responde (404/403) y devuelve null. */
    resolve(request: FastifyRequest, reply: FastifyReply, id: string): Promise<MeetingOwner | null>;
  }
) {
  const owned = (ownerId: string, extra: Record<string, unknown> = {}) => ({ [ownerKey]: ownerId, ...extra }) as Filter<T>;
  const processed = (owner: MeetingOwner, user: SessionUser) => (meeting: T) => owner.note(user, processedNote(meeting));
  const present = async (meeting: T, withTranscript = false) => (await meetingViews(store, [meeting]))(meeting, withTranscript);

  async function checkLinks(owner: MeetingOwner, input: { dealId?: string | null; attendeeContactIds?: string[] }, reply: FastifyReply) {
    if (input.dealId && !(await owner.validDeal(input.dealId))) {
      void reply.code(400).send({ error: ownerKey === "projectId" ? "El deal no es de este proyecto." : "El deal no es de este lead." });
      return false;
    }
    const ids = input.attendeeContactIds ?? [];
    if (ids.length && (await store.contacts.countDocuments({ _id: { $in: ids } })) !== new Set(ids).size) {
      void reply.code(400).send({ error: "Algún asistente no es un contacto." });
      return false;
    }
    return true;
  }

  /** Carga dueño + reunión; responde y devuelve null si no se puede trabajar en ella. */
  async function load(request: FastifyRequest, reply: FastifyReply, id: string, meetingId: string, work: boolean) {
    const owner = await resolve(request, reply, id);
    if (!owner) return null;
    if (work && !owner.canWork) {
      void forbidden(reply);
      return null;
    }
    const meeting = await collection.findOne(owned(owner.id, { _id: meetingId }));
    if (!meeting) {
      void reply.code(404).send({ error: "Reunión no encontrada." });
      return null;
    }
    return { owner, meeting: meeting as T };
  }

  app.get(`${base}/meetings`, { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const owner = await resolve(request, reply, params.data.id);
    if (!owner) return reply;
    const meetings = (await collection.find(owned(owner.id)).sort({ heldAt: -1 }).limit(200).toArray()) as T[];
    const view = await meetingViews(store, meetings);
    return { meetings: meetings.map((m) => view(m)), processingAvailable: processing.available, conversions: owner.canWork ? owner.conversions : [] };
  });

  app.get(`${base}/meetings/:childId`, { preHandler: requireAuth }, async (request, reply) => {
    const params = idsParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const loaded = await load(request, reply, params.data.id, params.data.childId, false);
    if (!loaded) return reply;
    return { meeting: await present(loaded.meeting, true) };
  });

  app.post(`${base}/meetings`, { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = createMeetingSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const owner = await resolve(request, reply, params.data.id);
    if (!owner) return reply;
    const user = request.user!;
    if (!owner.canWork) return forbidden(reply);
    const input = body.data;
    if (!(await checkLinks(owner, input, reply))) return reply;
    if (input.externalId && (await collection.findOne(owned(owner.id, { externalId: input.externalId })))) {
      return reply.code(409).send({ error: "Esta reunión ya está registrada." });
    }
    const at = new Date();
    const hasSummary = Boolean(input.summary);
    const transcript = input.transcript?.trim() ?? "";
    const meeting = {
      _id: randomUUID(),
      projectId: null,
      leadId: null,
      [ownerKey]: owner.id,
      teamId: owner.teamId,
      title: input.title,
      heldAt: new Date(input.heldAt),
      source: input.source ?? "manual",
      externalId: input.externalId ?? null,
      kind: input.kind ?? null,
      durationMinutes: input.durationMinutes ?? null,
      url: input.url ?? null,
      dealId: input.dealId ?? null,
      attendeeContactIds: [...new Set(input.attendeeContactIds ?? [])],
      participants: [],
      transcript,
      summary: input.summary ?? "",
      feedback: input.feedback ?? [],
      actionItems: actionItemsOf(input.actionItems),
      // Con resumen escrito a mano no hay nada que procesar; con transcripción la procesa Claude.
      status: hasSummary ? "processed" : "pending",
      reviewStatus: "new",
      clientSentiment: null,
      processingError: null,
      createdBy: user.username,
      createdAt: at,
      updatedAt: at
    } as unknown as T;
    await collection.insertOne(meeting as never);
    await owner.audit(user, "meeting_created", { meeting: meeting.title });
    if (!hasSummary && transcript) processing.start(collection, meeting._id, owner.context, processed(owner, user));
    return reply.code(201).send({ meeting: await present(meeting) });
  });

  /** Revisión: tipo, deal, asistentes, estado de proceso y correcciones del resumen o el sentimiento. */
  app.patch(`${base}/meetings/:childId`, { preHandler: requireAuth }, async (request, reply) => {
    const params = idsParams.safeParse(request.params);
    const body = updateMeetingSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const loaded = await load(request, reply, params.data.id, params.data.childId, true);
    if (!loaded) return reply;
    const { owner, meeting } = loaded;
    const patch = body.data;
    if (!(await checkLinks(owner, patch, reply))) return reply;
    const user = request.user!;
    const at = new Date();
    const set: Record<string, unknown> = { ...patch, updatedAt: at };
    if (patch.attendeeContactIds) set.attendeeContactIds = [...new Set(patch.attendeeContactIds)];
    const reviewChanged = patch.reviewStatus && patch.reviewStatus !== (meeting.reviewStatus ?? "new");
    if (reviewChanged) Object.assign(set, { reviewedBy: user.username, reviewedAt: at });
    await collection.updateOne({ _id: meeting._id } as Filter<T>, { $set: set } as never);
    if (reviewChanged) {
      await owner.note(user, `Reunión «${meeting.title}»: ${REVIEW_LABELS[meeting.reviewStatus ?? "new"]} → ${REVIEW_LABELS[patch.reviewStatus!]}`);
      await owner.audit(user, "meeting_reviewed", { meeting: meeting.title, to: patch.reviewStatus! });
    }
    return { meeting: await present((await collection.findOne({ _id: meeting._id } as Filter<T>)) as T) };
  });

  app.patch(`${base}/meetings/:childId/action-items/:itemId`, { preHandler: requireAuth }, async (request, reply) => {
    const params = itemParams.safeParse(request.params);
    const body = updateItemSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const loaded = await load(request, reply, params.data.id, params.data.childId, true);
    if (!loaded) return reply;
    const { meeting } = loaded;
    const items = actionItemsOf(meeting.actionItems);
    const item = items.find((a) => a._id === params.data.itemId);
    if (!item) return reply.code(404).send({ error: "Action item no encontrado." });
    if (body.data.status && ["task", "change_order", "activity"].includes(item.status)) return reply.code(409).send({ error: "Este action item ya se convirtió." });
    if (body.data.ownerUserId && !(await store.users.findOne({ _id: body.data.ownerUserId, active: true }, { projection: { _id: 1 } }))) {
      return reply.code(400).send({ error: "El responsable debe ser un usuario activo." });
    }
    const next = items.map((a) => (a._id === item._id ? { ...a, ...body.data } : a));
    await collection.updateOne({ _id: meeting._id } as Filter<T>, { $set: { actionItems: next, updatedAt: new Date() } } as never);
    return { meeting: await present((await collection.findOne({ _id: meeting._id } as Filter<T>)) as T) };
  });

  /** Una persona convierte el action item en Task, Change Order o actividad comercial. */
  app.post(`${base}/meetings/:childId/action-items/:itemId/convert`, { preHandler: requireAuth }, async (request, reply) => {
    const params = itemParams.safeParse(request.params);
    const body = convertSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const loaded = await load(request, reply, params.data.id, params.data.childId, true);
    if (!loaded) return reply;
    const { owner, meeting } = loaded;
    if (!owner.conversions.includes(body.data.to)) return reply.code(400).send({ error: "Esta conversión no aplica a esta reunión." });
    const items = actionItemsOf(meeting.actionItems);
    const item = items.find((a) => a._id === params.data.itemId);
    if (!item) return reply.code(404).send({ error: "Action item no encontrado." });
    if (["task", "change_order", "activity"].includes(item.status)) return reply.code(409).send({ error: "Este action item ya se convirtió." });
    const user = request.user!;
    const created = await owner.convert(user, meeting, item, body.data, reply);
    if (!created) return reply;
    const field = body.data.to === "task" ? "taskId" : body.data.to === "change_order" ? "changeOrderId" : "activityId";
    const next = items.map((a) => (a._id === item._id ? { ...a, status: body.data.to, [field]: created.id } : a));
    // Convertir algo deja la reunión «Accionada».
    await collection.updateOne(
      { _id: meeting._id } as Filter<T>,
      { $set: { actionItems: next, reviewStatus: "actioned", reviewedBy: user.username, reviewedAt: new Date(), updatedAt: new Date() } } as never
    );
    await owner.note(user, `Action item de «${meeting.title}» convertido en ${created.label}: «${item.text}».`);
    await owner.audit(user, "meeting_action_item_converted", { meeting: meeting.title, to: body.data.to });
    return reply.code(201).send({ created, meeting: await present((await collection.findOne({ _id: meeting._id } as Filter<T>)) as T) });
  });

  /** Procesa (o reintenta) una reunión con transcripción y espera el resultado. */
  app.post(`${base}/meetings/:childId/process`, { preHandler: requireAuth }, async (request, reply) => {
    const params = idsParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const loaded = await load(request, reply, params.data.id, params.data.childId, true);
    if (!loaded) return reply;
    const { owner, meeting } = loaded;
    if (!processing.available) return reply.code(503).send({ error: "El procesamiento automático no está disponible: falta la clave de Anthropic en el servidor." });
    if (!meeting.transcript) return reply.code(409).send({ error: "La reunión no tiene transcripción que procesar." });
    if (meeting.status === "processed") return reply.code(409).send({ error: "La reunión ya está procesada." });
    const result = await processing.process(collection, meeting._id, owner.context, processed(owner, request.user!));
    if (!result) return reply.code(409).send({ error: "La reunión ya se está procesando." });
    return { meeting: await present(result) };
  });
}
