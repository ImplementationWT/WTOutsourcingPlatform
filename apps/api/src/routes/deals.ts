import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import type { SessionUser } from "../auth/users.js";
import { canCreateDeal, canEditDeal, canReadDeal, COMMERCIAL_DEAL_STATUSES, dealScope } from "../core/access.js";
import { runTableQuery, tableQuerySchema } from "../lib/table-query.js";
import {
  CHANGE_ORDER_STATUSES,
  type ChangeOrderDoc,
  DEAL_STATUSES,
  type DealDoc,
  dealAmountCents,
  dealCodeOf,
  projectedCents,
  SALE_TYPES,
  SALES_STAGES
} from "../ops/models.js";
import type { AdminStore } from "../store/admin-store.js";

const idParams = z.object({ id: z.string().uuid() });
const idsParams = z.object({ id: z.string().uuid(), childId: z.string().uuid() });
const text = (max: number) => z.string().trim().max(max);
const nullableText = (max: number) => text(max).nullable().transform((v) => (v ? v : null));
const url = z
  .string()
  .trim()
  .max(500)
  .refine((v) => /^https?:\/\//i.test(v), "Debe empezar por http:// o https://")
  .nullable();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Usa el formato AAAA-MM-DD.").nullable();
const uuidOrNull = z.string().uuid().nullable();

const dealFields = {
  title: text(160).min(3),
  description: text(4000),
  projectId: uuidOrNull,
  leadId: uuidOrNull,
  contactIds: z.array(z.string().uuid()).max(50),
  ownerUserId: uuidOrNull,
  salesStage: z.enum(SALES_STAGES),
  status: z.enum(DEAL_STATUSES),
  hours: z.number().min(0).max(100_000),
  rateCents: z.number().int().min(0).max(100_000_000),
  probability: z.number().int().min(0).max(100),
  currency: z.string().regex(/^[A-Z]{3}$/),
  expectedCloseDate: isoDate,
  actualCloseDate: isoDate,
  saleType: z.enum(SALE_TYPES).nullable(),
  product: nullableText(120),
  channel: nullableText(120),
  lostReason: nullableText(500),
  partnerCommissionPct: z.number().min(0).max(100).nullable(),
  proposalUrl: url,
  sowUrl: url
};
const createDealSchema = z
  .object(dealFields)
  .partial()
  .required({ title: true })
  .strict();
const updateDealSchema = z
  .object(dealFields)
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, "No hay nada que cambiar.");

const changeOrderFields = {
  description: text(1000).min(3),
  hours: z.number().min(0).max(100_000),
  rateCents: z.number().int().min(0).max(100_000_000),
  status: z.enum(CHANGE_ORDER_STATUSES),
  signedBy: nullableText(120)
};
const createChangeOrderSchema = z
  .object(changeOrderFields)
  .partial()
  .required({ description: true, hours: true, rateCents: true })
  .strict();
const updateChangeOrderSchema = z
  .object(changeOrderFields)
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, "No hay nada que cambiar.");

const listQuery = tableQuerySchema.extend({
  status: z.enum(DEAL_STATUSES).optional(),
  salesStage: z.enum(SALES_STAGES).optional(),
  projectId: z.string().uuid().optional(),
  leadId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
  ownerUserId: z.string().uuid().optional()
});

const STATUS_LABELS: Record<DealDoc["status"], string> = {
  draft: "Borrador",
  proposed: "Propuesto",
  approved: "Aprobado",
  in_progress: "En curso",
  delivered: "Entregado",
  invoiced: "Facturado",
  paid: "Cobrado",
  cancelled: "Cancelado"
};

const invalid = (reply: FastifyReply, error: z.ZodError) =>
  reply.code(400).send({ error: "Datos inválidos.", issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
const forbidden = (reply: FastifyReply) => reply.code(403).send({ error: "No tienes permiso para esta acción." });

const changeOrderView = (co: ChangeOrderDoc) => ({
  id: co._id,
  description: co.description,
  hours: co.hours,
  rateCents: co.rateCents,
  amountCents: co.amountCents,
  status: co.status,
  approvedAt: co.approvedAt,
  signedBy: co.signedBy,
  createdAt: co.createdAt
});

/** Deals: tabla de primer nivel compartida por Comercial y Operativa (docs/rework-plataforma.md §4.1). */
export async function registerDealRoutes(app: FastifyInstance, { store }: { store: AdminStore }) {
  const audit = (user: SessionUser, deal: Pick<DealDoc, "_id" | "dealCode" | "title">, action: string, details?: Record<string, string | number | boolean>) =>
    store.audit({ actor: user.username, action: `core.deal_${action}`, clientId: `core:${deal._id}`, target: `${deal.dealCode} ${deal.title}`, ...(details ? { details } : {}) });

  /** Novedad automática en el proyecto del deal (si tiene). */
  const note = (user: SessionUser, projectId: string | null, body: string) =>
    projectId
      ? store.projectUpdates.insertOne({ _id: randomUUID(), projectId, kind: "system", body, authorUsername: user.username, authorName: user.name, createdAt: new Date() })
      : null;

  /** Nombres de proyectos, leads, contactos y responsables de un grupo de deals. */
  async function relations(deals: DealDoc[]) {
    const ids = (pick: (d: DealDoc) => (string | null)[]) => [...new Set(deals.flatMap(pick).filter((v): v is string => Boolean(v)))];
    const projectIds = ids((d) => [d.projectId]);
    const leadIds = ids((d) => [d.leadId]);
    const contactIds = ids((d) => d.contactIds ?? []);
    const userIds = ids((d) => [d.ownerUserId]);
    const [projects, leads, contacts, users] = await Promise.all([
      projectIds.length ? store.opsProjects.find({ _id: { $in: projectIds } }, { projection: { name: 1, customerName: 1 } }).toArray() : [],
      leadIds.length ? store.leads.find({ _id: { $in: leadIds } }, { projection: { company: 1, contactName: 1, email: 1 } }).toArray() : [],
      contactIds.length ? store.contacts.find({ _id: { $in: contactIds } }, { projection: { name: 1 } }).toArray() : [],
      userIds.length ? store.users.find({ _id: { $in: userIds } }, { projection: { name: 1 } }).toArray() : []
    ]);
    const project = new Map(projects.map((p) => [p._id, { id: p._id, name: p.name, customerName: p.customerName }]));
    const lead = new Map(leads.map((l) => [l._id, { id: l._id, title: l.company || l.contactName || l.email || "Lead" }]));
    const contact = new Map(contacts.map((c) => [c._id, { id: c._id, name: c.name }]));
    const user = new Map(users.map((u) => [u._id, { id: u._id, name: u.name }]));
    return (deal: DealDoc, viewer: SessionUser, full = false) => ({
      id: deal._id,
      dealCode: deal.dealCode,
      title: deal.title,
      description: deal.description,
      project: deal.projectId ? (project.get(deal.projectId) ?? null) : null,
      lead: deal.leadId ? (lead.get(deal.leadId) ?? null) : null,
      contacts: (deal.contactIds ?? []).map((id) => contact.get(id)).filter(Boolean),
      owner: deal.ownerUserId ? (user.get(deal.ownerUserId) ?? null) : null,
      salesStage: deal.salesStage,
      status: deal.status,
      hours: deal.hours,
      rateCents: deal.rateCents,
      amountCents: deal.amountCents,
      probability: deal.probability,
      projectedCents: deal.projectedCents,
      currency: deal.currency,
      expectedCloseDate: deal.expectedCloseDate,
      actualCloseDate: deal.actualCloseDate,
      saleType: deal.saleType,
      product: deal.product,
      channel: deal.channel,
      lostReason: deal.lostReason,
      partnerCommissionPct: deal.partnerCommissionPct,
      proposalUrl: deal.proposalUrl,
      sowUrl: deal.sowUrl,
      paidAt: deal.paidAt ?? null,
      updatedAt: deal.updatedAt,
      canEdit: canEditDeal(viewer, deal),
      ...(full ? { changeOrders: (deal.changeOrders ?? []).map(changeOrderView) } : {})
    });
  }

  /**
   * Valida las relaciones de un alta o cambio y devuelve el equipo del proyecto (o null). Responde
   * 400/403 y devuelve undefined si algo no cuadra.
   */
  async function checkLinks(user: SessionUser, input: Partial<Pick<DealDoc, "projectId" | "leadId" | "contactIds" | "ownerUserId">>, reply: FastifyReply) {
    let teamId: string | null | undefined;
    if (input.projectId !== undefined) {
      if (input.projectId) {
        const project = await store.opsProjects.findOne({ _id: input.projectId }, { projection: { teamId: 1 } });
        if (!project) return void reply.code(400).send({ error: "El proyecto no existe." });
        if (user.role === "lead" && project.teamId !== user.teamId) return void forbidden(reply);
        teamId = project.teamId;
      } else {
        if (user.role === "lead") return void reply.code(400).send({ error: "Un deal de tu equipo necesita un proyecto." });
        teamId = null;
      }
    }
    if (input.leadId && !(await store.leads.findOne({ _id: input.leadId }, { projection: { _id: 1 } }))) return void reply.code(400).send({ error: "El lead no existe." });
    if (input.contactIds?.length && (await store.contacts.countDocuments({ _id: { $in: input.contactIds } })) !== new Set(input.contactIds).size) {
      return void reply.code(400).send({ error: "Algún contacto no existe." });
    }
    if (input.ownerUserId && !(await store.users.findOne({ _id: input.ownerUserId, active: true }, { projection: { _id: 1 } }))) {
      return void reply.code(400).send({ error: "El responsable debe ser un usuario activo." });
    }
    return { teamId };
  }

  app.get("/api/deals", { preHandler: requireAuth }, async (request, reply) => {
    const query = listQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, query.error);
    const user = request.user!;
    const { status, salesStage, projectId, leadId, contactId, ownerUserId } = query.data;
    const result = await runTableQuery(store.deals, {
      match: {
        ...dealScope(user),
        ...(status ? { status } : {}),
        ...(salesStage ? { salesStage } : {}),
        ...(projectId ? { projectId } : {}),
        ...(leadId ? { leadId } : {}),
        ...(contactId ? { contactIds: contactId } : {}),
        ...(ownerUserId ? { ownerUserId } : {})
      },
      query: query.data,
      sortable: {
        dealCode: "dealCode",
        title: "title",
        status: { field: "status", order: DEAL_STATUSES },
        salesStage: { field: "salesStage", order: SALES_STAGES },
        hours: "hours",
        rateCents: "rateCents",
        amountCents: "amountCents",
        probability: "probability",
        projectedCents: "projectedCents",
        expectedCloseDate: "expectedCloseDate",
        updatedAt: "updatedAt"
      },
      defaultSort: { key: "dealCode", dir: "desc" },
      search: ["dealCode", "title", "description", "product"],
      facetField: "status",
      sums: { hours: "hours", amountCents: "amountCents", projectedCents: "projectedCents" }
    });
    const view = await relations(result.rows);
    return { ...result, rows: result.rows.map((d) => view(d, user)), canCreate: canCreateDeal(user) };
  });

  app.post("/api/deals", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user!;
    if (!canCreateDeal(user)) return forbidden(reply);
    const body = createDealSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const input = body.data;
    const status = input.status ?? "draft";
    if (user.role === "commercial" && !COMMERCIAL_DEAL_STATUSES.includes(status)) return reply.code(403).send({ error: "Comercial crea deals hasta «Propuesto»." });
    if (user.role === "lead" && !input.projectId) return reply.code(400).send({ error: "Un deal de tu equipo necesita un proyecto." });
    const links = await checkLinks(user, { projectId: input.projectId ?? null, leadId: input.leadId, contactIds: input.contactIds, ownerUserId: input.ownerUserId }, reply);
    if (!links) return reply;
    const at = new Date();
    const hours = input.hours ?? 0;
    const rateCents = input.rateCents ?? 0;
    const probability = input.probability ?? 50;
    const amountCents = dealAmountCents(hours, rateCents);
    const deal: DealDoc = {
      _id: randomUUID(),
      dealCode: dealCodeOf(await store.nextSequence("deal")),
      projectId: input.projectId ?? null,
      teamId: links.teamId ?? null,
      leadId: input.leadId ?? null,
      partnerId: null,
      contactIds: [...new Set(input.contactIds ?? [])],
      ownerUserId: input.ownerUserId ?? null,
      title: input.title,
      description: input.description ?? "",
      salesStage: input.salesStage ?? "new",
      status,
      hours,
      rateCents,
      amountCents,
      probability,
      projectedCents: projectedCents(amountCents, probability),
      currency: input.currency ?? "USD",
      expectedCloseDate: input.expectedCloseDate ?? null,
      actualCloseDate: input.actualCloseDate ?? null,
      saleType: input.saleType ?? null,
      product: input.product ?? null,
      channel: input.channel ?? null,
      lostReason: input.lostReason ?? null,
      partnerCommissionPct: input.partnerCommissionPct ?? null,
      proposalUrl: input.proposalUrl ?? null,
      sowUrl: input.sowUrl ?? null,
      changeOrders: [],
      createdBy: user.username,
      createdAt: at,
      updatedAt: at,
      ...(status === "paid" ? { paidAt: at } : {})
    };
    await store.deals.insertOne(deal);
    await audit(user, deal, "created", { hours: deal.hours });
    await note(user, deal.projectId, `Nuevo deal ${deal.dealCode}: «${deal.title}».`);
    const view = await relations([deal]);
    return reply.code(201).send({ deal: view(deal, user, true) });
  });

  /** Carga el deal si el usuario puede verlo; si no existe o es de otro equipo responde 404. */
  async function readable(user: SessionUser, id: string, reply: FastifyReply) {
    const deal = await store.deals.findOne({ _id: id });
    if (!deal || !canReadDeal(user, deal)) {
      void reply.code(404).send({ error: "Deal no encontrado." });
      return null;
    }
    return deal;
  }

  app.get("/api/deals/:id", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const user = request.user!;
    const deal = await readable(user, params.data.id, reply);
    if (!deal) return reply;
    const view = await relations([deal]);
    return { deal: view(deal, user, true) };
  });

  app.patch("/api/deals/:id", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = updateDealSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const user = request.user!;
    const deal = await readable(user, params.data.id, reply);
    if (!deal) return reply;
    if (!canEditDeal(user, deal)) return forbidden(reply);
    const patch = body.data;
    if (user.role === "commercial" && patch.status && !COMMERCIAL_DEAL_STATUSES.includes(patch.status)) {
      return reply.code(403).send({ error: "Comercial edita deals hasta «Propuesto»." });
    }
    // Una vez facturado o cobrado, horas, tarifa y moneda quedan fijas: los cambios van como change order.
    const locked = deal.status === "invoiced" || deal.status === "paid";
    if (locked && (patch.hours !== undefined || patch.rateCents !== undefined || patch.currency !== undefined)) {
      return reply.code(409).send({ error: "El deal ya está facturado o cobrado: las horas y la tarifa no cambian. Registra un change order." });
    }
    const links = await checkLinks(user, { projectId: patch.projectId, leadId: patch.leadId, contactIds: patch.contactIds, ownerUserId: patch.ownerUserId }, reply);
    if (!links) return reply;
    const at = new Date();
    const hours = patch.hours ?? deal.hours;
    const rateCents = patch.rateCents ?? deal.rateCents;
    const probability = patch.probability ?? deal.probability;
    const amountCents = dealAmountCents(hours, rateCents);
    const set: Partial<DealDoc> = {
      ...patch,
      ...(patch.contactIds ? { contactIds: [...new Set(patch.contactIds)] } : {}),
      ...(links.teamId !== undefined ? { teamId: links.teamId } : {}),
      amountCents,
      projectedCents: projectedCents(amountCents, probability),
      updatedAt: at
    };
    const unset: Record<string, ""> = {};
    if (patch.status === "paid" && deal.status !== "paid") set.paidAt = at;
    if (patch.status && patch.status !== "paid" && deal.status === "paid") unset.paidAt = "";
    await store.deals.updateOne({ _id: deal._id }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
    const fresh = (await store.deals.findOne({ _id: deal._id }))!;
    if (patch.status && patch.status !== deal.status) {
      await note(user, fresh.projectId, `Deal ${deal.dealCode} «${deal.title}»: ${STATUS_LABELS[deal.status]} → ${STATUS_LABELS[patch.status]}`);
      await audit(user, deal, "status_changed", { from: deal.status, to: patch.status });
    } else {
      await audit(user, deal, "updated");
    }
    const view = await relations([fresh]);
    return { deal: view(fresh, user, true) };
  });

  // ---- change orders -----------------------------------------------------------

  app.post("/api/deals/:id/change-orders", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = createChangeOrderSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const user = request.user!;
    const deal = await readable(user, params.data.id, reply);
    if (!deal) return reply;
    if (!canEditDeal(user, deal)) return forbidden(reply);
    const at = new Date();
    const status = body.data.status ?? "draft";
    const co: ChangeOrderDoc = {
      _id: randomUUID(),
      description: body.data.description,
      hours: body.data.hours,
      rateCents: body.data.rateCents,
      amountCents: dealAmountCents(body.data.hours, body.data.rateCents),
      status,
      approvedAt: status === "approved" ? at : null,
      signedBy: body.data.signedBy ?? null,
      createdBy: user.username,
      createdAt: at,
      updatedAt: at
    };
    await store.deals.updateOne({ _id: deal._id }, { $push: { changeOrders: co }, $set: { updatedAt: at } });
    await audit(user, deal, "change_order_created", { hours: co.hours });
    await note(user, deal.projectId, `Change order en ${deal.dealCode}: «${co.description}» (${co.hours} h).`);
    return reply.code(201).send({ changeOrder: changeOrderView(co) });
  });

  app.patch("/api/deals/:id/change-orders/:childId", { preHandler: requireAuth }, async (request, reply) => {
    const params = idsParams.safeParse(request.params);
    const body = updateChangeOrderSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const user = request.user!;
    const deal = await readable(user, params.data.id, reply);
    if (!deal) return reply;
    if (!canEditDeal(user, deal)) return forbidden(reply);
    const co = (deal.changeOrders ?? []).find((c) => c._id === params.data.childId);
    if (!co) return reply.code(404).send({ error: "Change order no encontrado." });
    const patch = body.data;
    if (co.status === "approved" && (patch.hours !== undefined || patch.rateCents !== undefined)) {
      return reply.code(409).send({ error: "El change order ya está aprobado: sus horas y tarifa no cambian." });
    }
    const at = new Date();
    const next: ChangeOrderDoc = {
      ...co,
      ...patch,
      amountCents: dealAmountCents(patch.hours ?? co.hours, patch.rateCents ?? co.rateCents),
      approvedAt: patch.status === "approved" && co.status !== "approved" ? at : patch.status && patch.status !== "approved" ? null : co.approvedAt,
      updatedAt: at
    };
    await store.deals.updateOne({ _id: deal._id, "changeOrders._id": co._id }, { $set: { "changeOrders.$": next, updatedAt: at } });
    if (patch.status && patch.status !== co.status) await audit(user, deal, "change_order_status_changed", { from: co.status, to: patch.status });
    return { changeOrder: changeOrderView(next) };
  });
}
