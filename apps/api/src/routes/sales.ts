import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Filter } from "mongodb";
import { z } from "zod";
import { requireRole } from "../auth/session.js";
import type { SessionUser } from "../auth/users.js";
import type { MeetingProcessing } from "../meetings/processing.js";
import { registerMeetingRoutes } from "../meetings/routes.js";
import {
  ACTIVE_LEAD_STATUSES,
  type ActivityDoc,
  advanceTo,
  COLD_LEAD_STATUSES,
  DEMO_STATUSES,
  type DemoDoc,
  LEAD_FUNNELS,
  LEAD_STATUSES,
  LEAD_TEMPERATURES,
  type LeadDoc,
  type LeadStatus,
  leadTitle,
  type ProposalDoc,
  responseDays
} from "../sales/models.js";
import { runTableQuery, tableQuerySchema } from "../lib/table-query.js";
import { createProposalSchema, PROPOSAL_LABELS, proposalView, statusDates, updateProposalSchema } from "../sales/proposals.js";
import type { AdminStore } from "../store/admin-store.js";

/** Contexto de una reunión comercial para el modelo. */
export const leadMeetingContext = (lead: Pick<LeadDoc, "company" | "contactName" | "status">) =>
  `Reunión comercial con un prospecto. Empresa: ${lead.company || "sin indicar"}. Contacto: ${lead.contactName || "sin indicar"}. Etapa: ${STATUS_LABELS[lead.status]}.`;

/** Comercial es del CEO/CCO y del área Comercial (Marketing); Financiera lo lee (§6). */
export const SALES_ROLES = ["boss", "commercial"] as const;
export const SALES_READ_ROLES = ["boss", "commercial", "finance"] as const;
const requireSales = requireRole(...SALES_ROLES);
const requireSalesRead = requireRole(...SALES_READ_ROLES);
const isSales = (user: SessionUser) => (SALES_ROLES as readonly string[]).includes(user.role);
const canReadSales = (user: SessionUser) => (SALES_READ_ROLES as readonly string[]).includes(user.role);

const idParams = z.object({ id: z.string().uuid() });
const idsParams = z.object({ id: z.string().uuid(), childId: z.string().uuid() });
const text = (max: number) => z.string().trim().max(max);
const optionalUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => /^https?:\/\//i.test(v), "Debe empezar por http:// o https://")
  .nullable();
const email = z.string().trim().toLowerCase().email().max(200).nullable();

const STATUS_LABELS: Record<LeadStatus, string> = {
  new: "Nuevo",
  contacted: "Contactado",
  demo: "Demo",
  proposal_sent: "Propuesta enviada",
  won: "Ganado",
  lost: "Perdido",
  nurturing: "Nurturing",
  unqualified: "No calificado"
};
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Usa el formato AAAA-MM-DD.").nullable();
const uuidOrNull = z.string().uuid().nullable();

const leadFields = {
  company: text(120),
  contactName: text(120),
  email,
  phone: text(40).nullable(),
  notes: text(4000),
  setterUserId: uuidOrNull,
  closerUserId: uuidOrNull,
  funnel: z.enum(LEAD_FUNNELS).nullable(),
  temperature: z.enum(LEAD_TEMPERATURES).nullable(),
  submittedAt: isoDate,
  meetingAt: isoDate,
  proposalUrl: optionalUrl,
  /** De dónde vino (texto: "Referido", "Formulario web"…). */
  source: text(80).min(2),
  /** Enlace a un Contacto que ya existe. */
  contactId: uuidOrNull
};
const createLeadSchema = z
  .object(leadFields)
  .partial()
  .strict()
  .refine((v) => Boolean(v.company || v.contactName || v.email), "Indica al menos la empresa, el contacto o el correo.");
const updateLeadSchema = z
  .object({ ...leadFields, status: z.enum(LEAD_STATUSES), lostReason: text(500).nullable() })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "No hay nada que cambiar.");

const demoFields = { title: text(160).min(3), scheduledAt: z.string().datetime({ offset: true }), url: optionalUrl, notes: text(2000), status: z.enum(DEMO_STATUSES) };
const createDemoSchema = z
  .object({ title: demoFields.title, scheduledAt: demoFields.scheduledAt, url: demoFields.url.optional(), notes: demoFields.notes.optional(), status: demoFields.status.optional() })
  .strict();
const updateDemoSchema = z
  .object(demoFields)
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "No hay nada que cambiar.");

const updateNoteSchema = z.object({ body: text(4000).min(1) }).strict();

/** Tabla de leads: vista activos / fríos / ganados y filtros; paginada en el servidor. */
const listQuery = tableQuerySchema.extend({
  view: z.enum(["active", "cold", "won"]).optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  source: text(80).optional(),
  funnel: z.enum(LEAD_FUNNELS).optional(),
  temperature: z.enum(LEAD_TEMPERATURES).optional(),
  setterUserId: z.string().uuid().optional(),
  closerUserId: z.string().uuid().optional()
});
const VIEW_STATUSES = { active: ACTIVE_LEAD_STATUSES, cold: COLD_LEAD_STATUSES, won: ["won"] } as const;

const demosQuery = tableQuerySchema.extend({ status: z.enum(DEMO_STATUSES).optional(), leadId: z.string().uuid().optional() });
const learningSchema = z.object({ text: text(2000).min(3) }).strict();

const invalid = (reply: FastifyReply, error: z.ZodError) =>
  reply.code(400).send({ error: "Datos inválidos.", issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });

const demoView = (demo: DemoDoc) => ({
  id: demo._id,
  leadId: demo.leadId,
  title: demo.title,
  scheduledAt: demo.scheduledAt,
  url: demo.url,
  notes: demo.notes,
  status: demo.status,
  learnings: (demo.learnings ?? []).map((l) => ({ id: l._id, text: l.text, authorName: l.authorName, createdAt: l.createdAt })),
  updatedAt: demo.updatedAt
});

/** Responsable del lead (Closer) de la v1. */
const closerOf = (lead: LeadDoc) => lead.closerUserId ?? lead.ownerUserId ?? null;

/** Comercial: leads, demos, propuestas, novedades y reuniones. */
export async function registerSalesRoutes(app: FastifyInstance, { store, meetings }: { store: AdminStore; meetings: MeetingProcessing }) {
  const auditSales = (user: SessionUser, lead: LeadDoc, action: string, details?: Record<string, string | number | boolean>) =>
    store.audit({ actor: user.username, action, clientId: `sales:${lead._id}`, target: leadTitle(lead), ...(details ? { details } : {}) });

  const note = (user: Pick<SessionUser, "username" | "name">, leadId: string, body: string) =>
    store.leadUpdates.insertOne({ _id: randomUUID(), leadId, kind: "system", body, authorUsername: user.username, authorName: user.name, createdAt: new Date() });

  const touch = (leadId: string, set: Partial<LeadDoc> = {}) => store.leads.updateOne({ _id: leadId }, { $set: { ...set, updatedAt: new Date() } });

  async function readableLead(reply: FastifyReply, id: string) {
    const lead = await store.leads.findOne({ _id: id });
    if (!lead) {
      void reply.code(404).send({ error: "Lead no encontrado." });
      return null;
    }
    return lead;
  }

  /** Responsable del lead: un usuario activo de Comercial o un CEO/CCO. */
  async function validOwner(id: string | null | undefined) {
    if (!id) return true;
    return Boolean(await store.users.findOne({ _id: id, active: true, role: { $in: [...SALES_ROLES] } }));
  }

  /** El contacto enlazado a mano debe existir. */
  async function checkCoreLinks(input: { contactId?: string | null }, reply: FastifyReply) {
    if (input.contactId && !(await store.contacts.findOne({ _id: input.contactId }, { projection: { _id: 1 } }))) {
      void reply.code(400).send({ error: "El contacto no existe." });
      return false;
    }
    return true;
  }

  async function leadViews(leads: LeadDoc[]) {
    const ids = (pick: (l: LeadDoc) => (string | null | undefined)[]) => [...new Set(leads.flatMap(pick).filter((v): v is string => Boolean(v)))];
    const userIds = ids((l) => [l.setterUserId, closerOf(l)]);
    const contactIds = ids((l) => [l.contactId]);
    const dealIds = ids((l) => [l.dealId]);
    const [owners, contacts, deals] = await Promise.all([
      userIds.length ? store.users.find({ _id: { $in: userIds } }, { projection: { name: 1 } }).toArray() : [],
      contactIds.length ? store.contacts.find({ _id: { $in: contactIds } }, { projection: { name: 1 } }).toArray() : [],
      dealIds.length ? store.deals.find({ _id: { $in: dealIds } }, { projection: { dealCode: 1, title: 1 } }).toArray() : []
    ]);
    const names = new Map(owners.map((u) => [u._id, u.name]));
    const contactName = new Map(contacts.map((c) => [c._id, c.name]));
    const deal = new Map(deals.map((d) => [d._id, { id: d._id, dealCode: d.dealCode, title: d.title }]));
    const person = (id: string | null | undefined) => (id ? { id, name: names.get(id) ?? null } : null);
    return (lead: LeadDoc, full = false) => ({
      id: lead._id,
      title: leadTitle(lead),
      company: lead.company,
      contactName: lead.contactName,
      email: lead.email,
      phone: lead.phone,
      notes: lead.notes,
      status: lead.status,
      source: lead.sourceName,
      setter: person(lead.setterUserId),
      closer: person(closerOf(lead)),
      funnel: lead.funnel ?? null,
      temperature: lead.temperature ?? null,
      submittedAt: lead.submittedAt ?? null,
      meetingAt: lead.meetingAt ?? null,
      /** (calc) días entre la llegada y la primera reunión. */
      responseDays: responseDays(lead.submittedAt, lead.meetingAt),
      proposalUrl: lead.proposalUrl ?? null,
      lostReason: lead.lostReason,
      contactId: lead.contactId ?? null,
      dealId: lead.dealId ?? null,
      /** Enlace al Contacto (los textos `company` y `contactName` son del lead). */
      contactRef: lead.contactId ? { id: lead.contactId, name: contactName.get(lead.contactId) ?? null } : null,
      deal: lead.dealId ? (deal.get(lead.dealId) ?? null) : null,
      projectId: lead.projectId,
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
      ...(full ? { fields: lead.fields, rawJson: lead.rawJson } : {})
    });
  }

  // ---- responsables ------------------------------------------------------------

  app.get("/api/sales/owners", { preHandler: requireSales }, async () => {
    const users = await store.users.find({ active: true, role: { $in: [...SALES_ROLES] } }, { projection: { name: 1, role: 1 } }).sort({ name: 1 }).toArray();
    return { owners: users.map((u) => ({ id: u._id, name: u.name, role: u.role })) };
  });

  // ---- leads -------------------------------------------------------------------

  app.get("/api/sales/leads", { preHandler: requireSalesRead }, async (request, reply) => {
    const query = listQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, query.error);
    const { view, status, source, funnel, temperature, setterUserId, closerUserId } = query.data;
    // Sin el estado: así el embudo muestra cuántos hay en cada etapa con los demás filtros.
    const base = {
      ...(view ? { status: { $in: [...VIEW_STATUSES[view]] } } : {}),
      ...(source ? { sourceName: source } : {}),
      ...(funnel ? { funnel } : {}),
      ...(temperature ? { temperature } : {}),
      ...(setterUserId ? { setterUserId } : {}),
      ...(closerUserId ? { $or: [{ closerUserId }, { closerUserId: { $exists: false }, ownerUserId: closerUserId }] } : {})
    };
    const match = (status ? { ...base, status: view && !(VIEW_STATUSES[view] as readonly string[]).includes(status) ? "__none__" : status } : base) as Filter<LeadDoc>;
    const [result, counts] = await Promise.all([
      runTableQuery(store.leads, {
        match,
        query: query.data,
        sortable: {
          company: "company",
          contactName: "contactName",
          status: { field: "status", order: LEAD_STATUSES },
          temperature: { field: "temperature", order: LEAD_TEMPERATURES },
          funnel: "funnel",
          submittedAt: "submittedAt",
          meetingAt: "meetingAt",
          createdAt: "createdAt",
          updatedAt: "updatedAt"
        },
        defaultSort: { key: "updatedAt", dir: "desc" },
        search: ["company", "contactName", "email", "phone"],
        facetField: "status",
        projection: { fields: 0, rawJson: 0 }
      }),
      store.leads.aggregate<{ _id: LeadStatus; count: number }>([{ $match: base as Filter<LeadDoc> }, { $group: { _id: "$status", count: { $sum: 1 } } }]).toArray()
    ]);
    const present = await leadViews(result.rows);
    return {
      ...result,
      rows: result.rows.map((l) => present(l)),
      counts: Object.fromEntries(LEAD_STATUSES.map((st) => [st, counts.find((c) => c._id === st)?.count ?? 0])),
      canWrite: isSales(request.user!)
    };
  });

  app.post("/api/sales/leads", { preHandler: requireSales }, async (request, reply) => {
    const body = createLeadSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const user = request.user!;
    if (!(await validOwner(body.data.setterUserId)) || !(await validOwner(body.data.closerUserId))) return reply.code(400).send({ error: "El Setter y el Closer deben ser personas activas de Comercial." });
    if (!(await checkCoreLinks(body.data, reply))) return reply;
    const at = new Date();
    const lead: LeadDoc = {
      _id: randomUUID(),
      sourceName: body.data.source ?? "Manual",
      externalId: null,
      status: "new",
      company: body.data.company ?? "",
      contactName: body.data.contactName ?? "",
      email: body.data.email ?? null,
      phone: body.data.phone || null,
      notes: body.data.notes ?? "",
      fields: [],
      rawJson: null,
      setterUserId: body.data.setterUserId ?? (user.role === "commercial" ? user.id : null),
      closerUserId: body.data.closerUserId ?? null,
      funnel: body.data.funnel ?? null,
      temperature: body.data.temperature ?? null,
      submittedAt: body.data.submittedAt ?? at.toISOString().slice(0, 10),
      meetingAt: body.data.meetingAt ?? null,
      proposalUrl: body.data.proposalUrl ?? null,
      contactId: body.data.contactId ?? null,
      lostReason: null,
      projectId: null,
      createdBy: user.username,
      createdAt: at,
      updatedAt: at
    };
    await store.leads.insertOne(lead);
    await note(user, lead._id, "Lead creado a mano.");
    await auditSales(user, lead, "sales.lead_created");
    const view = await leadViews([lead]);
    return reply.code(201).send({ lead: view(lead, true) });
  });

  app.get("/api/sales/leads/:id", { preHandler: requireSalesRead }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const lead = await readableLead(reply, params.data.id);
    if (!lead) return reply;
    const [demos, proposals, project, deals, activities] = await Promise.all([
      store.demos.find({ leadId: lead._id }).sort({ scheduledAt: -1 }).toArray(),
      store.proposals.find({ leadId: lead._id }).sort({ createdAt: -1 }).toArray(),
      lead.projectId ? store.opsProjects.findOne({ _id: lead.projectId }, { projection: { name: 1, stage: 1, health: 1 } }) : null,
      store.deals.find({ $or: [{ leadId: lead._id }, ...(lead.dealId ? [{ _id: lead.dealId }] : [])] }, { projection: { dealCode: 1, title: 1, status: 1, amountCents: 1, currency: 1 } }).sort({ createdAt: -1 }).limit(50).toArray(),
      store.activities.countDocuments({ leadId: lead._id, status: "pending" })
    ]);
    const view = await leadViews([lead]);
    return {
      lead: view(lead, true),
      demos: demos.map(demoView),
      proposals: proposals.map(proposalView),
      project: project ? { id: project._id, name: project.name, stage: project.stage, health: project.health } : null,
      /** Deals del lead (los que lo tienen como origen). */
      deals: deals.map((d) => ({ id: d._id, dealCode: d.dealCode, title: d.title, status: d.status, amountCents: d.amountCents, currency: d.currency })),
      pendingActivities: activities,
      canWrite: isSales(request.user!)
    };
  });

  app.patch("/api/sales/leads/:id", { preHandler: requireSales }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = updateLeadSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const lead = await readableLead(reply, params.data.id);
    if (!lead) return reply;
    const user = request.user!;
    const patch = body.data;
    if (!(await validOwner(patch.setterUserId)) || !(await validOwner(patch.closerUserId))) return reply.code(400).send({ error: "El Setter y el Closer deben ser personas activas de Comercial." });
    if (!(await checkCoreLinks(patch, reply))) return reply;

    const changes: string[] = [];
    if (patch.status && patch.status !== lead.status) changes.push(`Estado: ${STATUS_LABELS[lead.status]} → ${STATUS_LABELS[patch.status]}`);
    if (patch.status === "lost" && patch.lostReason) changes.push(`Motivo: ${patch.lostReason}`);
    if (patch.setterUserId !== undefined && patch.setterUserId !== (lead.setterUserId ?? null)) changes.push("Cambió el Setter.");
    if (patch.closerUserId !== undefined && patch.closerUserId !== closerOf(lead)) changes.push("Cambió el Closer.");
    if (patch.temperature !== undefined && patch.temperature !== (lead.temperature ?? null)) changes.push(`Temperatura: ${patch.temperature ?? "sin definir"}`);
    const { source, ...rest } = patch;
    await touch(lead._id, { ...rest, ...(source ? { sourceName: source } : {}), ...(patch.status && patch.status !== "lost" ? { lostReason: null } : {}) });
    if (changes.length) {
      await note(user, lead._id, changes.join("\n"));
      await auditSales(user, lead, patch.status && patch.status !== lead.status ? "sales.lead_status_changed" : "sales.lead_updated", patch.status ? { from: lead.status, to: patch.status } : undefined);
    }
    const fresh = (await store.leads.findOne({ _id: lead._id }))!;
    const view = await leadViews([fresh]);
    return { lead: view(fresh, true) };
  });

  // ---- demos -------------------------------------------------------------------

  /** Tabla de demos de todos los leads. */
  app.get("/api/sales/demos", { preHandler: requireSalesRead }, async (request, reply) => {
    const query = demosQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, query.error);
    const { status, leadId } = query.data;
    const result = await runTableQuery(store.demos, {
      match: { ...(status ? { status } : {}), ...(leadId ? { leadId } : {}) },
      query: query.data,
      sortable: { title: "title", scheduledAt: "scheduledAt", status: { field: "status", order: DEMO_STATUSES } },
      defaultSort: { key: "scheduledAt", dir: "desc" },
      search: ["title", "notes"],
      facetField: "status"
    });
    const leadIds = [...new Set(result.rows.map((d) => d.leadId))];
    const leads = leadIds.length ? await store.leads.find({ _id: { $in: leadIds } }, { projection: { company: 1, contactName: 1, email: 1 } }).toArray() : [];
    const title = new Map(leads.map((l) => [l._id, leadTitle(l)]));
    return { ...result, rows: result.rows.map((d) => ({ ...demoView(d), lead: { id: d.leadId, title: title.get(d.leadId) ?? null } })), canWrite: isSales(request.user!) };
  });

  /** Aprendizaje de la demo: lo que se aprendió (objeciones, qué gustó, qué faltó). */
  app.post("/api/sales/leads/:id/demos/:childId/learnings", { preHandler: requireSales }, async (request, reply) => {
    const params = idsParams.safeParse(request.params);
    const body = learningSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const lead = await readableLead(reply, params.data.id);
    if (!lead) return reply;
    const user = request.user!;
    const learning = { _id: randomUUID(), text: body.data.text, authorName: user.name, createdAt: new Date() };
    const updated = await store.demos.findOneAndUpdate({ _id: params.data.childId, leadId: lead._id }, { $push: { learnings: learning }, $set: { updatedAt: new Date() } }, { returnDocument: "after" });
    if (!updated) return reply.code(404).send({ error: "Demo no encontrada." });
    await auditSales(user, lead, "sales.demo_learning_added", { demo: updated.title });
    return reply.code(201).send({ demo: demoView(updated) });
  });

  app.post("/api/sales/leads/:id/demos", { preHandler: requireSales }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = createDemoSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const lead = await readableLead(reply, params.data.id);
    if (!lead) return reply;
    const user = request.user!;
    const at = new Date();
    const demo: DemoDoc = {
      _id: randomUUID(),
      leadId: lead._id,
      title: body.data.title,
      scheduledAt: new Date(body.data.scheduledAt),
      url: body.data.url ?? null,
      notes: body.data.notes ?? "",
      status: body.data.status ?? "scheduled",
      createdBy: user.username,
      createdAt: at,
      updatedAt: at
    };
    await store.demos.insertOne(demo);
    await touch(lead._id, { status: advanceTo(lead.status, "demo") });
    await note(user, lead._id, `Demo agendada: «${demo.title}».`);
    await auditSales(user, lead, "sales.demo_created", { demo: demo.title });
    return reply.code(201).send({ demo: demoView(demo) });
  });

  app.patch("/api/sales/leads/:id/demos/:childId", { preHandler: requireSales }, async (request, reply) => {
    const params = idsParams.safeParse(request.params);
    const body = updateDemoSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const lead = await readableLead(reply, params.data.id);
    if (!lead) return reply;
    const demo = await store.demos.findOne({ _id: params.data.childId, leadId: lead._id });
    if (!demo) return reply.code(404).send({ error: "Demo no encontrada." });
    const { scheduledAt, ...rest } = body.data;
    await store.demos.updateOne({ _id: demo._id }, { $set: { ...rest, ...(scheduledAt ? { scheduledAt: new Date(scheduledAt) } : {}), updatedAt: new Date() } });
    if (rest.status && rest.status !== demo.status) await note(request.user!, lead._id, `Demo «${demo.title}»: ${demo.status} → ${rest.status}`);
    await touch(lead._id);
    return { demo: demoView((await store.demos.findOne({ _id: demo._id }))!) };
  });

  // ---- propuestas --------------------------------------------------------------

  app.post("/api/sales/leads/:id/proposals", { preHandler: requireSales }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = createProposalSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    if (body.data.dealId) return reply.code(400).send({ error: "Las propuestas por deal se crean desde el proyecto en Operativa." });
    const lead = await readableLead(reply, params.data.id);
    if (!lead) return reply;
    const user = request.user!;
    const at = new Date();
    const status = body.data.status ?? "draft";
    const proposal: ProposalDoc = {
      _id: randomUUID(),
      leadId: lead._id,
      projectId: lead.projectId,
      dealId: null,
      title: body.data.title,
      url: body.data.url,
      amountCents: body.data.amountCents ?? null,
      currency: body.data.currency ?? "USD",
      status,
      area: "commercial",
      ...statusDates(status, null, at),
      createdBy: user.username,
      createdAt: at,
      updatedAt: at
    };
    await store.proposals.insertOne(proposal);
    if (status === "sent") await touch(lead._id, { status: advanceTo(lead.status, "proposal_sent") });
    else await touch(lead._id);
    await note(user, lead._id, `Nueva propuesta: «${proposal.title}» (${PROPOSAL_LABELS[status]}).`);
    await auditSales(user, lead, "sales.proposal_created", { proposal: proposal.title });
    return reply.code(201).send({ proposal: proposalView(proposal) });
  });

  app.patch("/api/sales/leads/:id/proposals/:childId", { preHandler: requireSales }, async (request, reply) => {
    const params = idsParams.safeParse(request.params);
    const body = updateProposalSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    if (body.data.dealId) return reply.code(400).send({ error: "Las propuestas por deal se gestionan desde el proyecto en Operativa." });
    const lead = await readableLead(reply, params.data.id);
    if (!lead) return reply;
    const proposal = await store.proposals.findOne({ _id: params.data.childId, leadId: lead._id });
    if (!proposal) return reply.code(404).send({ error: "Propuesta no encontrada." });
    const user = request.user!;
    const patch = body.data;
    const at = new Date();
    await store.proposals.updateOne({ _id: proposal._id }, { $set: { ...patch, ...(patch.status ? statusDates(patch.status, proposal.status, at) : {}), updatedAt: at } });
    if (patch.status && patch.status !== proposal.status) {
      if (patch.status === "sent") await touch(lead._id, { status: advanceTo(lead.status, "proposal_sent") });
      await note(user, lead._id, `Propuesta «${proposal.title}»: ${PROPOSAL_LABELS[proposal.status]} → ${PROPOSAL_LABELS[patch.status]}`);
      await auditSales(user, lead, "sales.proposal_status_changed", { proposal: proposal.title, from: proposal.status, to: patch.status });
    }
    return { proposal: proposalView((await store.proposals.findOne({ _id: proposal._id }))!) };
  });

  // ---- novedades ---------------------------------------------------------------

  app.get("/api/sales/leads/:id/updates", { preHandler: requireSalesRead }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const lead = await readableLead(reply, params.data.id);
    if (!lead) return reply;
    const updates = await store.leadUpdates.find({ leadId: lead._id }).sort({ createdAt: -1 }).limit(200).toArray();
    return { updates: updates.map((u) => ({ id: u._id, kind: u.kind, body: u.body, authorName: u.authorName, createdAt: u.createdAt })) };
  });

  app.post("/api/sales/leads/:id/updates", { preHandler: requireSales }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = updateNoteSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const lead = await readableLead(reply, params.data.id);
    if (!lead) return reply;
    const user = request.user!;
    const doc = { _id: randomUUID(), leadId: lead._id, kind: "manual" as const, body: body.data.body, authorUsername: user.username, authorName: user.name, createdAt: new Date() };
    await store.leadUpdates.insertOne(doc);
    // Primer contacto registrado: el lead deja de ser nuevo.
    await touch(lead._id, { status: advanceTo(lead.status, "contacted") });
    return reply.code(201).send({ update: { id: doc._id, kind: doc.kind, body: doc.body, authorName: doc.authorName, createdAt: doc.createdAt } });
  });

  // ---- reuniones ---------------------------------------------------------------

  registerMeetingRoutes(app, {
    base: "/api/sales/leads/:id",
    store,
    collection: store.meetings,
    ownerKey: "leadId",
    processing: meetings,
    resolve: async (request, reply, id) => {
      // Las reuniones comerciales: Comercial las trabaja, Financiera las lee (§6).
      if (!canReadSales(request.user!)) {
        void reply.code(403).send({ error: "No tienes permiso para esta acción." });
        return null;
      }
      const lead = await readableLead(reply, id);
      if (!lead) return null;
      return {
        id: lead._id,
        teamId: null,
        canWork: isSales(request.user!),
        context: leadMeetingContext(lead),
        conversions: ["activity"],
        validDeal: async (dealId) => Boolean(await store.deals.findOne({ _id: dealId, leadId: lead._id }, { projection: { _id: 1 } })),
        // Action item comercial → actividad del lead (o de su deal, si la reunión es de un deal).
        convert: async (user, meeting, item, input) => {
          const at = new Date();
          const activity: ActivityDoc = {
            _id: randomUUID(),
            title: (input.title ?? item.text).slice(0, 160),
            kind: "follow_up",
            ownerUserId: input.assigneeUserId !== undefined ? input.assigneeUserId : (item.ownerUserId ?? user.id),
            dueDate: input.dueDate ?? null,
            status: "pending",
            leadId: lead._id,
            dealId: meeting.dealId ?? null,
            notes: `Desde la reunión «${meeting.title}».`,
            createdBy: user.username,
            createdAt: at,
            updatedAt: at
          };
          await store.activities.insertOne(activity);
          return { id: activity._id, label: "actividad" };
        },
        note: (user, body) => note(user, lead._id, body),
        audit: (user, action, details) => auditSales(user, lead, `sales.${action}`, details)
      };
    }
  });
}
