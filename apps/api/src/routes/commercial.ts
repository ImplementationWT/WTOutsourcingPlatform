import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { type Filter, MongoServerError } from "mongodb";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/session.js";
import type { SessionUser } from "../auth/users.js";
import { runTableQuery, tableQuerySchema } from "../lib/table-query.js";
import { canManageProject } from "../ops/access.js";
import { SOLD_DEAL_STATUSES } from "../ops/models.js";
import { leadTitle } from "../sales/ingest.js";
import {
  ACTIVITY_KINDS,
  ACTIVITY_STATUSES,
  type ActivityDoc,
  advanceTo,
  lineSubtotalCents,
  linesTotalCents,
  PARTNER_KINDS,
  type PartnerDoc,
  type ProductDoc,
  PROPOSAL_STATUSES,
  type ProposalDoc,
  type ProposalLineDoc,
  type UseCaseDoc
} from "../sales/models.js";
import { PROPOSAL_LABELS, proposalView, statusDates } from "../sales/proposals.js";
import type { AdminStore } from "../store/admin-store.js";
import { SALES_READ_ROLES, SALES_ROLES } from "./sales.js";

const idParams = z.object({ id: z.string().uuid() });
const text = (max: number) => z.string().trim().max(max);
const nullableText = (max: number) => text(max).nullable().transform((v) => (v ? v : null));
const url = z
  .string()
  .trim()
  .max(500)
  .refine((v) => /^https?:\/\//i.test(v), "Debe empezar por http:// o https://");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Usa el formato AAAA-MM-DD.").nullable();
const uuidOrNull = z.string().uuid().nullable();
const patchOf = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object(shape)
    .partial()
    .strict()
    .refine((p) => Object.keys(p).length > 0, "No hay nada que cambiar.");

// ---- esquemas -----------------------------------------------------------------

const partnerFields = {
  name: text(120).min(2),
  kind: z.enum(PARTNER_KINDS),
  commissionPct: z.number().min(0).max(100),
  contactId: uuidOrNull,
  notes: text(4000),
  active: z.boolean()
};
const createPartnerSchema = z.object(partnerFields).partial().required({ name: true }).strict();
const updatePartnerSchema = patchOf(partnerFields);

const activityFields = {
  title: text(160).min(3),
  kind: z.enum(ACTIVITY_KINDS),
  ownerUserId: uuidOrNull,
  dueDate: isoDate,
  status: z.enum(ACTIVITY_STATUSES),
  leadId: uuidOrNull,
  dealId: uuidOrNull,
  notes: text(4000)
};
const createActivitySchema = z
  .object(activityFields)
  .partial()
  .required({ title: true })
  .strict()
  .refine((v) => Boolean(v.leadId || v.dealId), "Liga la actividad a un lead o a un deal.");
const updateActivitySchema = patchOf(activityFields);

const productFields = { name: text(120).min(2), description: text(4000), defaultRateCents: z.number().int().min(0).max(100_000_000), active: z.boolean() };
const createProductSchema = z.object(productFields).partial().required({ name: true }).strict();
const updateProductSchema = patchOf(productFields);

const useCaseFields = { title: text(160).min(3), description: text(8000), industry: nullableText(80), productId: uuidOrNull };
const createUseCaseSchema = z.object(useCaseFields).partial().required({ title: true }).strict();
const updateUseCaseSchema = patchOf(useCaseFields);

const lineSchema = z
  .object({ productId: uuidOrNull.optional(), description: text(500), hours: z.number().min(0).max(100_000), rateCents: z.number().int().min(0).max(100_000_000) })
  .strict();
const proposalFields = {
  title: text(160).min(3),
  url,
  leadId: uuidOrNull,
  dealId: uuidOrNull,
  status: z.enum(PROPOSAL_STATUSES),
  currency: z.string().regex(/^[A-Z]{3}$/),
  /** Solo sin líneas: con líneas el monto es la suma de los subtotales. */
  amountCents: z.number().int().min(0).max(100_000_000_000).nullable(),
  lines: z.array(lineSchema).max(100),
  useCaseIds: z.array(z.string().uuid()).max(50)
};
const createProposalSchema = z
  .object(proposalFields)
  .partial()
  .required({ title: true, url: true })
  .strict()
  .refine((v) => Boolean(v.leadId || v.dealId), "Liga la cotización a un lead o a un deal.");
const updateProposalSchema = patchOf(proposalFields);

const partnersQuery = tableQuerySchema.extend({ kind: z.enum(PARTNER_KINDS).optional(), active: z.enum(["true", "false"]).optional() });
const activitiesQuery = tableQuerySchema.extend({
  status: z.enum(ACTIVITY_STATUSES).optional(),
  kind: z.enum(ACTIVITY_KINDS).optional(),
  ownerUserId: z.string().uuid().optional(),
  leadId: z.string().uuid().optional(),
  dealId: z.string().uuid().optional(),
  mine: z.enum(["1"]).optional()
});
const proposalsQuery = tableQuerySchema.extend({
  status: z.enum(PROPOSAL_STATUSES).optional(),
  leadId: z.string().uuid().optional(),
  dealId: z.string().uuid().optional(),
  area: z.enum(["commercial", "operations"]).optional()
});

const invalid = (reply: FastifyReply, error: z.ZodError) =>
  reply.code(400).send({ error: "Datos inválidos.", issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
const forbidden = (reply: FastifyReply) => reply.code(403).send({ error: "No tienes permiso para esta acción." });
const duplicate = (error: unknown) => error instanceof MongoServerError && error.code === 11000;

const isSales = (user: SessionUser) => (SALES_ROLES as readonly string[]).includes(user.role);
const requireSales = requireRole(...SALES_ROLES);
const requireSalesRead = requireRole(...SALES_READ_ROLES);
const today = () => new Date().toISOString().slice(0, 10);

const ACTIVITY_LABELS: Record<ActivityDoc["status"], string> = { pending: "Pendiente", done: "Hecha", cancelled: "Cancelada" };

/**
 * Comercial (Paso 3, docs/rework-plataforma.md §4.1): Partners, Actividades comerciales, catálogo
 * de Productos y Casos de uso, y Cotizaciones con líneas (desde Comercial o desde Operativa).
 */
export async function registerCommercialRoutes(app: FastifyInstance, { store }: { store: AdminStore }) {
  const audit = (user: SessionUser, action: string, clientId: string, target: string, details?: Record<string, string | number | boolean>) =>
    store.audit({ actor: user.username, action, clientId, target, ...(details ? { details } : {}) });

  const leadNote = (user: SessionUser, leadId: string, body: string) =>
    store.leadUpdates.insertOne({ _id: randomUUID(), leadId, kind: "system", body, authorUsername: user.username, authorName: user.name, createdAt: new Date() });
  const dealNote = (user: SessionUser, dealId: string, body: string) =>
    store.dealUpdates.insertOne({ _id: randomUUID(), dealId, kind: "system", body, authorUsername: user.username, authorName: user.name, createdAt: new Date() });

  async function userNames(ids: (string | null | undefined)[]) {
    const unique = [...new Set(ids.filter((v): v is string => Boolean(v)))];
    const rows = unique.length ? await store.users.find({ _id: { $in: unique } }, { projection: { name: 1 } }).toArray() : [];
    return new Map(rows.map((u) => [u._id, u.name]));
  }

  async function leadAndDealRefs(rows: { leadId: string | null; dealId: string | null }[]) {
    const leadIds = [...new Set(rows.map((r) => r.leadId).filter((v): v is string => Boolean(v)))];
    const dealIds = [...new Set(rows.map((r) => r.dealId).filter((v): v is string => Boolean(v)))];
    const [leads, deals] = await Promise.all([
      leadIds.length ? store.leads.find({ _id: { $in: leadIds } }, { projection: { company: 1, contactName: 1, email: 1 } }).toArray() : [],
      dealIds.length ? store.deals.find({ _id: { $in: dealIds } }, { projection: { dealCode: 1, title: 1 } }).toArray() : []
    ]);
    const lead = new Map(leads.map((l) => [l._id, { id: l._id, title: leadTitle(l) }]));
    const deal = new Map(deals.map((d) => [d._id, { id: d._id, dealCode: d.dealCode, title: d.title }]));
    return (row: { leadId: string | null; dealId: string | null }) => ({
      lead: row.leadId ? (lead.get(row.leadId) ?? null) : null,
      deal: row.dealId ? (deal.get(row.dealId) ?? null) : null
    });
  }

  /** El lead y el deal de un registro comercial deben existir. */
  async function checkLeadDeal(input: { leadId?: string | null; dealId?: string | null }, reply: FastifyReply) {
    const error =
      input.leadId && !(await store.leads.findOne({ _id: input.leadId }, { projection: { _id: 1 } }))
        ? "El lead no existe."
        : input.dealId && !(await store.deals.findOne({ _id: input.dealId }, { projection: { _id: 1 } }))
          ? "El deal no existe."
          : null;
    if (error) void reply.code(400).send({ error });
    return !error;
  }

  // ---- partners ------------------------------------------------------------------

  /** Deals que originó cada partner: valor vendido y comisión (comisión % × valor del deal, §5.2). */
  async function partnerTotals(ids: string[]) {
    if (!ids.length) return new Map<string, { deals: number; soldCents: number; commissionCents: number }>();
    const rows = await store.deals
      .aggregate<{ _id: string; deals: number; soldCents: number; commissionCents: number }>([
        { $match: { partnerId: { $in: ids }, status: { $ne: "cancelled" } } },
        {
          $group: {
            _id: "$partnerId",
            deals: { $sum: 1 },
            soldCents: { $sum: { $cond: [{ $in: ["$status", [...SOLD_DEAL_STATUSES]] }, "$amountCents", 0] } },
            commissionCents: {
              $sum: { $cond: [{ $in: ["$status", [...SOLD_DEAL_STATUSES]] }, { $round: [{ $divide: [{ $multiply: ["$amountCents", { $ifNull: ["$partnerCommissionPct", 0] }] }, 100] }, 0] }, 0] }
            }
          }
        }
      ])
      .toArray();
    return new Map(rows.map((r) => [r._id, r]));
  }

  const partnerView = (p: PartnerDoc, totals?: { deals: number; soldCents: number; commissionCents: number }) => ({
    id: p._id,
    name: p.name,
    kind: p.kind,
    commissionPct: p.commissionPct,
    contactId: p.contactId,
    notes: p.notes,
    active: p.active,
    deals: totals?.deals ?? 0,
    soldCents: totals?.soldCents ?? 0,
    commissionCents: totals?.commissionCents ?? 0,
    updatedAt: p.updatedAt
  });

  app.get("/api/partners", { preHandler: requireSalesRead }, async (request, reply) => {
    const query = partnersQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, query.error);
    const result = await runTableQuery(store.partners, {
      match: { ...(query.data.kind ? { kind: query.data.kind } : {}), ...(query.data.active ? { active: query.data.active === "true" } : {}) },
      query: query.data,
      sortable: { name: "name", kind: "kind", commissionPct: "commissionPct", updatedAt: "updatedAt" },
      defaultSort: { key: "name", dir: "asc" },
      search: ["name", "notes"]
    });
    const totals = await partnerTotals(result.rows.map((p) => p._id));
    return { ...result, rows: result.rows.map((p) => partnerView(p, totals.get(p._id))), canWrite: isSales(request.user!) };
  });

  app.post("/api/partners", { preHandler: requireSales }, async (request, reply) => {
    const body = createPartnerSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    if (body.data.contactId && !(await store.contacts.findOne({ _id: body.data.contactId }))) return reply.code(400).send({ error: "El contacto no existe." });
    const user = request.user!;
    const at = new Date();
    const partner: PartnerDoc = {
      _id: randomUUID(),
      name: body.data.name,
      kind: body.data.kind ?? "referral",
      commissionPct: body.data.commissionPct ?? 0,
      contactId: body.data.contactId ?? null,
      notes: body.data.notes ?? "",
      active: body.data.active ?? true,
      createdBy: user.username,
      createdAt: at,
      updatedAt: at
    };
    try {
      await store.partners.insertOne(partner);
    } catch (error) {
      if (duplicate(error)) return reply.code(409).send({ error: "Ya existe un partner con ese nombre." });
      throw error;
    }
    await audit(user, "sales.partner_created", `sales:partner:${partner._id}`, partner.name);
    return reply.code(201).send({ partner: partnerView(partner) });
  });

  app.get("/api/partners/:id", { preHandler: requireSalesRead }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const partner = await store.partners.findOne({ _id: params.data.id });
    if (!partner) return reply.code(404).send({ error: "Partner no encontrado." });
    const [totals, deals, contact] = await Promise.all([
      partnerTotals([partner._id]),
      store.deals.find({ partnerId: partner._id }).sort({ createdAt: -1 }).limit(500).toArray(),
      partner.contactId ? store.contacts.findOne({ _id: partner.contactId }, { projection: { name: 1 } }) : null
    ]);
    return {
      partner: partnerView(partner, totals.get(partner._id)),
      contact: contact ? { id: contact._id, name: contact.name } : null,
      deals: deals.map((d) => ({
        id: d._id,
        dealCode: d.dealCode,
        title: d.title,
        status: d.status,
        amountCents: d.amountCents,
        currency: d.currency,
        partnerCommissionPct: d.partnerCommissionPct,
        commissionCents: Math.round((d.amountCents * (d.partnerCommissionPct ?? 0)) / 100)
      })),
      canWrite: isSales(request.user!)
    };
  });

  app.patch("/api/partners/:id", { preHandler: requireSales }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = updatePartnerSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    if (body.data.contactId && !(await store.contacts.findOne({ _id: body.data.contactId }))) return reply.code(400).send({ error: "El contacto no existe." });
    let partner: PartnerDoc | null;
    try {
      partner = await store.partners.findOneAndUpdate({ _id: params.data.id }, { $set: { ...body.data, updatedAt: new Date() } }, { returnDocument: "after" });
    } catch (error) {
      if (duplicate(error)) return reply.code(409).send({ error: "Ya existe un partner con ese nombre." });
      throw error;
    }
    if (!partner) return reply.code(404).send({ error: "Partner no encontrado." });
    await audit(request.user!, "sales.partner_updated", `sales:partner:${partner._id}`, partner.name);
    const totals = await partnerTotals([partner._id]);
    return { partner: partnerView(partner, totals.get(partner._id)) };
  });

  // ---- actividades comerciales -----------------------------------------------------

  async function activityViews(rows: ActivityDoc[]) {
    const [names, refs] = await Promise.all([userNames(rows.map((a) => a.ownerUserId)), leadAndDealRefs(rows)]);
    const now = today();
    return (a: ActivityDoc) => ({
      id: a._id,
      title: a.title,
      kind: a.kind,
      owner: a.ownerUserId ? { id: a.ownerUserId, name: names.get(a.ownerUserId) ?? null } : null,
      dueDate: a.dueDate,
      /** (calc) pendiente y con la fecha pasada. */
      overdue: a.status === "pending" && Boolean(a.dueDate && a.dueDate < now),
      status: a.status,
      notes: a.notes,
      ...refs(a),
      completedAt: a.completedAt ?? null,
      updatedAt: a.updatedAt
    });
  }

  async function validOwner(id: string | null | undefined) {
    if (!id) return true;
    return Boolean(await store.users.findOne({ _id: id, active: true, role: { $in: [...SALES_ROLES] } }, { projection: { _id: 1 } }));
  }

  app.get("/api/activities", { preHandler: requireSalesRead }, async (request, reply) => {
    const query = activitiesQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, query.error);
    const { status, kind, ownerUserId, leadId, dealId, mine } = query.data;
    const user = request.user!;
    const result = await runTableQuery(store.activities, {
      match: {
        ...(status ? { status } : {}),
        ...(kind ? { kind } : {}),
        ...(mine ? { ownerUserId: user.id } : ownerUserId ? { ownerUserId } : {}),
        ...(leadId ? { leadId } : {}),
        ...(dealId ? { dealId } : {})
      },
      query: query.data,
      sortable: { title: "title", kind: "kind", dueDate: "dueDate", status: { field: "status", order: ACTIVITY_STATUSES }, updatedAt: "updatedAt" },
      defaultSort: { key: "dueDate", dir: "asc" },
      search: ["title", "notes"],
      facetField: "status"
    });
    const view = await activityViews(result.rows);
    return { ...result, rows: result.rows.map(view), canWrite: isSales(user) };
  });

  app.post("/api/activities", { preHandler: requireSales }, async (request, reply) => {
    const body = createActivitySchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    if (!(await checkLeadDeal(body.data, reply))) return reply;
    if (!(await validOwner(body.data.ownerUserId))) return reply.code(400).send({ error: "El responsable debe ser alguien activo de Comercial." });
    const user = request.user!;
    const at = new Date();
    const status = body.data.status ?? "pending";
    const activity: ActivityDoc = {
      _id: randomUUID(),
      title: body.data.title,
      kind: body.data.kind ?? "follow_up",
      ownerUserId: body.data.ownerUserId !== undefined ? body.data.ownerUserId : user.id,
      dueDate: body.data.dueDate ?? null,
      status,
      leadId: body.data.leadId ?? null,
      dealId: body.data.dealId ?? null,
      notes: body.data.notes ?? "",
      createdBy: user.username,
      createdAt: at,
      updatedAt: at,
      ...(status === "done" ? { completedAt: at } : {})
    };
    await store.activities.insertOne(activity);
    await audit(user, "sales.activity_created", `sales:activity:${activity._id}`, activity.title);
    const view = await activityViews([activity]);
    return reply.code(201).send({ activity: view(activity) });
  });

  app.patch("/api/activities/:id", { preHandler: requireSales }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = updateActivitySchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const activity = await store.activities.findOne({ _id: params.data.id });
    if (!activity) return reply.code(404).send({ error: "Actividad no encontrada." });
    const patch = body.data;
    if (!(await checkLeadDeal(patch, reply))) return reply;
    if (!(await validOwner(patch.ownerUserId))) return reply.code(400).send({ error: "El responsable debe ser alguien activo de Comercial." });
    const leadId = patch.leadId !== undefined ? patch.leadId : activity.leadId;
    const dealId = patch.dealId !== undefined ? patch.dealId : activity.dealId;
    if (!leadId && !dealId) return reply.code(400).send({ error: "Liga la actividad a un lead o a un deal." });
    const at = new Date();
    const set: Partial<ActivityDoc> = { ...patch, updatedAt: at };
    const unset: Record<string, ""> = {};
    if (patch.status === "done" && activity.status !== "done") set.completedAt = at;
    if (patch.status && patch.status !== "done" && activity.status === "done") unset.completedAt = "";
    await store.activities.updateOne({ _id: activity._id }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
    const user = request.user!;
    if (patch.status && patch.status !== activity.status) {
      const body_ = `Actividad «${activity.title}»: ${ACTIVITY_LABELS[activity.status]} → ${ACTIVITY_LABELS[patch.status]}`;
      if (leadId) await leadNote(user, leadId, body_);
      if (dealId) await dealNote(user, dealId, body_);
    }
    const fresh = (await store.activities.findOne({ _id: activity._id }))!;
    const view = await activityViews([fresh]);
    return { activity: view(fresh) };
  });

  // ---- productos y casos de uso ------------------------------------------------------

  const productView = (p: ProductDoc) => ({ id: p._id, name: p.name, description: p.description, defaultRateCents: p.defaultRateCents, active: p.active, updatedAt: p.updatedAt });
  const useCaseView = (u: UseCaseDoc) => ({ id: u._id, title: u.title, description: u.description, industry: u.industry, productId: u.productId, updatedAt: u.updatedAt });

  app.get("/api/products", { preHandler: requireAuth }, async (request) => {
    const products = await store.products.find().sort({ name: 1 }).limit(500).toArray();
    return { products: products.map(productView), canWrite: isSales(request.user!) };
  });

  app.post("/api/products", { preHandler: requireSales }, async (request, reply) => {
    const body = createProductSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const user = request.user!;
    const at = new Date();
    const product: ProductDoc = {
      _id: randomUUID(),
      name: body.data.name,
      description: body.data.description ?? "",
      defaultRateCents: body.data.defaultRateCents ?? 0,
      active: body.data.active ?? true,
      createdBy: user.username,
      createdAt: at,
      updatedAt: at
    };
    try {
      await store.products.insertOne(product);
    } catch (error) {
      if (duplicate(error)) return reply.code(409).send({ error: "Ya existe un producto con ese nombre." });
      throw error;
    }
    await audit(user, "sales.product_created", "sales:products", product.name);
    return reply.code(201).send({ product: productView(product) });
  });

  app.patch("/api/products/:id", { preHandler: requireSales }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = updateProductSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    let product: ProductDoc | null;
    try {
      product = await store.products.findOneAndUpdate({ _id: params.data.id }, { $set: { ...body.data, updatedAt: new Date() } }, { returnDocument: "after" });
    } catch (error) {
      if (duplicate(error)) return reply.code(409).send({ error: "Ya existe un producto con ese nombre." });
      throw error;
    }
    if (!product) return reply.code(404).send({ error: "Producto no encontrado." });
    await audit(request.user!, "sales.product_updated", "sales:products", product.name);
    return { product: productView(product) };
  });

  app.get("/api/use-cases", { preHandler: requireAuth }, async (request) => {
    const useCases = await store.useCases.find().sort({ title: 1 }).limit(500).toArray();
    return { useCases: useCases.map(useCaseView), canWrite: isSales(request.user!) };
  });

  const checkProduct = async (productId: string | null | undefined, reply: FastifyReply) => {
    if (!productId || (await store.products.findOne({ _id: productId }, { projection: { _id: 1 } }))) return true;
    void reply.code(400).send({ error: "El producto no existe." });
    return false;
  };

  app.post("/api/use-cases", { preHandler: requireSales }, async (request, reply) => {
    const body = createUseCaseSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    if (!(await checkProduct(body.data.productId, reply))) return reply;
    const user = request.user!;
    const at = new Date();
    const useCase: UseCaseDoc = {
      _id: randomUUID(),
      title: body.data.title,
      description: body.data.description ?? "",
      industry: body.data.industry ?? null,
      productId: body.data.productId ?? null,
      createdBy: user.username,
      createdAt: at,
      updatedAt: at
    };
    await store.useCases.insertOne(useCase);
    await audit(user, "sales.use_case_created", "sales:use-cases", useCase.title);
    return reply.code(201).send({ useCase: useCaseView(useCase) });
  });

  app.patch("/api/use-cases/:id", { preHandler: requireSales }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = updateUseCaseSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    if (!(await checkProduct(body.data.productId, reply))) return reply;
    const useCase = await store.useCases.findOneAndUpdate({ _id: params.data.id }, { $set: { ...body.data, updatedAt: new Date() } }, { returnDocument: "after" });
    if (!useCase) return reply.code(404).send({ error: "Caso de uso no encontrado." });
    return { useCase: useCaseView(useCase) };
  });

  // ---- cotizaciones / propuestas ----------------------------------------------------

  /**
   * Quién edita una cotización: Comercial siempre; en Operativa, quien gestiona el proyecto de la
   * cotización (las de un proyecto nacen en su pestaña).
   */
  async function canWriteProposal(user: SessionUser, proposal: Pick<ProposalDoc, "projectId">) {
    if (isSales(user)) return true;
    if (!proposal.projectId) return false;
    const project = await store.opsProjects.findOne({ _id: proposal.projectId });
    return Boolean(project && canManageProject(user, project));
  }

  async function buildLines(lines: z.infer<typeof lineSchema>[], reply: FastifyReply) {
    const productIds = [...new Set(lines.map((l) => l.productId).filter((v): v is string => Boolean(v)))];
    const products = productIds.length ? await store.products.find({ _id: { $in: productIds } }, { projection: { name: 1 } }).toArray() : [];
    if (products.length !== productIds.length) {
      void reply.code(400).send({ error: "Algún producto no existe." });
      return null;
    }
    const name = new Map(products.map((p) => [p._id, p.name]));
    return lines.map<ProposalLineDoc>((l) => ({
      _id: randomUUID(),
      productId: l.productId ?? null,
      description: l.description || (l.productId ? (name.get(l.productId) ?? "") : ""),
      hours: l.hours,
      rateCents: l.rateCents,
      subtotalCents: lineSubtotalCents(l.hours, l.rateCents)
    }));
  }

  async function checkUseCases(ids: string[] | undefined, reply: FastifyReply) {
    if (!ids?.length || (await store.useCases.countDocuments({ _id: { $in: ids } })) === new Set(ids).size) return true;
    void reply.code(400).send({ error: "Algún caso de uso no existe." });
    return false;
  }

  async function proposalDetail(p: ProposalDoc) {
    const refs = await leadAndDealRefs([p]);
    const [project, products, useCases] = await Promise.all([
      p.projectId ? store.opsProjects.findOne({ _id: p.projectId }, { projection: { name: 1 } }) : null,
      store.products.find({ _id: { $in: (p.lines ?? []).map((l) => l.productId).filter((v): v is string => Boolean(v)) } }, { projection: { name: 1 } }).toArray(),
      p.useCaseIds?.length ? store.useCases.find({ _id: { $in: p.useCaseIds } }, { projection: { title: 1 } }).toArray() : []
    ]);
    const productName = new Map(products.map((x) => [x._id, x.name]));
    return {
      ...proposalView(p),
      ...refs(p),
      project: project ? { id: project._id, name: project.name } : null,
      lines: (p.lines ?? []).map((l) => ({ id: l._id, productId: l.productId, product: l.productId ? (productName.get(l.productId) ?? null) : null, description: l.description, hours: l.hours, rateCents: l.rateCents, subtotalCents: l.subtotalCents })),
      useCases: useCases.map((u) => ({ id: u._id, title: u.title }))
    };
  }

  /** Enviar la propuesta de un lead lo adelanta en el embudo; el resto queda en su bitácora. */
  async function proposalChanged(user: SessionUser, proposal: ProposalDoc, from: ProposalDoc["status"] | null, to: ProposalDoc["status"]) {
    if (proposal.leadId) {
      const lead = await store.leads.findOne({ _id: proposal.leadId });
      if (lead && to === "sent") await store.leads.updateOne({ _id: lead._id }, { $set: { status: advanceTo(lead.status, "proposal_sent"), updatedAt: new Date() } });
      if (lead) await leadNote(user, lead._id, from ? `Propuesta «${proposal.title}»: ${PROPOSAL_LABELS[from]} → ${PROPOSAL_LABELS[to]}` : `Nueva propuesta: «${proposal.title}» (${PROPOSAL_LABELS[to]}).`);
    }
    if (proposal.dealId) await dealNote(user, proposal.dealId, from ? `Propuesta «${proposal.title}»: ${PROPOSAL_LABELS[from]} → ${PROPOSAL_LABELS[to]}` : `Nueva propuesta: «${proposal.title}».`);
  }

  app.get("/api/proposals", { preHandler: requireSalesRead }, async (request, reply) => {
    const query = proposalsQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, query.error);
    const { status, leadId, dealId, area } = query.data;
    const result = await runTableQuery(store.proposals, {
      match: { ...(status ? { status } : {}), ...(leadId ? { leadId } : {}), ...(dealId ? { dealId } : {}), ...(area ? { area } : {}) } as Filter<ProposalDoc>,
      query: query.data,
      sortable: { title: "title", status: { field: "status", order: PROPOSAL_STATUSES }, amountCents: "amountCents", sentAt: "sentAt", createdAt: "createdAt" },
      defaultSort: { key: "createdAt", dir: "desc" },
      search: ["title"],
      facetField: "status",
      sums: { amountCents: "amountCents" }
    });
    const refs = await leadAndDealRefs(result.rows);
    return { ...result, rows: result.rows.map((p) => ({ ...proposalView(p), ...refs(p), lines: (p.lines ?? []).length })), canWrite: isSales(request.user!) };
  });

  app.get("/api/proposals/:id", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const proposal = await store.proposals.findOne({ _id: params.data.id });
    const user = request.user!;
    // Fuera de Comercial y Financiera, solo quien ve el proyecto de la cotización.
    const readable =
      proposal &&
      ((SALES_READ_ROLES as readonly string[]).includes(user.role) ||
        (proposal.projectId && (await store.opsProjects.findOne({ _id: proposal.projectId, ...(user.role === "boss" ? {} : { teamId: user.teamId ?? "__none__" }) }))));
    if (!proposal || !readable) return reply.code(404).send({ error: "Cotización no encontrada." });
    return { proposal: await proposalDetail(proposal), canWrite: await canWriteProposal(user, proposal) };
  });

  app.post("/api/proposals", { preHandler: requireSales }, async (request, reply) => {
    const body = createProposalSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const input = body.data;
    if (!(await checkLeadDeal(input, reply))) return reply;
    if (!(await checkUseCases(input.useCaseIds, reply))) return reply;
    if (input.lines?.length && input.amountCents != null) return reply.code(400).send({ error: "Con líneas, el monto se calcula: no lo envíes." });
    const lines = input.lines ? await buildLines(input.lines, reply) : [];
    if (!lines) return reply;
    const deal = input.dealId ? await store.deals.findOne({ _id: input.dealId }, { projection: { projectId: 1, leadId: 1 } }) : null;
    const user = request.user!;
    const at = new Date();
    const status = input.status ?? "draft";
    const proposal: ProposalDoc = {
      _id: randomUUID(),
      leadId: input.leadId ?? deal?.leadId ?? null,
      projectId: deal?.projectId ?? null,
      dealId: input.dealId ?? null,
      title: input.title,
      url: input.url,
      amountCents: lines.length ? linesTotalCents(lines) : (input.amountCents ?? null),
      currency: input.currency ?? "USD",
      status,
      area: "commercial",
      lines,
      useCaseIds: [...new Set(input.useCaseIds ?? [])],
      ...statusDates(status, null, at),
      createdBy: user.username,
      createdAt: at,
      updatedAt: at
    };
    await store.proposals.insertOne(proposal);
    await proposalChanged(user, proposal, null, status);
    await audit(user, "sales.proposal_created", `sales:${proposal.leadId ?? proposal.dealId}`, proposal.title, { lines: lines.length });
    return reply.code(201).send({ proposal: await proposalDetail(proposal) });
  });

  app.patch("/api/proposals/:id", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = updateProposalSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const proposal = await store.proposals.findOne({ _id: params.data.id });
    if (!proposal) return reply.code(404).send({ error: "Cotización no encontrada." });
    const user = request.user!;
    if (!(await canWriteProposal(user, proposal))) return forbidden(reply);
    const patch = body.data;
    // Operativa cambia el contenido de la cotización de su proyecto, no a qué lead o deal pertenece.
    if (!isSales(user) && (patch.leadId !== undefined || patch.dealId !== undefined)) return forbidden(reply);
    if (!(await checkLeadDeal(patch, reply))) return reply;
    if (!(await checkUseCases(patch.useCaseIds, reply))) return reply;
    const hasLines = patch.lines ? patch.lines.length > 0 : (proposal.lines ?? []).length > 0;
    if (patch.amountCents !== undefined && hasLines) return reply.code(400).send({ error: "Con líneas, el monto se calcula: no lo envíes." });
    const lines = patch.lines ? await buildLines(patch.lines, reply) : undefined;
    if (lines === null) return reply;
    const at = new Date();
    const { lines: _lines, ...rest } = patch;
    void _lines;
    const set: Partial<ProposalDoc> = {
      ...rest,
      ...(lines ? { lines, amountCents: lines.length ? linesTotalCents(lines) : (patch.amountCents ?? null) } : {}),
      ...(patch.useCaseIds ? { useCaseIds: [...new Set(patch.useCaseIds)] } : {}),
      ...(patch.status ? statusDates(patch.status, proposal.status, at) : {}),
      updatedAt: at
    };
    await store.proposals.updateOne({ _id: proposal._id }, { $set: set });
    const fresh = (await store.proposals.findOne({ _id: proposal._id }))!;
    if (patch.status && patch.status !== proposal.status) {
      await proposalChanged(user, fresh, proposal.status, patch.status);
      await audit(user, "sales.proposal_status_changed", `sales:${fresh.leadId ?? fresh.dealId ?? fresh.projectId}`, fresh.title, { from: proposal.status, to: patch.status });
    }
    return { proposal: await proposalDetail(fresh) };
  });
}
