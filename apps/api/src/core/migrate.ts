import { dealCodeOf, projectedCents, SOLD_DEAL_STATUSES, type DealDoc, type DealStatus, type SalesStage } from "../ops/models.js";
import type { AdminStore } from "../store/admin-store.js";

/** Etapa comercial de un deal de la Fase 1, que solo tenía estado operativo. */
const stageOf = (status: DealStatus): SalesStage => (status === "cancelled" ? "lost" : SOLD_DEAL_STATUSES.includes(status) ? "won" : "proposal");
const probabilityOf = (status: DealStatus) => (status === "cancelled" ? 0 : SOLD_DEAL_STATUSES.includes(status) ? 100 : 50);

/**
 * Lleva los datos de la Fase 1 a la estructura v2 (docs/rework-plataforma.md §9). Corre en cada
 * arranque y es idempotente: solo toca lo que aún no está migrado.
 * - Clientes de la Fase 1 → Empresas (mismo id), y el proyecto apunta a su Empresa.
 * - Deals sin código → DL-0001… en orden de creación, con los campos nuevos y el equipo del proyecto.
 */
export async function migrateToV2(store: AdminStore) {
  for (const customer of await store.customers.find({}).toArray()) {
    await store.companies.updateOne(
      { _id: customer._id },
      {
        $setOnInsert: {
          name: customer.name,
          domain: customer.email?.split("@")[1] ?? null,
          industry: null,
          size: null,
          location: null,
          createdBy: customer.createdBy,
          createdAt: customer.createdAt,
          updatedAt: customer.updatedAt
        }
      },
      { upsert: true }
    );
  }
  await store.opsProjects.updateMany({ customerId: { $type: "string" }, companyId: { $exists: false } }, [{ $set: { companyId: "$customerId" } }]);

  const legacy = await store.deals.find({ dealCode: { $exists: false } }).sort({ createdAt: 1, _id: 1 }).toArray();
  if (!legacy.length) return;
  const projects = await store.opsProjects.find({ _id: { $in: legacy.map((d) => d.projectId).filter((v): v is string => Boolean(v)) } }, { projection: { teamId: 1 } }).toArray();
  const teamOf = new Map(projects.map((p) => [p._id, p.teamId]));
  for (const deal of legacy) {
    const probability = probabilityOf(deal.status);
    const set: Partial<DealDoc> = {
      dealCode: dealCodeOf(await store.nextSequence("deal")),
      teamId: deal.projectId ? (teamOf.get(deal.projectId) ?? null) : null,
      leadId: null,
      partnerId: null,
      contactIds: [],
      ownerUserId: null,
      salesStage: stageOf(deal.status),
      probability,
      projectedCents: projectedCents(deal.amountCents, probability),
      expectedCloseDate: null,
      actualCloseDate: null,
      saleType: null,
      product: null,
      channel: null,
      lostReason: null,
      partnerCommissionPct: null,
      sowUrl: null,
      changeOrders: []
    };
    // Solo si sigue sin código (otra instancia pudo migrarlo a la vez).
    await store.deals.updateOne({ _id: deal._id, dealCode: { $exists: false } }, { $set: set });
  }
}
