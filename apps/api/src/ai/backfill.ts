import type { AdminStore } from "../store/admin-store.js";
import type { AiSessionDoc } from "../store/models.js";
import type { AiAgentAdapter } from "./types.js";

export interface BackfillResult {
  scanned: number;
  /** Sesiones con algún campo nuevo o un costo mayor. */
  updated: number;
  /** Sesiones cuyo costo no se pudo leer de Anthropic (se reintentan en otra ejecución). */
  costErrors: number;
}

/**
 * Rellena el costo (precio de lista) de las sesiones del AI Developer anteriores a su registro,
 * leyéndolo de Anthropic (getSession), y el equipo y la persona que la abrió.
 *
 * Idempotente: el costo se guarda con $max y equipo/persona solo si faltan, así que repetirlo no
 * duplica ni pisa nada. El equipo es el que tiene hoy el proyecto (no se sabe el de entonces).
 */
export async function backfillAiCosts(
  { store, agent, now = () => new Date() }: { store: AdminStore; agent: Pick<AiAgentAdapter, "getSession">; now?: () => Date },
  onProgress?: (session: AiSessionDoc, error?: unknown) => void
): Promise<BackfillResult> {
  const result: BackfillResult = { scanned: 0, updated: 0, costErrors: 0 };
  const teamOf = new Map<string, string | null>();
  const userOf = new Map<string, string | null>();

  for await (const session of store.aiSessions.find({}, { projection: { preview: 0 } })) {
    result.scanned += 1;
    const set: Partial<AiSessionDoc> = {};

    if (session.teamId === undefined) {
      if (!teamOf.has(session.clientId)) teamOf.set(session.clientId, (await store.getClient(session.clientId))?.teamId ?? null);
      set.teamId = teamOf.get(session.clientId)!;
    }
    if (session.startedByUserId === undefined) {
      if (!userOf.has(session.createdBy)) userOf.set(session.createdBy, (await store.users.findOne({ username: session.createdBy.toLowerCase() }))?._id ?? null);
      set.startedByUserId = userOf.get(session.createdBy)!;
    }

    let cost: { costCents: number; budgetCents: number | null } | null = null;
    try {
      cost = await agent.getSession(session.agentSessionId);
    } catch (error) {
      result.costErrors += 1;
      onProgress?.(session, error);
    }
    const higher = cost && Number.isFinite(cost.costCents) && Math.round(cost.costCents) > (session.costCents ?? -1);
    if (higher) {
      set.lastCostAt = now();
      if (cost!.budgetCents !== null) set.budgetCents = cost!.budgetCents;
    }

    if (!higher && !Object.keys(set).length) continue;
    await store.aiSessions.updateOne(
      { _id: session._id },
      { ...(Object.keys(set).length ? { $set: set } : {}), ...(higher ? { $max: { costCents: Math.round(cost!.costCents) } } : {}) }
    );
    result.updated += 1;
  }
  return result;
}
