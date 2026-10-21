import type { Filter } from "mongodb";
import type { SessionUser } from "../auth/users.js";
import type { AdminStore } from "../store/admin-store.js";
import type { AiSessionDoc } from "../store/models.js";

/**
 * Costos del AI Developer: solo el gasto del agente (Claude), en centavos de USD.
 *
 * OJO: es el PRECIO DE LISTA que informa Anthropic en cada sesión (session.usage.list_cost), no
 * la factura real. Descuentos, créditos o impuestos no se reflejan; para conciliar con la factura
 * ver docs/ai-developer.md. Los meses se cuentan en UTC por la fecha de inicio de la sesión.
 */

export interface CostFilter {
  from?: Date | null;
  /** Exclusivo. */
  to?: Date | null;
  /** Jefes: acotar a un equipo. */
  teamId?: string | null;
}

interface Bucket {
  costCents: number;
  sessions: number;
  mergedPrs: number;
}

const emptyBucket = (): Bucket => ({ costCents: 0, sessions: 0, mergedPrs: 0 });
const add = (bucket: Bucket, session: AiSessionDoc) => {
  bucket.costCents += session.costCents ?? 0;
  bucket.sessions += 1;
  if (session.status === "merged") bucket.mergedPrs += 1;
};
/** Costo medio por PR fusionado (null si no hay ninguno). */
const perMerged = (bucket: Bucket) => (bucket.mergedPrs ? Math.round(bucket.costCents / bucket.mergedPrs) : null);
const withRatio = <T extends Bucket>(bucket: T) => ({ ...bucket, costPerMergedPrCents: perMerged(bucket) });
const byCost = (a: Bucket, b: Bucket) => b.costCents - a.costCents;

/** Alcance por rol: el jefe ve todo, el team leader su equipo, el developer sus sesiones. */
export function costScope(user: SessionUser, filter: CostFilter = {}): Filter<AiSessionDoc> {
  const query: Filter<AiSessionDoc> = {};
  if (user.role === "boss") {
    if (filter.teamId) query.teamId = filter.teamId;
  } else if (user.role === "lead") {
    query.teamId = user.teamId ?? "__sin_equipo__";
  } else {
    query.startedByUserId = user.id;
  }
  if (filter.from || filter.to) {
    query.createdAt = { ...(filter.from ? { $gte: filter.from } : {}), ...(filter.to ? { $lt: filter.to } : {}) };
  }
  return query;
}

const monthOf = (date: Date) => date.toISOString().slice(0, 7);

export class CostReport {
  constructor(private readonly store: AdminStore) {}

  private sessions(user: SessionUser, filter: CostFilter) {
    // Las borradas del panel (deletedAt) también cuentan: el gasto ya se hizo.
    return this.store.aiSessions.find(costScope(user, filter), { projection: { preview: 0 } }).sort({ createdAt: -1 }).toArray();
  }

  private async names(sessions: AiSessionDoc[]) {
    const userIds = [...new Set(sessions.map((s) => s.startedByUserId).filter((id): id is string => Boolean(id)))];
    const teamIds = [...new Set(sessions.map((s) => s.teamId).filter((id): id is string => Boolean(id)))];
    const clientIds = [...new Set(sessions.map((s) => s.clientId))];
    const [users, teams, clients] = await Promise.all([
      this.store.users.find({ _id: { $in: userIds } }, { projection: { name: 1, username: 1 } }).toArray(),
      this.store.teams.find({ _id: { $in: teamIds } }, { projection: { name: 1 } }).toArray(),
      this.store.clients.find({ _id: { $in: clientIds } }, { projection: { name: 1 } }).toArray()
    ]);
    return {
      user: new Map(users.map((u) => [u._id, { name: u.name, username: u.username }])),
      team: new Map(teams.map((t) => [t._id, t.name])),
      client: new Map(clients.map((c) => [c._id, c.name]))
    };
  }

  /** Totales, tendencia mensual y desglose por equipo, proyecto y persona. */
  async summary(user: SessionUser, filter: CostFilter = {}) {
    const sessions = await this.sessions(user, filter);
    const names = await this.names(sessions);
    const total = emptyBucket();
    const months = new Map<string, Bucket>();
    const teams = new Map<string, Bucket>();
    const projects = new Map<string, Bucket & { teamId: string | null }>();
    const people = new Map<string, Bucket & { userId: string | null; username: string }>();

    for (const session of sessions) {
      add(total, session);
      const month = monthOf(session.createdAt);
      if (!months.has(month)) months.set(month, emptyBucket());
      add(months.get(month)!, session);

      const teamKey = session.teamId ?? "";
      if (!teams.has(teamKey)) teams.set(teamKey, emptyBucket());
      add(teams.get(teamKey)!, session);

      if (!projects.has(session.clientId)) projects.set(session.clientId, { ...emptyBucket(), teamId: session.teamId ?? null });
      add(projects.get(session.clientId)!, session);

      // Sesiones anteriores a los usuarios: se agrupan por el nombre de usuario que las abrió.
      const personKey = session.startedByUserId ?? `@${session.createdBy}`;
      if (!people.has(personKey)) people.set(personKey, { ...emptyBucket(), userId: session.startedByUserId ?? null, username: session.createdBy });
      add(people.get(personKey)!, session);
    }

    return {
      currency: "USD",
      listPrice: true,
      totals: withRatio(total),
      byMonth: [...months].sort(([a], [b]) => a.localeCompare(b)).map(([month, bucket]) => ({ month, ...withRatio(bucket) })),
      byTeam: [...teams]
        .map(([teamId, bucket]) => ({ teamId: teamId || null, name: teamId ? (names.team.get(teamId) ?? "Equipo eliminado") : "Sin equipo", ...withRatio(bucket) }))
        .sort(byCost),
      byProject: [...projects]
        .map(([clientId, bucket]) => ({
          clientId,
          name: names.client.get(clientId) ?? clientId,
          teamName: bucket.teamId ? (names.team.get(bucket.teamId) ?? null) : null,
          ...withRatio(bucket)
        }))
        .sort(byCost),
      byPerson: [...people]
        .map(([, bucket]) => {
          const known = bucket.userId ? names.user.get(bucket.userId) : undefined;
          return { ...withRatio(bucket), name: known?.name ?? bucket.username, username: known?.username ?? bucket.username };
        })
        .sort(byCost)
    };
  }

  /** Sesiones con su costo (lista y CSV). */
  async sessionRows(user: SessionUser, filter: CostFilter = {}) {
    const sessions = await this.sessions(user, filter);
    const names = await this.names(sessions);
    return sessions.map((s) => {
      const person = s.startedByUserId ? names.user.get(s.startedByUserId) : undefined;
      return {
        id: s._id,
        createdAt: s.createdAt,
        month: monthOf(s.createdAt),
        clientId: s.clientId,
        project: names.client.get(s.clientId) ?? s.clientId,
        teamId: s.teamId ?? null,
        team: s.teamId ? (names.team.get(s.teamId) ?? "Equipo eliminado") : "Sin equipo",
        username: person?.username ?? s.createdBy,
        person: person?.name ?? s.createdBy,
        title: s.title,
        status: s.status,
        merged: s.status === "merged",
        pullRequest: s.pullRequest?.number ?? null,
        costCents: s.costCents ?? 0,
        budgetCents: s.budgetCents ?? null,
        deleted: Boolean(s.deletedAt)
      };
    });
  }

  async csv(user: SessionUser, filter: CostFilter = {}) {
    const rows = await this.sessionRows(user, filter);
    const header = ["fecha", "mes", "proyecto", "equipo", "persona", "usuario", "sesion", "titulo", "estado", "pr", "costo_usd"];
    const lines = rows.map((r) =>
      [r.createdAt.toISOString(), r.month, r.clientId, r.team, r.person, r.username, r.id, r.title, r.status, r.pullRequest ?? "", (r.costCents / 100).toFixed(2)]
        .map(csvCell)
        .join(",")
    );
    return [header.join(","), ...lines].join("\r\n") + "\r\n";
  }
}

/** Celda CSV: comillas si hace falta y sin fórmulas (evita inyección al abrirlo en Excel). */
export function csvCell(value: string | number) {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
