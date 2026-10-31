import { dealCodeOf, projectedCents, SOLD_DEAL_STATUSES, type DealDoc, type DealStatus, type SalesStage } from "../ops/models.js";
import { actionItemsOf } from "../meetings/routes.js";
import { teamFromParticipants } from "../meetings/teams.js";
import type { ClientSentiment, MeetingCore, MeetingDoc } from "../ops/models.js";
import type { AdminStore } from "../store/admin-store.js";
import type { Collection, Filter } from "mongodb";

/** Etapa comercial de un deal de la Fase 1, que solo tenía estado operativo. */
const stageOf = (status: DealStatus): SalesStage => (status === "cancelled" ? "lost" : SOLD_DEAL_STATUSES.includes(status) ? "won" : "proposal");
const probabilityOf = (status: DealStatus) => (status === "cancelled" ? 0 : SOLD_DEAL_STATUSES.includes(status) ? 100 : 50);

/**
 * Lleva los datos de la Fase 1 a la estructura v2 (docs/rework-plataforma.md §9). Corre en cada
 * arranque y es idempotente: solo toca lo que aún no está migrado.
 * - Deals sin código → DL-0001… en orden de creación, con los campos nuevos y el equipo del proyecto.
 */
export async function migrateToV2(store: AdminStore) {
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
  for (const collection of [store.meetings] as unknown as Collection<MeetingCore>[]) {
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

/** Colecciones que se eliminaron del producto (Empresas, Partners, Catálogo y Sources de leads). */
const REMOVED_COLLECTIONS = ["core_companies", "sales_partners", "sales_products", "sales_use_cases", "sales_lead_sources", "sales_customers"];
/** Colecciones de reuniones de antes de la tabla única. */
const LEGACY_MEETINGS: { name: string; owner: "projectId" | "leadId" | null }[] = [
  { name: "ops_meetings", owner: "projectId" },
  { name: "sales_meetings", owner: "leadId" },
  { name: "meetings_inbox", owner: null }
];

/**
 * Meetings como tabla única y limpieza de lo que se quitó del producto. Idempotente:
 * - Las reuniones de proyectos, de leads y de la bandeja pasan a una sola colección, con su equipo
 *   (el del Team Leader que participó o, si no, el del proyecto). Las colecciones viejas se borran
 *   después de copiar.
 * - Se borran Empresas, Partners, Productos, Casos de uso, Sources de leads y los clientes de la
 *   Fase 1, y los campos que apuntaban a ellos.
 */
export async function migrateToV4(store: AdminStore) {
  const existing = new Set((await store.db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const legacy of LEGACY_MEETINGS) {
    if (!existing.has(legacy.name)) continue;
    const docs = await store.db.collection<MeetingCore & Partial<MeetingDoc>>(legacy.name).find({}).toArray();
    for (const doc of docs) {
      const record = {
        ...doc,
        projectId: legacy.owner === "projectId" ? (doc.projectId ?? null) : null,
        leadId: legacy.owner === "leadId" ? (doc.leadId ?? null) : null,
        teamId: doc.teamId ?? null
      } as MeetingDoc;
      await store.meetings.updateOne({ _id: doc._id }, { $setOnInsert: record }, { upsert: true });
    }
    await store.db.collection(legacy.name).drop();
  }
  // Antes de borrar Empresas, cada contacto se queda con el nombre de la suya (texto).
  if (existing.has("core_companies")) {
    const companies = await store.db.collection<{ _id: string; name: string }>("core_companies").find({}, { projection: { name: 1 } }).toArray();
    for (const company of companies) {
      await store.contacts.updateMany({ companyId: company._id, company: { $exists: false } } as never, { $set: { company: company.name } });
    }
  }
  for (const name of REMOVED_COLLECTIONS) if (existing.has(name)) await store.db.collection(name).drop();

  await store.opsProjects.updateMany({ $or: [{ companyId: { $exists: true } }, { customerId: { $exists: true } }] }, { $unset: { companyId: "", customerId: "" } });
  await store.leads.updateMany({ $or: [{ companyId: { $exists: true } }, { customerId: { $exists: true } }, { sourceId: { $exists: true } }] }, { $unset: { companyId: "", customerId: "", sourceId: "" } });
  await store.contacts.updateMany({ companyId: { $exists: true } }, { $unset: { companyId: "" } });
  await store.deals.updateMany({ $or: [{ partnerId: { $exists: true } }, { partnerCommissionPct: { $exists: true } }] }, { $unset: { partnerId: "", partnerCommissionPct: "" } });
  await store.proposals.updateMany({ useCaseIds: { $exists: true } }, { $unset: { useCaseIds: "" } });
  await store.proposals.updateMany({ "lines.productId": { $exists: true } }, { $unset: { "lines.$[].productId": "" } });

  // Equipo de las reuniones que aún no lo tienen.
  const teamless = await store.meetings.find({ teamId: null }, { projection: { participants: 1, projectId: 1 } }).toArray();
  for (const meeting of teamless) {
    const fromProject = meeting.projectId ? (await store.opsProjects.findOne({ _id: meeting.projectId }, { projection: { teamId: 1 } }))?.teamId : null;
    const teamId = (await teamFromParticipants(store, meeting.participants ?? [])) ?? fromProject ?? null;
    if (teamId) await store.meetings.updateOne({ _id: meeting._id, teamId: null }, { $set: { teamId } });
  }
}
