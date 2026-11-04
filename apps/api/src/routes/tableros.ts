import type { FastifyInstance } from "fastify";
import { requireRole } from "../auth/session.js";
import type { AdminStore } from "../store/admin-store.js";
import { SALES_READ_ROLES } from "./sales.js";

/**
 * Datos del Dashboard Comercial: conteos de leads por estado, temperatura y fuente, más reuniones y
 * propuestas. Lo leen quienes ya leen Leads (boss, commercial, finance). No incluye el pipeline de
 * deals: queda pendiente de decisión.
 * (El Dashboard Financiero usa /api/invoices y el Operativo, Tasks y Proyectos.)
 */
export async function registerTableroRoutes(app: FastifyInstance, { store }: { store: AdminStore }) {
  app.get("/api/tableros/comercial", { preHandler: requireRole(...SALES_READ_ROLES) }, async () => {
    const count = (field: string) => store.leads.aggregate<{ _id: string | null; n: number }>([{ $group: { _id: `$${field}`, n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray();
    const [byStatus, byTemperature, byFunnel, bySource, leads, meetings, proposals] = await Promise.all([
      count("status"),
      count("temperature"),
      count("funnel"),
      count("sourceName"),
      store.leads.countDocuments({}),
      store.meetings.countDocuments({}),
      store.proposals.countDocuments({ area: "commercial" })
    ]);
    const map = (rows: { _id: string | null; n: number }[]) => rows.map((r) => ({ key: r._id ?? null, count: r.n }));
    return { leads, meetings, proposals, byStatus: map(byStatus), byTemperature: map(byTemperature), byFunnel: map(byFunnel), bySource: map(bySource) };
  });
}
