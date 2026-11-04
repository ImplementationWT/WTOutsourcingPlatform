import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireModule } from "../auth/modules.js";
import type { AdminStore } from "../store/admin-store.js";

/** Stages de una invoice (en el orden del tablero). «Upcoming» también se calcula: Pending de un mes futuro. */
export const INVOICE_STAGES = ["overdue", "follow_up", "due", "pending", "invoiced", "upcoming", "paid"] as const;
export type InvoiceStage = (typeof INVOICE_STAGES)[number];

/** Invoice de un deal: horas × rate del deal = monto bruto; total = bruto + fee. */
export interface InvoiceDoc {
  _id: string;
  number: number;
  month: string; // AAAA-MM
  stage: InvoiceStage;
  invoicedDate: string | null;
  paidDate: string | null;
  sustained: boolean;
  projectId: string;
  dealId: string | null;
  hours: number;
  feeCents: number;
  deletedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export const invoiceNumber = (n: number) => `INV-${String(n).padStart(4, "0")}`;
/** Stage efectivo: una Pending de un mes que aún no llega es Upcoming. */
export const effectiveStage = (v: Pick<InvoiceDoc, "stage" | "month">, month = new Date().toISOString().slice(0, 7)): InvoiceStage => (v.stage === "pending" && v.month > month ? "upcoming" : v.stage);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Usa el formato AAAA-MM-DD.");
const fields = {
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Usa el formato AAAA-MM."),
  stage: z.enum(INVOICE_STAGES),
  invoicedDate: isoDate.nullable(),
  paidDate: isoDate.nullable(),
  sustained: z.boolean(),
  projectId: z.string().uuid(),
  dealId: z.string().uuid().nullable(),
  hours: z.number().min(0).max(100_000),
  feeCents: z.number().int().min(0).max(1_000_000_000)
};
const createSchema = z.object(fields).partial().required({ projectId: true }).strict();
const updateSchema = z
  .object(fields)
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, "No hay nada que cambiar.");
const idParams = z.object({ id: z.string().uuid() });
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Invoices (Financiera: boss y finance). Una invoice pertenece a un deal de un proyecto: el rate sale
 * del deal y el team leader y el tipo de pago, del proyecto. Cambiar el stage no toca el deal.
 */
export async function registerInvoiceRoutes(app: FastifyInstance, { store }: { store: AdminStore }) {
  const invoices = store.db.collection<InvoiceDoc>("fin_invoices");
  const guard = { preHandler: requireModule("invoices") };

  async function present(rows: InvoiceDoc[]) {
    const projectIds = [...new Set(rows.map((r) => r.projectId))];
    const dealIds = [...new Set(rows.map((r) => r.dealId).filter((v): v is string => Boolean(v)))];
    const [projects, deals] = await Promise.all([
      projectIds.length ? store.opsProjects.find({ _id: { $in: projectIds } }, { projection: { name: 1, leadUserId: 1, paymentType: 1 } }).toArray() : [],
      dealIds.length ? store.deals.find({ _id: { $in: dealIds } }, { projection: { dealCode: 1, title: 1, rateCents: 1, currency: 1 } }).toArray() : []
    ]);
    const leadIds = [...new Set(projects.map((p) => p.leadUserId).filter((v): v is string => Boolean(v)))];
    const leads = leadIds.length ? await store.users.find({ _id: { $in: leadIds } }, { projection: { name: 1 } }).toArray() : [];
    const projectOf = new Map(projects.map((p) => [p._id, p]));
    const dealOf = new Map(deals.map((d) => [d._id, d]));
    const leadName = new Map(leads.map((u) => [u._id, u.name]));
    return rows.map((r) => {
      const project = projectOf.get(r.projectId);
      const deal = r.dealId ? dealOf.get(r.dealId) : undefined;
      const rateCents = deal?.rateCents ?? 0;
      const grossCents = Math.round(r.hours * rateCents);
      return {
        id: r._id,
        number: invoiceNumber(r.number),
        month: r.month,
        stage: r.stage,
        effectiveStage: effectiveStage(r),
        invoicedDate: r.invoicedDate,
        paidDate: r.paidDate,
        sustained: r.sustained,
        project: { id: r.projectId, name: project?.name ?? null },
        deal: deal ? { id: deal._id, code: deal.dealCode, title: deal.title } : null,
        lead: project?.leadUserId ? { id: project.leadUserId, name: leadName.get(project.leadUserId) ?? null } : null,
        paymentType: project?.paymentType ?? null,
        hours: r.hours,
        rateCents,
        grossCents,
        feeCents: r.feeCents,
        totalCents: grossCents + r.feeCents,
        currency: deal?.currency ?? "USD"
      };
    });
  }

  /** Lista y opciones (proyectos con sus deals) para crear y relacionar invoices. */
  app.get("/api/invoices", guard, async () => {
    const [rows, projects] = await Promise.all([
      invoices.find({ deletedAt: null }).sort({ month: -1, number: -1 }).toArray(),
      store.opsProjects.find({}, { projection: { name: 1 } }).sort({ name: 1 }).toArray()
    ]);
    const deals = await store.deals.find({ projectId: { $in: projects.map((p) => p._id) }, status: { $ne: "cancelled" } }, { projection: { projectId: 1, dealCode: 1, title: 1, rateCents: 1 } }).sort({ dealCode: 1 }).toArray();
    return {
      invoices: await present(rows),
      projects: projects.map((p) => ({ id: p._id, name: p.name, deals: deals.filter((d) => d.projectId === p._id).map((d) => ({ id: d._id, code: d.dealCode, title: d.title, rateCents: d.rateCents })) }))
    };
  });

  /** El deal debe ser del proyecto. */
  async function checkDeal(projectId: string, dealId: string | null | undefined, reply: FastifyReply) {
    if (!(await store.opsProjects.findOne({ _id: projectId }, { projection: { _id: 1 } }))) {
      void reply.code(400).send({ error: "El proyecto no existe." });
      return false;
    }
    if (dealId && !(await store.deals.findOne({ _id: dealId, projectId }, { projection: { _id: 1 } }))) {
      void reply.code(400).send({ error: "El deal no es de ese proyecto." });
      return false;
    }
    return true;
  }

  /** Al pasar a un stage facturado se fija la fecha de factura; al pasar a Paid, la de pago. */
  const stageDates = (stage: InvoiceStage | undefined, current: Pick<InvoiceDoc, "invoicedDate" | "paidDate">) => ({
    ...(stage && !["pending", "upcoming"].includes(stage) && !current.invoicedDate ? { invoicedDate: today() } : {}),
    ...(stage === "paid" && !current.paidDate ? { paidDate: today() } : {})
  });

  app.post("/api/invoices", guard, async (request, reply) => {
    const body = createSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? "Datos inválidos." });
    const input = body.data;
    let dealId = input.dealId;
    if (dealId === undefined) dealId = (await store.deals.findOne({ projectId: input.projectId, status: { $ne: "cancelled" } }, { sort: { createdAt: 1 }, projection: { _id: 1 } }))?._id ?? null;
    if (!(await checkDeal(input.projectId, dealId, reply))) return reply;
    const user = request.user!;
    const at = new Date();
    const base = { invoicedDate: input.invoicedDate ?? null, paidDate: input.paidDate ?? null };
    const doc: InvoiceDoc = {
      _id: randomUUID(),
      number: await store.nextSequence("invoice"),
      month: input.month ?? today().slice(0, 7),
      stage: input.stage ?? "pending",
      ...base,
      ...stageDates(input.stage, base),
      sustained: input.sustained ?? false,
      projectId: input.projectId,
      dealId,
      hours: input.hours ?? 0,
      feeCents: input.feeCents ?? 0,
      deletedAt: null,
      createdBy: user.username,
      createdAt: at,
      updatedAt: at
    };
    await invoices.insertOne(doc);
    await store.audit({ actor: user.username, action: "finance.invoice_created", clientId: `ops:${doc.projectId}`, target: invoiceNumber(doc.number) });
    return reply.code(201).send({ invoice: (await present([doc]))[0] });
  });

  async function found(request: FastifyRequest, reply: FastifyReply, deleted = false) {
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      void reply.code(400).send({ error: "Id inválido." });
      return null;
    }
    const doc = await invoices.findOne({ _id: params.data.id, deletedAt: deleted ? { $type: "date" } : null } as never);
    if (!doc) void reply.code(404).send({ error: "Invoice no encontrada." });
    return doc;
  }

  app.patch("/api/invoices/:id", guard, async (request, reply) => {
    const body = updateSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? "Datos inválidos." });
    const doc = await found(request, reply);
    if (!doc) return reply;
    const patch = body.data;
    const projectId = patch.projectId ?? doc.projectId;
    // Cambiar de proyecto sin deal elegido toma el primer deal del proyecto nuevo.
    let dealId = patch.dealId !== undefined ? patch.dealId : doc.dealId;
    if (patch.projectId && patch.projectId !== doc.projectId && patch.dealId === undefined) dealId = (await store.deals.findOne({ projectId, status: { $ne: "cancelled" } }, { sort: { createdAt: 1 }, projection: { _id: 1 } }))?._id ?? null;
    if (!(await checkDeal(projectId, dealId, reply))) return reply;
    const set = { ...patch, dealId, ...stageDates(patch.stage, { invoicedDate: patch.invoicedDate !== undefined ? patch.invoicedDate : doc.invoicedDate, paidDate: patch.paidDate !== undefined ? patch.paidDate : doc.paidDate }), updatedAt: new Date() };
    await invoices.updateOne({ _id: doc._id }, { $set: set });
    if (patch.stage && patch.stage !== doc.stage) await store.audit({ actor: request.user!.username, action: "finance.invoice_stage_changed", clientId: `ops:${projectId}`, target: `${invoiceNumber(doc.number)}: ${doc.stage} → ${patch.stage}` });
    return { invoice: (await present([(await invoices.findOne({ _id: doc._id }))!]))[0] };
  });

  app.delete("/api/invoices/:id", guard, async (request, reply) => {
    const doc = await found(request, reply);
    if (!doc) return reply;
    await invoices.updateOne({ _id: doc._id }, { $set: { deletedAt: new Date() } });
    await store.audit({ actor: request.user!.username, action: "finance.invoice_deleted", clientId: `ops:${doc.projectId}`, target: invoiceNumber(doc.number) });
    return { ok: true };
  });

  app.post("/api/invoices/:id/restore", guard, async (request, reply) => {
    const doc = await found(request, reply, true);
    if (!doc) return reply;
    await invoices.updateOne({ _id: doc._id }, { $set: { deletedAt: null } });
    return { ok: true };
  });
}
