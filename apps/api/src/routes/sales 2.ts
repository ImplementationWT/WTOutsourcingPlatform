import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { MongoServerError } from "mongodb";
import { z } from "zod";
import { requireRole } from "../auth/session.js";
import type { SessionUser } from "../auth/users.js";
import { registerSecret } from "../lib/redact.js";
import type { MeetingProcessing } from "../meetings/processing.js";
import { registerMeetingRoutes } from "../meetings/routes.js";
import type { OpsProjectDoc } from "../ops/models.js";
import { hashIngestKey, leadTitle, newIngestKey } from "../sales/ingest.js";
import {
  advanceTo,
  DEMO_STATUSES,
  type DemoDoc,
  LEAD_FIELDS,
  LEAD_STATUSES,
  type LeadDoc,
  type LeadSourceDoc,
  type LeadStatus,
  type ProposalDoc,
  SOURCE_KINDS
} from "../sales/models.js";
import { createProposalSchema, PROPOSAL_LABELS, proposalView, statusDates, updateProposalSchema } from "../sales/proposals.js";
import type { AdminStore } from "../store/admin-store.js";
import type { UserDoc } from "../store/models.js";

/** Comercial es del CEO/CCO y del área Comercial (Marketing). */
export const SALES_ROLES = ["boss", "commercial"] as const;
const requireSales = requireRole(...SALES_ROLES);
const isSales = (user: SessionUser) => (SALES_ROLES as readonly string[]).includes(user.role);

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

const STATUS_LABELS: Record<LeadStatus, string> = { new: "Nuevo", contacted: "Contactado", demo: "Demo", proposal_sent: "Propuesta enviada", won: "Ganado", lost: "Perdido" };

const leadFields = {
  company: text(120),
  contactName: text(120),
  email,
  phone: text(40).nullable(),
  notes: text(4000),
  ownerUserId: z.string().uuid().nullable()
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

const listQuery = z.object({
  status: z.enum(LEAD_STATUSES).optional(),
  sourceId: z.string().uuid().optional(),
  ownerUserId: z.string().uuid().optional(),
  q: text(100).optional()
});

const invalid = (reply: FastifyReply, error: z.ZodError) =>
  reply.code(400).send({ error: "Datos inválidos.", issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

const demoView = (demo: DemoDoc) => ({ id: demo._id, leadId: demo.leadId, title: demo.title, scheduledAt: demo.scheduledAt, url: demo.url, notes: demo.notes, status: demo.status, updatedAt: demo.updatedAt });

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

  async function teamMember(id: string | null | undefined, teamId: string, role: UserDoc["role"]) {
    if (!id) return true;
    return Boolean(await store.users.findOne({ _id: id, active: true, teamId, role }));
  }

  async function leadViews(leads: LeadDoc[]) {
    const ownerIds = [...new Set(leads.map((l) => l.ownerUserId).filter((v): v is string => Boolean(v)))];
    const owners = ownerIds.length ? await store.users.find({ _id: { $in: ownerIds } }, { projection: { name: 1 } }).toArray() : [];
    const names = new Map(owners.map((u) => [u._id, u.name]));
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
      owner: lead.ownerUserId ? { id: lead.ownerUserId, name: names.get(lead.ownerUserId) ?? null } : null,
      lostReason: lead.lostReason,
      customerId: lead.customerId,
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

  app.get("/api/sales/leads", { preHandler: requireSales }, async (request, reply) => {
    const query = listQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, query.error);
    const { status, sourceId, ownerUserId, q } = query.data;
    const search = q ? new RegExp(escapeRegex(q), "i") : null;
    const base = {
      ...(sourceId ? { sourceId } : {}),
      ...(ownerUserId ? { ownerUserId } : {}),
      ...(search ? { $or: [{ company: search }, { contactName: search }, { email: search }, { phone: search }] } : {})
    };
    const [leads, counts] = await Promise.all([
      store.leads.find({ ...base, ...(status ? { status } : {}) }, { projection: { fields: 0, rawJson: 0 } }).sort({ updatedAt: -1 }).limit(500).toArray(),
      store.leads.aggregate<{ _id: LeadStatus; count: number }>([{ $match: base }, { $group: { _id: "$status", count: { $sum: 1 } } }]).toArray()
    ]);
    const view = await leadViews(leads);
    return {
      leads: leads.map((l) => view(l)),
      counts: Object.fromEntries(LEAD_STATUSES.map((s) => [s, counts.find((c) => c._id === s)?.count ?? 0]))
    };
  });

  app.post("/api/sales/leads", { preHandler: requireSales }, async (request, reply) => {
    const body = createLeadSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const user = request.user!;
    const source = body.data.sourceId ? await store.leadSources.findOne({ _id: body.data.sourceId }) : null;
    if (body.data.sourceId && !source) return reply.code(400).send({ error: "El source no existe." });
    if (!(await validOwner(body.data.ownerUserId))) return reply.code(400).send({ error: "El responsable debe ser alguien activo de Comercial." });
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
      ownerUserId: body.data.ownerUserId ?? (user.role === "commercial" ? user.id : null),
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

  app.get("/api/sales/leads/:id", { preHandler: requireSales }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const lead = await readableLead(reply, params.data.id);
    if (!lead) return reply;
    const [demos, proposals, customer, project] = await Promise.all([
      store.demos.find({ leadId: lead._id }).sort({ scheduledAt: -1 }).toArray(),
      store.proposals.find({ leadId: lead._id }).sort({ createdAt: -1 }).toArray(),
      lead.customerId ? store.customers.findOne({ _id: lead.customerId }) : null,
      lead.projectId ? store.opsProjects.findOne({ _id: lead.projectId }, { projection: { name: 1, stage: 1, health: 1 } }) : null
    ]);
    const view = await leadViews([lead]);
    return {
      lead: view(lead, true),
      demos: demos.map(demoView),
      proposals: proposals.map(proposalView),
      customer: customer ? { id: customer._id, name: customer.name } : null,
      project: project ? { id: project._id, name: project.name, stage: project.stage, health: project.health } : null
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
    if (patch.ownerUserId !== undefined && !(await validOwner(patch.ownerUserId))) return reply.code(400).send({ error: "El responsable debe ser alguien activo de Comercial." });

    const changes: string[] = [];
    if (patch.status && patch.status !== lead.status) changes.push(`Estado: ${STATUS_LABELS[lead.status]} → ${STATUS_LABELS[patch.status]}`);
    if (patch.status === "lost" && patch.lostReason) changes.push(`Motivo: ${patch.lostReason}`);
    if (patch.ownerUserId !== undefined && patch.ownerUserId !== lead.ownerUserId) changes.push("Cambió el responsable.");
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
    const customerId = randomUUID();
    const claimed = await store.leads.updateOne({ _id: lead._id, projectId: null, status: { $ne: "won" } }, { $set: { status: "won", projectId, customerId, lostReason: null, updatedAt: at } });
    if (!claimed.modifiedCount) return reply.code(409).send({ error: "Este lead ya se convirtió en cliente." });

    const customerName = input.customerName ?? (lead.company || lead.contactName || leadTitle(lead));
    await store.customers.insertOne({
      _id: customerId,
      name: customerName,
      contactName: lead.contactName,
      email: lead.email,
      phone: lead.phone,
      leadId: lead._id,
      createdBy: user.username,
      createdAt: at,
      updatedAt: at
    });
    const project: OpsProjectDoc = {
      _id: projectId,
      name: input.projectName,
      customerName,
      customerId,
      leadId: lead._id,
      teamId: input.teamId,
      leadUserId: input.leadUserId ?? null,
      developerUserId: input.developerUserId ?? null,
      clientSlug: null,
      proposalUrl: chosen.url,
      stage: "kickoff",
      health: "neutral",
      sentimentScore: 50,
      priority: "medium",
      createdBy: user.username,
      createdAt: at,
      updatedAt: at
    };
    await store.opsProjects.insertOne(project);
    // Las propuestas del lead pasan a verse también en el proyecto.
    await store.proposals.updateMany({ leadId: lead._id }, { $set: { projectId } });
    if (chosen.status !== "accepted") await store.proposals.updateOne({ _id: chosen._id }, { $set: { status: "accepted", decidedAt: at, updatedAt: at } });

    await note(user, lead._id, `Convertido en cliente: ${customerName}. Proyecto «${project.name}» creado en Kick Off.`);
    await store.projectUpdates.insertOne({
      _id: randomUUID(),
      projectId,
      kind: "system",
      body: `Proyecto creado desde Comercial (lead «${leadTitle(lead)}») con la propuesta «${chosen.title}».`,
      authorUsername: user.username,
      authorName: user.name,
      createdAt: at
    });
    await auditSales(user, lead, "sales.lead_converted", { project: project.name });
    await store.audit({ actor: user.username, action: "ops.project_created", clientId: `ops:${projectId}`, target: project.name, details: { fromLead: true } });
    return reply.code(201).send({ customer: { id: customerId, name: customerName }, project: { id: projectId, name: project.name } });
  });

  // ---- novedades ---------------------------------------------------------------

  app.get("/api/sales/leads/:id/updates", { preHandler: requireSales }, async (request, reply) => {
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
    collection: store.leadMeetings,
    ownerKey: "leadId",
    processing: meetings,
    resolve: async (request, reply, id) => {
      if (!isSales(request.user!)) {
        void reply.code(403).send({ error: "No tienes permiso para esta acción." });
        return null;
      }
      const lead = await readableLead(reply, id);
      if (!lead) return null;
      return {
        id: lead._id,
        canWork: true,
        context: `Reunión comercial con un prospecto. Empresa: ${lead.company || "sin indicar"}. Contacto: ${lead.contactName || "sin indicar"}. Etapa: ${STATUS_LABELS[lead.status]}.`,
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

  // ---- clientes ----------------------------------------------------------------

  app.get("/api/sales/customers", { preHandler: requireSales }, async () => {
    const customers = await store.customers.find().sort({ createdAt: -1 }).limit(500).toArray();
    const ids = customers.map((c) => c._id);
    const projects = ids.length ? await store.opsProjects.find({ customerId: { $in: ids } }, { projection: { name: 1, stage: 1, health: 1, customerId: 1 } }).toArray() : [];
    return {
      customers: customers.map((c) => ({
        id: c._id,
        name: c.name,
        contactName: c.contactName,
        email: c.email,
        phone: c.phone,
        leadId: c.leadId,
        createdAt: c.createdAt,
        projects: projects.filter((p) => p.customerId === c._id).map((p) => ({ id: p._id, name: p.name, stage: p.stage, health: p.health }))
      }))
    };
  });
}
