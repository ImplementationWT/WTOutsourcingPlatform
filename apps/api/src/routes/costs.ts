import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { type CostFilter, CostReport } from "../ai/costs.js";
import { teamFilterOf } from "../auth/access.js";
import { requireAuth } from "../auth/session.js";
import type { AdminStore } from "../store/admin-store.js";

// Fechas AAAA-MM-DD (UTC). `to` incluye ese día.
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const querySchema = z.object({ from: day.optional(), to: day.optional(), teamId: z.string().optional() });

function filterOf(request: FastifyRequest, reply: FastifyReply): CostFilter | null {
  const query = querySchema.safeParse(request.query ?? {});
  const from = query.success && query.data.from ? new Date(`${query.data.from}T00:00:00Z`) : null;
  const to = query.success && query.data.to ? new Date(Date.parse(`${query.data.to}T00:00:00Z`) + 86_400_000) : null;
  if (!query.success || (from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime())) || (from && to && from >= to)) {
    void reply.code(400).send({ error: "Rango de fechas inválido (usa AAAA-MM-DD)." });
    return null;
  }
  return { from, to, teamId: teamFilterOf(request) };
}

/**
 * Costos del AI Developer (precio de lista de Anthropic, en USD). Cada rol ve su alcance: jefe
 * todo, team leader su equipo, developer sus sesiones.
 */
export async function registerCostRoutes(app: FastifyInstance, { store }: { store: AdminStore }) {
  const report = new CostReport(store);

  app.get("/api/costs/summary", { preHandler: requireAuth }, async (request, reply) => {
    const filter = filterOf(request, reply);
    if (!filter) return reply;
    return { scope: request.user!.role, ...(await report.summary(request.user!, filter)) };
  });

  app.get("/api/costs/sessions", { preHandler: requireAuth }, async (request, reply) => {
    const filter = filterOf(request, reply);
    if (!filter) return reply;
    return { sessions: (await report.sessionRows(request.user!, filter)).slice(0, 500) };
  });

  app.get("/api/costs/export.csv", { preHandler: requireAuth }, async (request, reply) => {
    const filter = filterOf(request, reply);
    if (!filter) return reply;
    const csv = await report.csv(request.user!, filter);
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="costos-ai-${new Date().toISOString().slice(0, 10)}.csv"`)
      .header("cache-control", "no-store")
      .send(`\uFEFF${csv}`);
  });
}
