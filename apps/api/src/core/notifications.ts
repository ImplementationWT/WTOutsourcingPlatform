import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import type { OpsProjectDoc } from "../ops/models.js";
import type { LeadDoc } from "../sales/models.js";
import type { AdminStore } from "../store/admin-store.js";

export const NOTIFICATION_KINDS = ["assignment", "communication", "deal", "activity", "update", "mention", "project"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Aviso para una persona (campana del header). `link` es la ruta del panel que lo abre. */
export interface NotificationDoc {
  _id: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  link: string;
  actorName: string;
  read: boolean;
  createdAt: Date;
}

const collection = (store: AdminStore) => store.db.collection<NotificationDoc>("core_notifications");

/** Quien hizo el cambio (no se avisa a sí mismo). */
export type Actor = { id?: string; name: string };

/**
 * Deja un aviso a cada persona de `userIds` (sin repetir, sin el autor y solo usuarios activos).
 * Nunca falla la acción que lo dispara: si no se puede guardar, se ignora.
 */
export async function notify(store: AdminStore, userIds: (string | null | undefined)[], actor: Actor, note: { kind: NotificationKind; title: string; body?: string; link: string }) {
  try {
    const ids = [...new Set(userIds.filter((id): id is string => Boolean(id) && id !== actor.id))];
    if (!ids.length) return;
    const active = await store.users.find({ _id: { $in: ids }, active: true }, { projection: { _id: 1 } }).toArray();
    if (!active.length) return;
    const at = new Date();
    await collection(store).insertMany(active.map((u) => ({ _id: randomUUID(), userId: u._id, kind: note.kind, title: note.title.slice(0, 200), body: (note.body ?? "").slice(0, 400), link: note.link, actorName: actor.name, read: false, createdAt: at })));
  } catch {
    // Un aviso que no se guarda no debe romper la acción principal.
  }
}

/** Personas de un proyecto: su Team Leader y sus developers. */
export const projectPeople = (project: Pick<OpsProjectDoc, "leadUserId" | "developerUserId" | "developerUserIds">) => [project.leadUserId, ...(project.developerUserIds ?? []), project.developerUserId];

/** Personas de un lead: Setter y Closer (o el owner de los leads viejos). */
export const leadPeople = (lead: Pick<LeadDoc, "setterUserId" | "closerUserId"> & { ownerUserId?: string | null }) => [lead.setterUserId, lead.closerUserId ?? lead.ownerUserId];

/** Rutas del panel que abren lo que se avisa. */
export const links = {
  project: (id: string, tab?: string) => `/operativa/${id}${tab ? `?tab=${tab}` : ""}`,
  lead: (id: string) => `/comercial/leads/${id}`,
  tasks: (projectId: string) => `/operativa/tasks?project=${projectId}`,
};

/** Menciones «@Nombre» de un texto: solo las de `mentions` (ids elegidos al escribir) que aparecen en él. */
export async function mentionedUsers(store: AdminStore, body: string, mentions: string[] | undefined) {
  if (!mentions?.length) return [];
  const users = await store.users.find({ _id: { $in: [...new Set(mentions)].slice(0, 20) }, active: true }, { projection: { name: 1 } }).toArray();
  return users.filter((u) => body.includes(`@${u.name}`)).map((u) => u._id);
}

/** Campana: los avisos de quien consulta, marcar como leídos y las personas que se pueden mencionar. */
export async function registerNotificationRoutes(app: FastifyInstance, { store }: { store: AdminStore }) {
  const notes = collection(store);

  app.get("/api/notifications", { preHandler: requireAuth }, async (request) => {
    const user = request.user!;
    const [items, unread] = await Promise.all([notes.find({ userId: user.id }).sort({ createdAt: -1 }).limit(40).toArray(), notes.countDocuments({ userId: user.id, read: false })]);
    return { items: items.map(({ _id, userId: _u, ...n }) => ({ id: _id, ...n })), unread };
  });

  app.post("/api/notifications/:id/read", { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    await notes.updateOne({ _id: params.data.id, userId: request.user!.id }, { $set: { read: true } });
    return { ok: true };
  });

  app.post("/api/notifications/read-all", { preHandler: requireAuth }, async (request) => {
    await notes.updateMany({ userId: request.user!.id, read: false }, { $set: { read: true } });
    return { ok: true };
  });

  /** Personas activas para mencionar con «@» (nombre e id; sin datos de contacto). */
  app.get("/api/notifications/people", { preHandler: requireAuth }, async () => {
    const users = await store.users.find({ active: true }, { projection: { name: 1 } }).sort({ name: 1 }).toArray();
    return { people: users.map((u) => ({ id: u._id, name: u.name })) };
  });
}
