import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { type Filter, MongoServerError } from "mongodb";
import { z } from "zod";
import { requireRole } from "../auth/session.js";
import type { SessionUser } from "../auth/users.js";
import { registerSecret } from "../lib/redact.js";
import type { MeetingProcessing } from "../meetings/processing.js";
import { registerMeetingRoutes } from "../meetings/routes.js";
import { type DealDoc, dealCodeOf, type OpsProjectDoc } from "../ops/models.js";
import { hashIngestKey, leadTitle, newIngestKey } from "../sales/ingest.js";
import {
  ACTIVE_LEAD_STATUSES,
  type ActivityDoc,
  advanceTo,
  COLD_LEAD_STATUSES,
  DEMO_STATUSES,
  type DemoDoc,
  LEAD_FIELDS,
  LEAD_FUNNELS,
  LEAD_STATUSES,
  LEAD_TEMPERATURES,
  type LeadDoc,
  type LeadSourceDoc,
  type LeadStatus,
  type ProposalDoc,
  responseDays,
  SOURCE_KINDS
} from "../sales/models.js";
import { runTableQuery, tableQuerySchema } from "../lib/table-query.js";
import { createProposalSchema, PROPOSAL_LABELS, proposalView, statusDates, updateProposalSchema } from "../sales/proposals.js";
import type { AdminStore } from "../store/admin-store.js";
import type { UserDoc } from "../store/models.js";

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
  /** Enlace a un Contacto y una Empresa que ya existen. */
  contactId: uuidOrNull,
  companyId: uuidOrNull
};
const createLeadSchema = z
  .object({ ...leadFields, sourceId: z.string().uuid() })
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

const convertSchema = z
  .object({
    teamId: z.string().uuid(),
    projectName: text(80).min(3),
    customerName: text(80).min(2).optional(),
    leadUserId: z.string().uuid().nullable().optional(),
    developerUserId: z.string().uuid().nullable().optional(),
    /** Propuesta del lead que se acepta al convertir (si aún no hay una aceptada). */
    proposalId: z.string().uuid().optional()
  })
  .strict();

const updateNoteSchema = z.object({ body: text(4000).min(1) }).strict();

const mappingSchema = z.array(z.object({ from: text(200).min(1), to: z.enum(LEAD_FIELDS) }).strict()).max(50);
const createSourceSchema = z.object({ name: text(80).min(2), kind: z.enum(SOURCE_KINDS), mapping: mappingSchema.optional() }).strict();
const updateSourceSchema = z
  .object({ name: text(80).min(2), kind: z.enum(SOURCE_KINDS), mapping: mappingSchema, active: z.boolean() })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "No hay nada que cambiar.");

/** Tabla de leads: vista activos / fríos / ganados y filtros; paginada en el servidor. */
const listQuery = tableQuerySchema.extend({
  view: z.enum(["active", "cold", "won"]).optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  sourceId: z.string().uuid().optional(),
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

/** La clave se muestra una sola vez: va serializada aquí (la redacción global la ocultaría) y sin caché. */
const sendKeyOnce = (reply: FastifyReply, body: Record<string, unknown>) => reply.header("Cache-Control", "no-store").type("application/json; charset=utf-8").send(JSON.stringify(body));

const sourceView = (source: LeadSourceDoc) => ({
  id: source._id,
  name: source.name,
  kind: source.kind,
  keyHint: source.keyHint,
  hasKey: Boolean(source.ingestKeyHash),
  mapping: source.mapping,
  active: source.active,
  received: source.received,
  lastReceivedAt: source.lastReceivedAt,
  sampleKeys: source.sampleKeys,
  ingestPath: `/api/ingest/leads/${source._id}`,
  createdAt: source.createdAt
});

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

const companyIdOf = (lead: LeadDoc) => lead.companyId ?? lead.customerId ?? null;

/** Responsable del lead (Closer) de la v1. */
const closerOf = (lead: LeadDoc) => lead.closerUserId ?? lead.ownerUserId ?? null;

/** Comercial: leads de varios sources, demos, propuestas, conversión en cliente, novedades y reuniones. */
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

  /** Contacto y Empresa enlazados a mano deben existir. */
  async function checkCoreLinks(input: { contactId?: string | null; companyId?: string | null }, reply: FastifyReply) {
    if (input.contactId && !(await store.contacts.findOne({ _id: input.contactId }, { projection: { _id: 1 } }))) {
      void reply.code(400).send({ error: "El contacto no existe." });
      return false;
    }
    if (input.companyId && !(await store.companies.findOne({ _id: input.companyId }, { projection: { _id: 1 } }))) {
      void reply.code(400).send({ error: "La empresa no existe." });
      return false;
    }
    return true;
  }

  async function teamMember(id: string | null | undefined, teamId: string, role: UserDoc["role"]) {
    if (!id) return true;
    return Boolean(await store.users.findOne({ _id: id, active: true, teamId, role }));
  }

  async function leadViews(leads: LeadDoc[]) {
    const ids = (pick: (l: LeadDoc) => (string | null | undefined)[]) => [...new Set(leads.flatMap(pick).filter((v): v is string => Boolean(v)))];
    const userIds = ids((l) => [l.setterUserId, closerOf(l)]);
    const contactIds = ids((l) => [l.contactId]);
    const companyIds = ids((l) => [companyIdOf(l)]);
    const dealIds = ids((l) => [l.dealId]);
    const [owners, contacts, companies, deals] = await Promise.all([
      userIds.length ? store.users.find({ _id: { $in: userIds } }, { projection: { name: 1 } }).toArray() : [],
      contactIds.length ? store.contacts.find({ _id: { $in: contactIds } }, { projection: { name: 1 } }).toArray() : [],
      companyIds.length ? store.companies.find({ _id: { $in: companyIds } }, { projection: { name: 1 } }).toArray() : [],
      dealIds.length ? store.deals.find({ _id: { $in: dealIds } }, { projection: { dealCode: 1, title: 1 } }).toArray() : []
    ]);
    const names = new Map(owners.map((u) => [u._id, u.name]));
    const contactName = new Map(contacts.map((c) => [c._id, c.name]));
    const companyName = new Map(companies.map((c) => [c._id, c.name]));
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
      source: { id: lead.sourceId, name: lead.sourceName },
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
      customerId: lead.customerId,
      companyId: lead.companyId ?? lead.customerId,
      contactId: lead.contactId ?? null,
      dealId: lead.dealId ?? null,
      /** Enlaces al Contacto y la Empresa del núcleo (los textos `company`/`contactName` vienen del source). */
      contactRef: lead.contactId ? { id: lead.contactId, name: contactName.get(lead.contactId) ?? null } : null,
      companyRef: companyIdOf(lead) ? { id: companyIdOf(lead)!, name: companyName.get(companyIdOf(lead)!) ?? null } : null,
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
    const { view, status, sourceId, funnel, temperature, setterUserId, closerUserId } = query.data;
    // Sin el estado: así el embudo muestra cuántos hay en cada etapa con los demás filtros.
    const base = {
      ...(view ? { status: { $in: [...VIEW_STATUSES[view]] } } : {}),
      ...(sourceId ? { sourceId } : {}),
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
    const source = body.data.sourceId ? await store.leadSources.findOne({ _id: body.data.sourceId }) : null;
    if (body.data.sourceId && !source) return reply.code(400).send({ error: "El source no existe." });
    if (!(await validOwner(body.data.setterUserId)) || !(await validOwner(body.data.closerUserId))) return reply.code(400).send({ error: "El Setter y el Closer deben ser personas activas de Comercial." });
    if (!(await checkCoreLinks(body.data, reply))) return reply;
    const at = new Date();
    const lead: LeadDoc = {
      _id: randomUUID(),
      sourceId: source?._id ?? null,
      sourceName: source?.name ?? "Manual",
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
      companyId: body.data.companyId ?? null,
      lostReason: null,
      customerId: null,
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
    const companyId = lead.companyId ?? lead.customerId;
    const [demos, proposals, company, project, deal] = await Promise.all([
      store.demos.find({ leadId: lead._id }).sort({ scheduledAt: -1 }).toArray(),
      store.proposals.find({ leadId: lead._id }).sort({ createdAt: -1 }).toArray(),
      companyId ? store.companies.findOne({ _id: companyId }, { projection: { name: 1 } }) : null,
      lead.projectId ? store.opsProjects.findOne({ _id: lead.projectId }, { projection: { name: 1, stage: 1, health: 1 } }) : null,
      lead.dealId ? store.deals.findOne({ _id: lead.dealId }, { projection: { dealCode: 1, title: 1 } }) : null
    ]);
    const view = await leadViews([lead]);
    return {
      lead: view(lead, true),
      demos: demos.map(demoView),
      proposals: proposals.map(proposalView),
      company: company ? { id: company._id, name: company.name } : null,
      project: project ? { id: project._id, name: project.name, stage: project.stage, health: project.health } : null,
      deal: deal ? { id: deal._id, dealCode: deal.dealCode, title: deal.title } : null,
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
    if (patch.status === "won" && lead.status !== "won") return reply.code(409).send({ error: "Un lead se gana al convertirlo en cliente." });
    if (patch.status && patch.status !== "won" && lead.status === "won") return reply.code(409).send({ error: "El lead ya es cliente: su estado no cambia." });
    if (!(await validOwner(patch.setterUserId)) || !(await validOwner(patch.closerUserId))) return reply.code(400).send({ error: "El Setter y el Closer deben ser personas activas de Comercial." });
    if (!(await checkCoreLinks(patch, reply))) return reply;

    const changes: string[] = [];
    if (patch.status && patch.status !== lead.status) changes.push(`Estado: ${STATUS_LABELS[lead.status]} → ${STATUS_LABELS[patch.status]}`);
    if (patch.status === "lost" && patch.lostReason) changes.push(`Motivo: ${patch.lostReason}`);
    if (patch.setterUserId !== undefined && patch.setterUserId !== (lead.setterUserId ?? null)) changes.push("Cambió el Setter.");
    if (patch.closerUserId !== undefined && patch.closerUserId !== closerOf(lead)) changes.push("Cambió el Closer.");
    if (patch.temperature !== undefined && patch.temperature !== (lead.temperature ?? null)) changes.push(`Temperatura: ${patch.temperature ?? "sin definir"}`);
    await touch(lead._id, { ...patch, ...(patch.status && patch.status !== "lost" ? { lostReason: null } : {}) });
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

  // ---- conversión en cliente -----------------------------------------------------

  /**
   * Lead ganado → cliente + proyecto operativo en Kick Off con la propuesta aceptada. Exige una
   * propuesta aceptada (o la que se indique, que se acepta aquí). Los responsables se validan como
   * en Operativa: deben ser del equipo elegido.
   */
  app.post("/api/sales/leads/:id/convert", { preHandler: requireSales }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = convertSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const lead = await readableLead(reply, params.data.id);
    if (!lead) return reply;
    const user = request.user!;
    if (lead.projectId || lead.status === "won") return reply.code(409).send({ error: "Este lead ya se convirtió en cliente." });
    const input = body.data;
    if (!(await store.teams.findOne({ _id: input.teamId }))) return reply.code(400).send({ error: "El equipo no existe." });
    if (!(await teamMember(input.leadUserId, input.teamId, "lead"))) return reply.code(400).send({ error: "El Team Leader debe ser un team leader activo de ese equipo." });
    if (!(await teamMember(input.developerUserId, input.teamId, "developer"))) return reply.code(400).send({ error: "El Developer debe ser un developer activo de ese equipo." });

    const proposals = await store.proposals.find({ leadId: lead._id }).sort({ createdAt: -1 }).toArray();
    const chosen = input.proposalId ? proposals.find((p) => p._id === input.proposalId) : proposals.find((p) => p.status === "accepted");
    if (input.proposalId && !chosen) return reply.code(400).send({ error: "La propuesta no es de este lead." });
    if (!chosen) return reply.code(409).send({ error: "Para convertir el lead necesitas una propuesta aceptada." });
    if (chosen.status === "rejected") return reply.code(409).send({ error: "Esa propuesta fue rechazada." });

    // Se marca el lead primero (de forma atómica) para que dos conversiones simultáneas no creen dos proyectos.
    const at = new Date();
    const projectId = randomUUID();
    const dealId = randomUUID();
    const customerName = input.customerName ?? (lead.company || lead.contactName || leadTitle(lead));
    // Empresa y contacto del núcleo: se reutilizan si el lead ya los tiene (§4.1).
    const companyId = lead.companyId ?? randomUUID();
    const contactId = lead.contactId ?? (lead.contactName || lead.email ? randomUUID() : null);
    const claimed = await store.leads.updateOne(
      { _id: lead._id, projectId: null, status: { $ne: "won" } },
      { $set: { status: "won", projectId, customerId: companyId, companyId, contactId, dealId, proposalUrl: chosen.url, lostReason: null, updatedAt: at } }
    );
    if (!claimed.modifiedCount) return reply.code(409).send({ error: "Este lead ya se convirtió en cliente." });

    if (!lead.companyId) {
      await store.companies.insertOne({
        _id: companyId,
        name: customerName,
        domain: lead.email?.split("@")[1] ?? null,
        industry: null,
        size: null,
        location: null,
        createdBy: user.username,
        createdAt: at,
        updatedAt: at
      });
    }
    if (contactId && !lead.contactId) {
      await store.contacts.insertOne({
        _id: contactId,
        name: lead.contactName || lead.email || customerName,
        emails: lead.email ? [lead.email] : [],
        phone: lead.phone,
        title: null,
        linkedinUrl: null,
        companyId,
        createdBy: user.username,
        createdAt: at,
        updatedAt: at
      });
    }
    const contactIds = contactId ? [contactId] : [];
    const project: OpsProjectDoc = {
      _id: projectId,
      name: input.projectName,
      customerName,
      companyId,
      contactIds,
      leadId: lead._id,
      teamId: input.teamId,
      leadUserId: input.leadUserId ?? null,
      developerUserId: input.developerUserId ?? null,
      clientSlug: null,
      proposalUrl: chosen.url,
      stage: "kickoff",
      health: "neutral",
      priority: "medium",
      createdBy: user.username,
      createdAt: at,
      updatedAt: at
    };
    await store.opsProjects.insertOne(project);
    // Regla 5.3: el deal de la propuesta aceptada queda «Aprobado» y ligado al proyecto. Horas y tarifa
    // se cargan en Operativa (la propuesta solo trae el monto).
    const deal: DealDoc = {
      _id: dealId,
      dealCode: dealCodeOf(await store.nextSequence("deal")),
      projectId,
      teamId: input.teamId,
      leadId: lead._id,
      partnerId: null,
      contactIds,
      ownerUserId: closerOf(lead) ?? lead.setterUserId ?? null,
      title: chosen.title,
      description: "",
      salesStage: "won",
      status: "approved",
      hours: 0,
      rateCents: 0,
      amountCents: 0,
      probability: 100,
      projectedCents: 0,
      currency: chosen.currency,
      expectedCloseDate: null,
      actualCloseDate: at.toISOString().slice(0, 10),
      saleType: "new_project",
      product: null,
      channel: lead.sourceName,
      lostReason: null,
      partnerCommissionPct: null,
      proposalUrl: chosen.url,
      sowUrl: null,
      changeOrders: [],
      createdBy: user.username,
      createdAt: at,
      updatedAt: at
    };
    await store.deals.insertOne(deal);
    // Las propuestas del lead pasan a verse también en el proyecto, ligadas al deal.
    await store.proposals.updateMany({ leadId: lead._id }, { $set: { projectId } });
    await store.proposals.updateOne({ _id: chosen._id }, { $set: { status: "accepted", dealId, decidedAt: chosen.decidedAt ?? at, updatedAt: at } });

    await note(user, lead._id, `Convertido en cliente: ${customerName}. Proyecto «${project.name}» creado en Kick Off con el deal ${deal.dealCode} aprobado.`);
    await store.projectUpdates.insertOne({
      _id: randomUUID(),
      projectId,
      kind: "system",
      body: `Proyecto creado desde Comercial (lead «${leadTitle(lead)}») con la propuesta «${chosen.title}» y el deal ${deal.dealCode}.`,
      authorUsername: user.username,
      authorName: user.name,
      createdAt: at
    });
    await auditSales(user, lead, "sales.lead_converted", { project: project.name });
    await store.audit({ actor: user.username, action: "ops.project_created", clientId: `ops:${projectId}`, target: project.name, details: { fromLead: true } });
    return reply.code(201).send({ company: { id: companyId, name: customerName }, project: { id: projectId, name: project.name }, deal: { id: dealId, dealCode: deal.dealCode } });
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
    collection: store.leadMeetings,
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

  // ---- sources -----------------------------------------------------------------

  app.get("/api/sales/sources", { preHandler: requireSales }, async () => {
    const sources = await store.leadSources.find().sort({ name: 1 }).toArray();
    return { sources: sources.map(sourceView) };
  });

  app.post("/api/sales/sources", { preHandler: requireSales }, async (request, reply) => {
    const body = createSourceSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const user = request.user!;
    const at = new Date();
    // Los manuales e importaciones no reciben por el endpoint: no llevan clave.
    const key = body.data.kind === "webhook" || body.data.kind === "form" ? newIngestKey() : null;
    registerSecret(key);
    const source: LeadSourceDoc = {
      _id: randomUUID(),
      name: body.data.name,
      kind: body.data.kind,
      ingestKeyHash: key ? hashIngestKey(key) : null,
      keyHint: key ? key.slice(-4) : null,
      mapping: body.data.mapping ?? [],
      active: true,
      received: 0,
      lastReceivedAt: null,
      sampleKeys: [],
      createdBy: user.username,
      createdAt: at,
      updatedAt: at
    };
    try {
      await store.leadSources.insertOne(source);
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) return reply.code(409).send({ error: "Ya existe un source con ese nombre." });
      throw error;
    }
    await store.audit({ actor: user.username, action: "sales.source_created", clientId: "sales:sources", target: source.name });
    return sendKeyOnce(reply.code(201), { source: sourceView(source), ingestKey: key });
  });

  app.patch("/api/sales/sources/:id", { preHandler: requireSales }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = updateSourceSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const source = await store.leadSources.findOne({ _id: params.data.id });
    if (!source) return reply.code(404).send({ error: "Source no encontrado." });
    try {
      await store.leadSources.updateOne({ _id: source._id }, { $set: { ...body.data, updatedAt: new Date() } });
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) return reply.code(409).send({ error: "Ya existe un source con ese nombre." });
      throw error;
    }
    await store.audit({ actor: request.user!.username, action: "sales.source_updated", clientId: "sales:sources", target: source.name });
    return { source: sourceView((await store.leadSources.findOne({ _id: source._id }))!) };
  });

  /** Nueva clave de ingesta: la anterior deja de funcionar en el acto. */
  app.post("/api/sales/sources/:id/rotate-key", { preHandler: requireSales }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const source = await store.leadSources.findOne({ _id: params.data.id });
    if (!source) return reply.code(404).send({ error: "Source no encontrado." });
    const key = newIngestKey();
    registerSecret(key);
    await store.leadSources.updateOne({ _id: source._id }, { $set: { ingestKeyHash: hashIngestKey(key), keyHint: key.slice(-4), updatedAt: new Date() } });
    await store.audit({ actor: request.user!.username, action: "sales.source_key_rotated", clientId: "sales:sources", target: source.name });
    return sendKeyOnce(reply, { source: sourceView((await store.leadSources.findOne({ _id: source._id }))!), ingestKey: key });
  });

}
