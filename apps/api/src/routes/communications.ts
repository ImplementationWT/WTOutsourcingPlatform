import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import type { SessionUser } from "../auth/users.js";
import { canReadProject, canWorkOnProject, forbidden, projectScope } from "../ops/access.js";
import { ACTIVE_LEAD_STATUSES, leadTitle } from "../sales/models.js";
import type { AdminStore } from "../store/admin-store.js";
import { SALES_READ_ROLES, SALES_ROLES } from "./sales.js";

export const COMMUNICATION_KINDS = ["email", "whatsapp", "slack", "call", "other"] as const;
export const COMMUNICATION_DIRECTIONS = ["sent", "received"] as const;

/** Registro manual de un email, mensaje o llamada con un cliente (proyecto) o un lead. */
export interface CommunicationDoc {
  _id: string;
  kind: (typeof COMMUNICATION_KINDS)[number];
  direction: (typeof COMMUNICATION_DIRECTIONS)[number];
  subject: string;
  body: string;
  /** Persona de la empresa responsable del contacto. */
  ownerUserId: string | null;
  /** Persona del cliente (texto libre). */
  contactName: string;
  date: string; // AAAA-MM-DD
  projectId: string | null;
  leadId: string | null;
  followUpDate: string | null;
  followUpDone: boolean;
  deletedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Días sin contacto antes de avisar: proyectos (7) y leads activos (2). */
export const COLD_DAYS = { project: 7, lead: 2 } as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Usa el formato AAAA-MM-DD.");
const fields = {
  kind: z.enum(COMMUNICATION_KINDS),
  direction: z.enum(COMMUNICATION_DIRECTIONS),
  subject: z.string().trim().max(200),
  body: z.string().trim().max(10_000),
  ownerUserId: z.string().uuid().nullable(),
  contactName: z.string().trim().max(120),
  date: isoDate,
  followUpDate: isoDate.nullable(),
  followUpDone: z.boolean()
};
const createSchema = z
  .object({ ...fields, projectId: z.string().uuid().nullable(), leadId: z.string().uuid().nullable() })
  .partial()
  .required({ kind: true, direction: true })
  .strict()
  .refine((v) => Boolean(v.projectId) !== Boolean(v.leadId), "Relaciónala con un proyecto o con un lead.")
  .refine((v) => Boolean(v.subject?.trim() || v.body?.trim()), "Escribe el asunto o el resumen.");
const updateSchema = z
  .object(fields)
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, "No hay nada que cambiar.");
const idParams = z.object({ id: z.string().uuid() });
const listQuery = z.object({ projectId: z.string().uuid().optional(), leadId: z.string().uuid().optional() }).strict();

const today = () => new Date().toISOString().slice(0, 10);
const daysSince = (date: string, now = today()) => Math.round((Date.parse(`${now}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
const salesWriter = (user: SessionUser) => (SALES_ROLES as readonly string[]).includes(user.role);
const salesReader = (user: SessionUser) => (SALES_READ_ROLES as readonly string[]).includes(user.role);

/**
 * Comunicaciones (registro manual, sin integración con Gmail). Ligadas a un proyecto (lo ven quienes
 * ven el proyecto; escriben CEO/CCO, Comercial y el equipo) o a un lead (como Leads: escriben CEO/CCO
 * y Comercial, Financiera lee).
 */
export async function registerCommunicationRoutes(app: FastifyInstance, { store }: { store: AdminStore }) {
  const comms = store.db.collection<CommunicationDoc>("core_communications");
  await Promise.all([comms.createIndex({ projectId: 1, date: -1 }), comms.createIndex({ leadId: 1, date: -1 }), comms.createIndex({ followUpDate: 1, followUpDone: 1 })]);

  /** Proyectos que ve el usuario (ids) y si ve leads. */
  async function scope(user: SessionUser) {
    const projects = await store.opsProjects.find(projectScope(user), { projection: { _id: 1, name: 1, teamId: 1, stage: 1 } }).toArray();
    return { projects, projectIds: projects.map((p) => p._id), leads: salesReader(user) };
  }
  const visibleFilter = (s: Awaited<ReturnType<typeof scope>>) => ({ deletedAt: null, $or: [{ projectId: { $in: s.projectIds } }, ...(s.leads ? [{ leadId: { $type: "string" as const } }] : [])] });

  async function canWrite(user: SessionUser, c: Pick<CommunicationDoc, "projectId" | "leadId">) {
    if (c.leadId) return salesWriter(user);
    const project = c.projectId ? await store.opsProjects.findOne({ _id: c.projectId }, { projection: { teamId: 1 } }) : null;
    return Boolean(project && canReadProject(user, project) && (user.role === "commercial" || canWorkOnProject(user, project)));
  }

  async function view(rows: CommunicationDoc[]) {
    const userIds = [...new Set(rows.map((r) => r.ownerUserId).filter((v): v is string => Boolean(v)))];
    const projectIds = [...new Set(rows.map((r) => r.projectId).filter((v): v is string => Boolean(v)))];
    const leadIds = [...new Set(rows.map((r) => r.leadId).filter((v): v is string => Boolean(v)))];
    const [users, projects, leads] = await Promise.all([
      userIds.length ? store.users.find({ _id: { $in: userIds } }, { projection: { name: 1 } }).toArray() : [],
      projectIds.length ? store.opsProjects.find({ _id: { $in: projectIds } }, { projection: { name: 1 } }).toArray() : [],
      leadIds.length ? store.leads.find({ _id: { $in: leadIds } }, { projection: { company: 1, contactName: 1, email: 1 } }).toArray() : []
    ]);
    const userName = new Map(users.map((u) => [u._id, u.name]));
    const projectName = new Map(projects.map((p) => [p._id, p.name]));
    const leadName = new Map(leads.map((l) => [l._id, leadTitle(l)]));
    return rows.map((r) => ({
      id: r._id,
      kind: r.kind,
      direction: r.direction,
      subject: r.subject,
      body: r.body,
      owner: r.ownerUserId ? { id: r.ownerUserId, name: userName.get(r.ownerUserId) ?? null } : null,
      contactName: r.contactName,
      date: r.date,
      project: r.projectId ? { id: r.projectId, name: projectName.get(r.projectId) ?? null } : null,
      lead: r.leadId ? { id: r.leadId, name: leadName.get(r.leadId) ?? null } : null,
      followUpDate: r.followUpDate,
      followUpDone: r.followUpDone
    }));
  }

  app.get("/api/communications", { preHandler: requireAuth }, async (request, reply) => {
    const q = listQuery.safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: "Filtro inválido." });
    const user = request.user!;
    const s = await scope(user);
    if (q.data.leadId && !s.leads) return forbidden(reply);
    if (q.data.projectId && !s.projectIds.includes(q.data.projectId)) return reply.code(404).send({ error: "Proyecto no encontrado." });
    const filter = q.data.projectId ? { projectId: q.data.projectId, deletedAt: null } : q.data.leadId ? { leadId: q.data.leadId, deletedAt: null } : visibleFilter(s);
    const rows = await comms.find(filter).sort({ date: -1, createdAt: -1 }).limit(500).toArray();
    const canCreate = q.data.leadId ? salesWriter(user) : q.data.projectId ? await canWrite(user, { projectId: q.data.projectId, leadId: null }) : salesWriter(user);
    // Responsables posibles: CEO/CCO, Comercial y los equipos de los proyectos visibles.
    const teamIds = [...new Set(s.projects.map((p) => p.teamId))];
    const people = await store.users.find({ active: true, $or: [{ role: { $in: ["boss", "commercial"] } }, { teamId: { $in: teamIds } }] }, { projection: { name: 1 } }).sort({ name: 1 }).toArray();
    return { communications: await view(rows), canCreate, people: people.map((u) => ({ id: u._id, name: u.name })) };
  });

  /**
   * Alertas: proyectos sin contacto hace más de 7 días, leads activos sin respuesta hace más de 2
   * días (desde su llegada si nunca se les escribió) y seguimientos vencidos o de hoy.
   */
  app.get("/api/communications/summary", { preHandler: requireAuth }, async (request) => {
    const user = request.user!;
    const s = await scope(user);
    const now = today();
    const visible = visibleFilter(s);
    const [lastByProject, lastByLead, followUps, week] = await Promise.all([
      comms.aggregate<{ _id: string; last: string }>([{ $match: { projectId: { $in: s.projectIds }, deletedAt: null } }, { $group: { _id: "$projectId", last: { $max: "$date" } } }]).toArray(),
      s.leads ? comms.aggregate<{ _id: string; last: string }>([{ $match: { leadId: { $type: "string" }, deletedAt: null } }, { $group: { _id: "$leadId", last: { $max: "$date" } } }]).toArray() : [],
      comms.countDocuments({ ...visible, followUpDone: false, followUpDate: { $type: "string", $lte: now } }),
      comms.countDocuments({ ...visible, date: { $gte: new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10) } })
    ]);
    const lastProject = new Map(lastByProject.map((r) => [r._id, r.last]));
    const lastLead = new Map(lastByLead.map((r) => [r._id, r.last]));
    const cold: { kind: "project" | "lead"; id: string; name: string; days: number | null; since: "contact" | "arrival" | "never" }[] = [];
    for (const p of s.projects.filter((p) => p.stage !== "completed")) {
      const last = lastProject.get(p._id);
      const days = last ? daysSince(last, now) : null;
      if (days === null || days > COLD_DAYS.project) cold.push({ kind: "project", id: p._id, name: p.name, days, since: last ? "contact" : "never" });
    }
    if (s.leads) {
      const leads = await store.leads.find({ status: { $in: [...ACTIVE_LEAD_STATUSES] } }, { projection: { company: 1, contactName: 1, email: 1, submittedAt: 1, createdAt: 1 } }).toArray();
      for (const l of leads) {
        const last = lastLead.get(l._id);
        const from = last ?? l.submittedAt ?? l.createdAt.toISOString().slice(0, 10);
        const days = daysSince(from, now);
        if (days > COLD_DAYS.lead) cold.push({ kind: "lead", id: l._id, name: leadTitle(l), days, since: last ? "contact" : "arrival" });
      }
    }
    cold.sort((a, b) => (b.days ?? 9999) - (a.days ?? 9999));
    return { cold, followUpsDue: followUps, lastWeek: week };
  });

  async function found(request: FastifyRequest, reply: FastifyReply, deleted = false) {
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      void reply.code(400).send({ error: "Id inválido." });
      return null;
    }
    const doc = await comms.findOne({ _id: params.data.id, deletedAt: deleted ? { $type: "date" } : null } as never);
    if (!doc) {
      void reply.code(404).send({ error: "Comunicación no encontrada." });
      return null;
    }
    if (!(await canWrite(request.user!, doc))) {
      void forbidden(reply);
      return null;
    }
    return doc;
  }

  app.post("/api/communications", { preHandler: requireAuth }, async (request, reply) => {
    const body = createSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? "Datos inválidos." });
    const input = body.data;
    const user = request.user!;
    if (input.leadId && !(await store.leads.findOne({ _id: input.leadId }))) return reply.code(400).send({ error: "El lead no existe." });
    if (!(await canWrite(user, { projectId: input.projectId ?? null, leadId: input.leadId ?? null }))) return forbidden(reply);
    if (input.ownerUserId && !(await store.users.findOne({ _id: input.ownerUserId, active: true }))) return reply.code(400).send({ error: "El responsable no existe." });
    const at = new Date();
    const doc: CommunicationDoc = {
      _id: randomUUID(),
      kind: input.kind,
      direction: input.direction,
      subject: input.subject ?? "",
      body: input.body ?? "",
      ownerUserId: input.ownerUserId === undefined ? user.id : input.ownerUserId,
      contactName: input.contactName ?? "",
      date: input.date ?? today(),
      projectId: input.projectId ?? null,
      leadId: input.leadId ?? null,
      followUpDate: input.followUpDate ?? null,
      followUpDone: input.followUpDone ?? false,
      deletedAt: null,
      createdBy: user.username,
      createdAt: at,
      updatedAt: at
    };
    await comms.insertOne(doc);
    await store.audit({ actor: user.username, action: "communications.created", clientId: doc.projectId ? `ops:${doc.projectId}` : `lead:${doc.leadId}`, target: doc.subject || doc.kind });
    return reply.code(201).send({ communication: (await view([doc]))[0] });
  });

  app.patch("/api/communications/:id", { preHandler: requireAuth }, async (request, reply) => {
    const body = updateSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? "Datos inválidos." });
    const doc = await found(request, reply);
    if (!doc) return reply;
    await comms.updateOne({ _id: doc._id }, { $set: { ...body.data, updatedAt: new Date() } });
    return { communication: (await view([(await comms.findOne({ _id: doc._id }))!]))[0] };
  });

  app.delete("/api/communications/:id", { preHandler: requireAuth }, async (request, reply) => {
    const doc = await found(request, reply);
    if (!doc) return reply;
    await comms.updateOne({ _id: doc._id }, { $set: { deletedAt: new Date() } });
    return { ok: true };
  });

  app.post("/api/communications/:id/restore", { preHandler: requireAuth }, async (request, reply) => {
    const doc = await found(request, reply, true);
    if (!doc) return reply;
    await comms.updateOne({ _id: doc._id }, { $set: { deletedAt: null } });
    return { ok: true };
  });
}
