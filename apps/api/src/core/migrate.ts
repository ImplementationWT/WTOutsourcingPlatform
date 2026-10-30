import { dealCodeOf, projectedCents, SOLD_DEAL_STATUSES, type DealDoc, type DealStatus, type SalesStage } from "../ops/models.js";
import { actionItemsOf } from "../meetings/routes.js";
import type { ClientSentiment, MeetingCore } from "../ops/models.js";
import type { AdminStore } from "../store/admin-store.js";
import type { Collection, Filter } from "mongodb";

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

/** Sentimiento numérico de la v1 → categoría (Excelente / Bien / Neutral / Fricción). */
export const sentimentCategory = (value: number): ClientSentiment => (value >= 80 ? "excellent" : value >= 60 ? "good" : value >= 40 ? "neutral" : "friction");

/**
 * Pasos 3 y 4 (Comercial y reuniones), idempotente como la anterior:
 * - Leads: el responsable de la v1 pasa a Closer, y la fecha de llegada es la de alta.
 * - Reuniones: los action items de texto pasan a subregistros, el sentimiento numérico a su
 *   categoría, y las que no tienen estado de proceso quedan «Nueva sin procesar».
 */
export async function migrateToV3(store: AdminStore) {
  for (const lead of await store.leads.find({ ownerUserId: { $exists: true } }, { projection: { ownerUserId: 1, closerUserId: 1 } }).toArray()) {
    await store.leads.updateOne({ _id: lead._id }, { $set: { closerUserId: lead.closerUserId ?? lead.ownerUserId ?? null }, $unset: { ownerUserId: "" } });
  }
  for (const lead of await store.leads.find({ submittedAt: { $exists: false } }, { projection: { createdAt: 1 } }).toArray()) {
    await store.leads.updateOne({ _id: lead._id }, { $set: { submittedAt: lead.createdAt.toISOString().slice(0, 10) } });
  }
  for (const collection of [store.meetings, store.leadMeetings] as unknown as Collection<MeetingCore>[]) {
    const stale = await collection.find({ $or: [{ reviewStatus: { $exists: false } }, { "actionItems.0": { $type: "string" } }, { sentimentSignal: { $type: "number" } }] } as Filter<MeetingCore>).toArray();
    for (const meeting of stale) {
      await collection.updateOne(
        { _id: meeting._id },
        {
          $set: {
            actionItems: actionItemsOf(meeting.actionItems),
            reviewStatus: meeting.reviewStatus ?? "new",
            clientSentiment: meeting.clientSentiment ?? (typeof meeting.sentimentSignal === "number" ? sentimentCategory(meeting.sentimentSignal) : null)
          },
          $unset: { sentimentSignal: "" }
        }
      );
    }
  }
}
