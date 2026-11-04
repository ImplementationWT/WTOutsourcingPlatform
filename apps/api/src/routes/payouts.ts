import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireModule } from "../auth/modules.js";
import { requireBoss } from "../auth/session.js";
import { UserDirectoryError, type UserDirectory } from "../auth/users.js";
import { hoursByOwnerInMonth } from "../ops/hours.js";
import { SENIORITIES } from "../store/models.js";
import type { AdminStore } from "../store/admin-store.js";

/** Pago mensual de una persona: básico + comisiones = total. La comisión se captura a mano (D10). */
export interface PayoutDoc {
  _id: string;
  userId: string;
  month: string; // AAAA-MM
  basicCents: number;
  commissionCents: number;
  status: "pending" | "paid";
  paidDate: string | null;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Usa el formato AAAA-MM.");
const cents = z.number().int().min(0).max(1_000_000_000);
const shiftMonth = (m: string, n: number) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7);
};

/**
 * Pagos / Comisiones (Financiera: boss y finance). Las personas son los Team Leaders y developers
 * reales; su rol, seniority y team se editan aquí (solo boss, D4) y se guardan en el usuario.
 */
export async function registerPayoutRoutes(app: FastifyInstance, { store, users }: { store: AdminStore; users: UserDirectory }) {
  const payouts = store.db.collection<PayoutDoc>("fin_payouts");
  const guard = { preHandler: requireModule("payouts") };

  app.get("/api/payouts", guard, async (request, reply) => {
    const q = z.object({ month: month.optional() }).safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: "Mes inválido." });
    const m = q.data.month ?? new Date().toISOString().slice(0, 7);
    const [people, teams, rows, tasks] = await Promise.all([
      store.users.find({ active: true, role: { $in: ["lead", "developer"] } }, { projection: { name: 1, role: 1, seniority: 1, teamId: 1 } }).sort({ role: 1, name: 1 }).toArray(),
      store.teams.find({}, { projection: { name: 1, leadUserId: 1 } }).sort({ name: 1 }).toArray(),
      payouts.find({ month: m }).toArray(),
      store.opsTasks.find({ deletedAt: null }).toArray()
    ]);
    const byUser = new Map(rows.map((r) => [r.userId, r]));
    const hours = hoursByOwnerInMonth(tasks, m);
    const teamName = new Map(teams.map((t) => [t._id, t.name]));
    return {
      month: m,
      teams: teams.map((t) => ({ id: t._id, name: t.name })),
      canEditPeople: request.user!.role === "boss",
      rows: people.map((u) => {
        const r = byUser.get(u._id);
        const basicCents = r?.basicCents ?? 0;
        const commissionCents = r?.commissionCents ?? 0;
        return {
          user: { id: u._id, name: u.name, role: u.role, seniority: u.seniority ?? null, team: u.teamId ? { id: u.teamId, name: teamName.get(u.teamId) ?? null } : null },
          basicCents,
          commissionCents,
          totalCents: basicCents + commissionCents,
          status: r?.status ?? "pending",
          paidDate: r?.paidDate ?? null,
          hours: hours.get(u._id) ?? { invested: 0, billable: 0 }
        };
      })
    };
  });

  /** Guarda básico, comisión o estado de una persona en un mes (crea el registro si no existe). */
  app.put("/api/payouts/:userId/:month", guard, async (request, reply) => {
    const params = z.object({ userId: z.string().uuid(), month }).safeParse(request.params);
    const body = z
      .object({ basicCents: cents, commissionCents: cents, status: z.enum(["pending", "paid"]) })
      .partial()
      .strict()
      .refine((p) => Object.keys(p).length > 0)
      .safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Datos inválidos." });
    const person = await store.users.findOne({ _id: params.data.userId, role: { $in: ["lead", "developer"] } });
    if (!person) return reply.code(404).send({ error: "Persona no encontrada." });
    const user = request.user!;
    const at = new Date();
    const patch = body.data;
    const paidDate = patch.status === "paid" ? at.toISOString().slice(0, 10) : patch.status === "pending" ? null : undefined;
    await payouts.updateOne(
      { userId: person._id, month: params.data.month },
      {
        $set: { ...patch, ...(paidDate !== undefined ? { paidDate } : {}), updatedBy: user.username, updatedAt: at },
        $setOnInsert: { _id: randomUUID(), createdAt: at, ...(patch.basicCents === undefined ? { basicCents: 0 } : {}), ...(patch.commissionCents === undefined ? { commissionCents: 0 } : {}), ...(patch.status === undefined ? { status: "pending", paidDate: null } : {}) }
      },
      { upsert: true }
    );
    await store.audit({ actor: user.username, action: "finance.payout_updated", clientId: "finance", target: `${person.username} ${params.data.month}`, details: Object.fromEntries(Object.keys(patch).map((k) => [k, true])) });
    return { ok: true };
  });

  /** Copia los básicos del mes anterior a quienes aún no tienen básico en este mes. */
  app.post("/api/payouts/copy-basics", guard, async (request, reply) => {
    const body = z.object({ month }).strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Mes inválido." });
    const prev = await payouts.find({ month: shiftMonth(body.data.month, -1), basicCents: { $gt: 0 } }).toArray();
    const at = new Date();
    let copied = 0;
    for (const p of prev) {
      const current = await payouts.findOne({ userId: p.userId, month: body.data.month });
      if (current?.basicCents) continue;
      await payouts.updateOne(
        { userId: p.userId, month: body.data.month },
        { $set: { basicCents: p.basicCents, updatedBy: request.user!.username, updatedAt: at }, $setOnInsert: { _id: randomUUID(), commissionCents: 0, status: "pending", paidDate: null, createdAt: at } },
        { upsert: true }
      );
      copied += 1;
    }
    return { copied, from: shiftMonth(body.data.month, -1) };
  });

  /**
   * Rol, seniority y team de una persona (solo boss): se guardan en el usuario. Si un Team Leader
   * cambia de team (o deja de serlo) se actualiza `teams.leadUserId` de los dos equipos.
   */
  app.patch("/api/payouts/people/:userId", { preHandler: requireBoss }, async (request, reply) => {
    const params = z.object({ userId: z.string().uuid() }).safeParse(request.params);
    const body = z
      .object({ role: z.enum(["lead", "developer"]), seniority: z.enum(SENIORITIES).nullable(), teamId: z.string().uuid() })
      .partial()
      .strict()
      .refine((p) => Object.keys(p).length > 0)
      .safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Datos inválidos." });
    const before = await store.users.findOne({ _id: params.data.userId, role: { $in: ["lead", "developer"] } });
    if (!before) return reply.code(404).send({ error: "Persona no encontrada." });
    try {
      const updated = await users.updateUser(before._id, body.data, request.user!);
      let replaced: string | null = null;
      const wasLead = before.role === "lead";
      const isLead = updated.role === "lead";
      // Deja de liderar su equipo anterior.
      if (wasLead && (!isLead || updated.teamId !== before.teamId) && before.teamId) {
        await store.teams.updateOne({ _id: before.teamId, leadUserId: before._id }, { $set: { leadUserId: null, updatedAt: new Date() } });
      }
      // Pasa a liderar el equipo nuevo (si había otro Team Leader, se informa).
      if (isLead && updated.teamId && (!wasLead || updated.teamId !== before.teamId)) {
        const team = await store.teams.findOne({ _id: updated.teamId });
        if (team?.leadUserId && team.leadUserId !== before._id) replaced = (await store.users.findOne({ _id: team.leadUserId }, { projection: { name: 1 } }))?.name ?? null;
        await store.teams.updateOne({ _id: updated.teamId }, { $set: { leadUserId: before._id, updatedAt: new Date() } });
      }
      return { user: updated, replacedLead: replaced };
    } catch (error) {
      if (error instanceof UserDirectoryError) return reply.code(error.status).send({ error: error.message });
      throw error;
    }
  });
}
