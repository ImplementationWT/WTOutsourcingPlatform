import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { canSeeClient } from "../auth/access.js";
import { requireAuth } from "../auth/session.js";
import type { SessionUser } from "../auth/users.js";
import { open, seal } from "../lib/server-cipher.js";
import { registerSecret } from "../lib/redact.js";
import { canManageProject, canWorkOnProject, forbidden, projectScope, readableProject } from "../ops/access.js";
import {
  ACCOUNT_KINDS,
  DEAL_STATUSES,
  type DealDoc,
  dealAmountCents,
  HEALTH_SCORES,
  type OpsProjectDoc,
  type OpsTaskDoc,
  PRIORITIES,
  PROJECT_STAGES,
  TASK_STATUSES,
  type VaultAccountDoc
} from "../ops/models.js";
import type { MeetingProcessing } from "../meetings/processing.js";
import { registerMeetingRoutes } from "../meetings/routes.js";
import type { ProposalDoc } from "../sales/models.js";
import { createProposalSchema, PROPOSAL_LABELS, proposalView, statusDates, updateProposalSchema } from "../sales/proposals.js";
import type { AdminStore } from "../store/admin-store.js";
import type { UserDoc } from "../store/models.js";

const idParams = z.object({ id: z.string().uuid() });
const idsParams = z.object({ id: z.string().uuid(), childId: z.string().uuid() });

const text = (max: number) => z.string().trim().max(max);
const optionalUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => /^https?:\/\//i.test(v), "Debe empezar por http:// o https://")
  .nullable();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Usa el formato AAAA-MM-DD.");
const userId = z.string().uuid().nullable();

const createProjectSchema = z
  .object({
    name: text(80).min(3),
    customerName: text(80).min(2),
    teamId: z.string().uuid().optional(),
    leadUserId: userId.optional(),
    developerUserId: userId.optional(),
    clientSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/).nullable().optional(),
    proposalUrl: optionalUrl.optional(),
    stage: z.enum(PROJECT_STAGES).optional(),
    health: z.enum(HEALTH_SCORES).optional(),
    sentimentScore: z.number().int().min(0).max(100).optional(),
    priority: z.enum(PRIORITIES).optional()
  })
  .strict();

const updateProjectSchema = z
  .object({
    name: text(80).min(3),
    customerName: text(80).min(2),
    leadUserId: userId,
    developerUserId: userId,
    clientSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/).nullable(),
    proposalUrl: optionalUrl,
    stage: z.enum(PROJECT_STAGES),
    health: z.enum(HEALTH_SCORES),
    sentimentScore: z.number().int().min(0).max(100),
    priority: z.enum(PRIORITIES)
  })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "No hay nada que cambiar.");

const dealFields = {
  title: text(120).min(3),
  description: text(2000),
  hours: z.number().positive().max(100_000),
  rateCents: z.number().int().min(0).max(100_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/),
  status: z.enum(DEAL_STATUSES),
  proposalUrl: optionalUrl
};
const createDealSchema = z
  .object({ title: dealFields.title, description: dealFields.description.optional(), hours: dealFields.hours, rateCents: dealFields.rateCents, currency: dealFields.currency.optional(), status: dealFields.status.optional(), proposalUrl: dealFields.proposalUrl.optional() })
  .strict();
const updateDealSchema = z
  .object(dealFields)
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "No hay nada que cambiar.");

const taskFields = {
  title: text(160).min(3),
  dealId: z.string().uuid().nullable(),
  assigneeUserId: userId,
  estimatedHours: z.number().min(0).max(10_000),
  status: z.enum(TASK_STATUSES),
  dueDate: isoDate.nullable()
};
const createTaskSchema = z
  .object({ title: taskFields.title, dealId: taskFields.dealId.optional(), assigneeUserId: taskFields.assigneeUserId.optional(), estimatedHours: taskFields.estimatedHours.optional(), status: taskFields.status.optional(), dueDate: taskFields.dueDate.optional() })
  .strict();
const updateTaskSchema = z
  .object(taskFields)
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "No hay nada que cambiar.");

const accountFields = {
  label: text(80).min(2),
  kind: z.enum(ACCOUNT_KINDS),
  url: optionalUrl,
  username: text(160).nullable(),
  notes: text(1000),
  secret: z.string().min(1).max(4000)
};
const createAccountSchema = z
  .object({ label: accountFields.label, kind: accountFields.kind, url: accountFields.url.optional(), username: accountFields.username.optional(), notes: accountFields.notes.optional(), secret: accountFields.secret.optional() })
  .strict();
const updateAccountSchema = z
  .object(accountFields)
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "No hay nada que cambiar.");

const updateNoteSchema = z.object({ body: text(4000).min(1) }).strict();

const listQuery = z.object({
  stage: z.enum(PROJECT_STAGES).optional(),
  health: z.enum(HEALTH_SCORES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  teamId: z.string().uuid().optional()
});

const LABELS = {
  stage: { kickoff: "Kick Off", structure: "Estructura", automation_layer: "Automation Layer", stabilization: "Estabilización", maintenance: "Maintenance", no_pending_items: "No Pending Items", completed: "Completed" },
  health: { champion: "Champion", very_happy: "Very Happy", happy: "Happy", mixed: "Mixed", neutral: "Neutral", concerned: "Concerned", escalated: "Escalated", at_risk: "At Risk" },
  priority: { critical: "Critical", high: "High", medium: "Medium", low: "Low" }
} as const;

const invalid = (reply: FastifyReply, error: z.ZodError) =>
  reply.code(400).send({ error: "Datos inválidos.", issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });

/** Operativa: proyectos del cliente, deals, tareas, cuentas (vault), novedades y reuniones. */
export async function registerOpsRoutes(app: FastifyInstance, { store, vaultKey, meetings }: { store: AdminStore; vaultKey?: Buffer; meetings: MeetingProcessing }) {
  const auditOps = (user: SessionUser, project: Pick<OpsProjectDoc, "_id" | "name">, action: string, details?: Record<string, string | number | boolean>) =>
    store.audit({ actor: user.username, action, clientId: `ops:${project._id}`, target: project.name, ...(details ? { details } : {}) });

  const note = (user: SessionUser, projectId: string, body: string) =>
    store.projectUpdates.insertOne({ _id: randomUUID(), projectId, kind: "system", body, authorUsername: user.username, authorName: user.name, createdAt: new Date() });

  /** Usuario activo de ese equipo con uno de esos roles (para asignar responsables). */
  async function teamMember(id: string | null | undefined, teamId: string, roles: UserDoc["role"][]) {
    if (!id) return true;
    const user = await store.users.findOne({ _id: id, active: true, teamId });
    return Boolean(user && roles.includes(user.role));
  }

  async function people(projects: OpsProjectDoc[]) {
    const ids = [...new Set(projects.flatMap((p) => [p.leadUserId, p.developerUserId]).filter((v): v is string => Boolean(v)))];
    const teamIds = [...new Set(projects.map((p) => p.teamId))];
    const [users, teams] = await Promise.all([
      ids.length ? store.users.find({ _id: { $in: ids } }, { projection: { name: 1 } }).toArray() : [],
      teamIds.length ? store.teams.find({ _id: { $in: teamIds } }, { projection: { name: 1 } }).toArray() : []
    ]);
    const userName = new Map(users.map((u) => [u._id, u.name]));
    const teamName = new Map(teams.map((t) => [t._id, t.name]));
    return (project: OpsProjectDoc) => ({
      id: project._id,
      name: project.name,
      customerName: project.customerName,
      team: { id: project.teamId, name: teamName.get(project.teamId) ?? null },
      lead: project.leadUserId ? { id: project.leadUserId, name: userName.get(project.leadUserId) ?? null } : null,
      developer: project.developerUserId ? { id: project.developerUserId, name: userName.get(project.developerUserId) ?? null } : null,
      clientSlug: project.clientSlug,
      proposalUrl: project.proposalUrl,
      customerId: project.customerId ?? null,
      leadId: project.leadId ?? null,
      stage: project.stage,
      health: project.health,
      sentimentScore: project.sentimentScore,
      priority: project.priority,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt
    });
  }

  const dealView = (deal: DealDoc) => ({
    id: deal._id,
    projectId: deal.projectId,
    title: deal.title,
    description: deal.description,
    hours: deal.hours,
    rateCents: deal.rateCents,
    amountCents: deal.amountCents,
    currency: deal.currency,
    status: deal.status,
    proposalUrl: deal.proposalUrl,
    paidAt: deal.paidAt ?? null,
    createdAt: deal.createdAt,
    updatedAt: deal.updatedAt
  });

  const taskView = (task: OpsTaskDoc) => ({
    id: task._id,
    projectId: task.projectId,
    dealId: task.dealId,
    title: task.title,
    assigneeUserId: task.assigneeUserId,
    estimatedHours: task.estimatedHours,
    status: task.status,
    dueDate: task.dueDate,
    completedAt: task.completedAt ?? null,
    updatedAt: task.updatedAt
  });

  /** Sin el valor: solo si hay uno guardado. */
  const accountView = (account: VaultAccountDoc) => ({
    id: account._id,
    projectId: account.projectId,
    label: account.label,
    kind: account.kind,
    url: account.url,
    username: account.username,
    notes: account.notes,
    credentialSet: account.sealed !== null,
    rotatedAt: account.rotatedAt,
    updatedAt: account.updatedAt
  });

  /** Miembros activos (team leaders y developers) de un equipo, para asignar responsables y tareas. */
  app.get("/api/ops/members", { preHandler: requireAuth }, async (request, reply) => {
    const query = z.object({ teamId: z.string().uuid().optional() }).safeParse(request.query);
    if (!query.success) return invalid(reply, query.error);
    const user = request.user!;
    if (user.role === "finance") return { members: [] };
    // El CEO/CCO y Comercial (al convertir un lead) eligen el equipo; el resto ve el suyo.
    const teamId = user.role === "boss" || user.role === "commercial" ? (query.data.teamId ?? null) : user.teamId;
    if (!teamId) return { members: [] };
    const members = await store.users.find({ teamId, active: true, role: { $in: ["lead", "developer"] } }, { projection: { name: 1, role: 1 } }).sort({ role: 1, name: 1 }).toArray();
    return { members: members.map((m) => ({ id: m._id, name: m.name, role: m.role })) };
  });

  // ---- proyectos --------------------------------------------------------------

  app.get("/api/ops/projects", { preHandler: requireAuth }, async (request, reply) => {
    const query = listQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, query.error);
    const user = request.user!;
    const filter = {
      ...projectScope(user, query.data.teamId),
      ...(query.data.stage ? { stage: query.data.stage } : {}),
      ...(query.data.health ? { health: query.data.health } : {}),
      ...(query.data.priority ? { priority: query.data.priority } : {})
    };
    const projects = await store.opsProjects.find(filter).sort({ updatedAt: -1 }).limit(500).toArray();
    const present = await people(projects);
    const ids = projects.map((p) => p._id);
    const [deals, tasks] = ids.length
      ? await Promise.all([store.deals.find({ projectId: { $in: ids }, status: { $ne: "cancelled" } }).toArray(), store.opsTasks.find({ projectId: { $in: ids } }, { projection: { projectId: 1, status: 1 } }).toArray()])
      : [[], []];
    return {
      projects: projects.map((p) => {
        const mine = deals.filter((d) => d.projectId === p._id);
        const myTasks = tasks.filter((t) => t.projectId === p._id);
        return {
          ...present(p),
          summary: {
            deals: mine.length,
            hours: mine.reduce((sum, d) => sum + d.hours, 0),
            amountCents: mine.reduce((sum, d) => sum + d.amountCents, 0),
            tasks: myTasks.length,
            tasksDone: myTasks.filter((t) => t.status === "done").length
          }
        };
      })
    };
  });

  app.post("/api/ops/projects", { preHandler: requireAuth }, async (request, reply) => {
    const body = createProjectSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const user = request.user!;
    if (user.role !== "boss" && user.role !== "lead") return forbidden(reply);
    const teamId = user.role === "boss" ? body.data.teamId : user.teamId;
    if (!teamId) return reply.code(400).send({ error: user.role === "boss" ? "Elige el equipo del proyecto." : "Tu usuario no tiene equipo." });
    if (!(await store.teams.findOne({ _id: teamId }))) return reply.code(400).send({ error: "El equipo no existe." });
    if (!(await teamMember(body.data.leadUserId, teamId, ["lead"]))) return reply.code(400).send({ error: "El Team Leader debe ser un team leader activo de ese equipo." });
    if (!(await teamMember(body.data.developerUserId, teamId, ["developer"]))) return reply.code(400).send({ error: "El Developer debe ser un developer activo de ese equipo." });
    if (body.data.clientSlug) {
      const client = await store.getClient(body.data.clientSlug);
      if (!client || !canSeeClient(user, client)) return reply.code(400).send({ error: "La app de Infraestructura no existe." });
      if (await store.opsProjects.findOne({ clientSlug: body.data.clientSlug })) return reply.code(409).send({ error: "Esa app ya está enlazada a otro proyecto." });
    }
    const at = new Date();
    const project: OpsProjectDoc = {
      _id: randomUUID(),
      name: body.data.name,
      customerName: body.data.customerName,
      teamId,
      leadUserId: body.data.leadUserId ?? (user.role === "lead" ? user.id : null),
      developerUserId: body.data.developerUserId ?? null,
      clientSlug: body.data.clientSlug ?? null,
      proposalUrl: body.data.proposalUrl ?? null,
      stage: body.data.stage ?? "kickoff",
      health: body.data.health ?? "neutral",
      sentimentScore: body.data.sentimentScore ?? 50,
      priority: body.data.priority ?? "medium",
      createdBy: user.username,
      createdAt: at,
      updatedAt: at
    };
    await store.opsProjects.insertOne(project);
    await auditOps(user, project, "ops.project_created");
    await note(user, project._id, "Proyecto creado.");
    const present = await people([project]);
    return reply.code(201).send({ project: present(project) });
  });

  app.get("/api/ops/projects/:id", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const project = await readableProject(store, request, reply, params.data.id);
    if (!project) return reply;
    const present = await people([project]);
    const user = request.user!;
    return { project: present(project), permissions: { manage: canManageProject(user, project), work: canWorkOnProject(user, project) } };
  });

  app.patch("/api/ops/projects/:id", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = updateProjectSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const project = await readableProject(store, request, reply, params.data.id);
    if (!project) return reply;
    const user = request.user!;
    if (!canManageProject(user, project)) return forbidden(reply);
    const patch = body.data;
    if (patch.leadUserId !== undefined && !(await teamMember(patch.leadUserId, project.teamId, ["lead"]))) return reply.code(400).send({ error: "El Team Leader debe ser un team leader activo del equipo del proyecto." });
    if (patch.developerUserId !== undefined && !(await teamMember(patch.developerUserId, project.teamId, ["developer"]))) return reply.code(400).send({ error: "El Developer debe ser un developer activo del equipo del proyecto." });
    if (patch.clientSlug) {
      const client = await store.getClient(patch.clientSlug);
      if (!client || !canSeeClient(user, client)) return reply.code(400).send({ error: "La app de Infraestructura no existe." });
      const taken = await store.opsProjects.findOne({ clientSlug: patch.clientSlug, _id: { $ne: project._id } });
      if (taken) return reply.code(409).send({ error: "Esa app ya está enlazada a otro proyecto." });
    }

    const changes: string[] = [];
    if (patch.stage && patch.stage !== project.stage) changes.push(`Etapa: ${LABELS.stage[project.stage]} → ${LABELS.stage[patch.stage]}`);
    if (patch.health && patch.health !== project.health) changes.push(`Health: ${LABELS.health[project.health]} → ${LABELS.health[patch.health]}`);
    if (patch.priority && patch.priority !== project.priority) changes.push(`Prioridad: ${LABELS.priority[project.priority]} → ${LABELS.priority[patch.priority]}`);
    if (patch.sentimentScore !== undefined && patch.sentimentScore !== project.sentimentScore) changes.push(`Sentiment: ${project.sentimentScore} → ${patch.sentimentScore}`);
    if (patch.leadUserId !== undefined && patch.leadUserId !== project.leadUserId) changes.push("Cambió el Team Leader.");
    if (patch.developerUserId !== undefined && patch.developerUserId !== project.developerUserId) changes.push("Cambió el Developer.");

    const updatedAt = new Date();
    await store.opsProjects.updateOne({ _id: project._id }, { $set: { ...patch, updatedAt } });
    if (changes.length) {
      await note(user, project._id, changes.join("\n"));
      await auditOps(user, project, "ops.project_updated", { changes: changes.length });
    }
    const fresh = (await store.opsProjects.findOne({ _id: project._id }))!;
    const present = await people([fresh]);
    return { project: present(fresh) };
  });

  // ---- deals ------------------------------------------------------------------

  app.get("/api/ops/projects/:id/deals", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const project = await readableProject(store, request, reply, params.data.id);
    if (!project) return reply;
    const deals = await store.deals.find({ projectId: project._id }).sort({ createdAt: -1 }).toArray();
    return { deals: deals.map(dealView) };
  });

  app.post("/api/ops/projects/:id/deals", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = createDealSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const project = await readableProject(store, request, reply, params.data.id);
    if (!project) return reply;
    const user = request.user!;
    if (!canManageProject(user, project)) return forbidden(reply);
    const at = new Date();
    const deal: DealDoc = {
      _id: randomUUID(),
      projectId: project._id,
      title: body.data.title,
      description: body.data.description ?? "",
      hours: body.data.hours,
      rateCents: body.data.rateCents,
      amountCents: dealAmountCents(body.data.hours, body.data.rateCents),
      currency: body.data.currency ?? "USD",
      status: body.data.status ?? "draft",
      proposalUrl: body.data.proposalUrl ?? null,
      createdBy: user.username,
      createdAt: at,
      updatedAt: at,
      ...(body.data.status === "paid" ? { paidAt: at } : {})
    };
    await store.deals.insertOne(deal);
    await auditOps(user, project, "ops.deal_created", { deal: deal.title, hours: deal.hours });
    return reply.code(201).send({ deal: dealView(deal) });
  });

  app.patch("/api/ops/projects/:id/deals/:childId", { preHandler: requireAuth }, async (request, reply) => {
    const params = idsParams.safeParse(request.params);
    const body = updateDealSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const project = await readableProject(store, request, reply, params.data.id);
    if (!project) return reply;
    const user = request.user!;
    if (!canManageProject(user, project)) return forbidden(reply);
    const deal = await store.deals.findOne({ _id: params.data.childId, projectId: project._id });
    if (!deal) return reply.code(404).send({ error: "Deal no encontrado." });
    const patch = body.data;
    // Una vez facturado o cobrado, el dinero ya no se toca: el cobro y las comisiones dependen de él.
    const locksMoney = deal.status === "invoiced" || deal.status === "paid";
    if (locksMoney && (patch.hours !== undefined || patch.rateCents !== undefined || patch.currency !== undefined)) {
      return reply.code(409).send({ error: "El deal ya está facturado o cobrado: no se pueden cambiar horas, tarifa ni moneda." });
    }
    const hours = patch.hours ?? deal.hours;
    const rateCents = patch.rateCents ?? deal.rateCents;
    const at = new Date();
    const set: Partial<DealDoc> = { ...patch, amountCents: dealAmountCents(hours, rateCents), updatedAt: at };
    const unset: Record<string, ""> = {};
    if (patch.status === "paid" && deal.status !== "paid") set.paidAt = at;
    if (patch.status && patch.status !== "paid" && deal.status === "paid") unset.paidAt = "";
    await store.deals.updateOne({ _id: deal._id }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
    if (patch.status && patch.status !== deal.status) {
      await note(user, project._id, `Deal "${deal.title}": ${deal.status} → ${patch.status}`);
      await auditOps(user, project, "ops.deal_status_changed", { deal: deal.title, from: deal.status, to: patch.status });
    } else {
      await auditOps(user, project, "ops.deal_updated", { deal: deal.title });
    }
    return { deal: dealView((await store.deals.findOne({ _id: deal._id }))!) };
  });

  // ---- tareas -----------------------------------------------------------------

  app.get("/api/ops/projects/:id/tasks", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const project = await readableProject(store, request, reply, params.data.id);
    if (!project) return reply;
    const tasks = await store.opsTasks.find({ projectId: project._id }).sort({ createdAt: -1 }).toArray();
    const ids = [...new Set(tasks.map((t) => t.assigneeUserId).filter((v): v is string => Boolean(v)))];
    const users = ids.length ? await store.users.find({ _id: { $in: ids } }, { projection: { name: 1 } }).toArray() : [];
    const names = new Map(users.map((u) => [u._id, u.name]));
    return { tasks: tasks.map((t) => ({ ...taskView(t), assigneeName: t.assigneeUserId ? (names.get(t.assigneeUserId) ?? null) : null })) };
  });

  async function checkTaskLinks(project: OpsProjectDoc, dealId: string | null | undefined, assigneeUserId: string | null | undefined, reply: FastifyReply) {
    if (dealId && !(await store.deals.findOne({ _id: dealId, projectId: project._id }))) {
      void reply.code(400).send({ error: "El deal no pertenece a este proyecto." });
      return false;
    }
    if (assigneeUserId && !(await teamMember(assigneeUserId, project.teamId, ["lead", "developer"]))) {
      void reply.code(400).send({ error: "La persona asignada debe ser del equipo del proyecto." });
      return false;
    }
    return true;
  }

  app.post("/api/ops/projects/:id/tasks", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = createTaskSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const project = await readableProject(store, request, reply, params.data.id);
    if (!project) return reply;
    const user = request.user!;
    // Crear y reasignar tareas es del Team Leader; el developer solo mueve el estado de las suyas.
    if (!canManageProject(user, project)) return forbidden(reply);
    if (!(await checkTaskLinks(project, body.data.dealId, body.data.assigneeUserId, reply))) return reply;
    const at = new Date();
    const status = body.data.status ?? "todo";
    const task: OpsTaskDoc = {
      _id: randomUUID(),
      projectId: project._id,
      dealId: body.data.dealId ?? null,
      title: body.data.title,
      assigneeUserId: body.data.assigneeUserId ?? null,
      estimatedHours: body.data.estimatedHours ?? 0,
      status,
      dueDate: body.data.dueDate ?? null,
      createdBy: user.username,
      createdAt: at,
      updatedAt: at,
      ...(status === "done" ? { completedAt: at } : {})
    };
    await store.opsTasks.insertOne(task);
    await auditOps(user, project, "ops.task_created", { task: task.title });
    return reply.code(201).send({ task: taskView(task) });
  });

  app.patch("/api/ops/projects/:id/tasks/:childId", { preHandler: requireAuth }, async (request, reply) => {
    const params = idsParams.safeParse(request.params);
    const body = updateTaskSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const project = await readableProject(store, request, reply, params.data.id);
    if (!project) return reply;
    const user = request.user!;
    if (!canWorkOnProject(user, project)) return forbidden(reply);
    const task = await store.opsTasks.findOne({ _id: params.data.childId, projectId: project._id });
    if (!task) return reply.code(404).send({ error: "Tarea no encontrada." });
    const patch = body.data;
    // Un developer solo mueve el estado de sus propias tareas; el resto lo gestiona el Team Leader.
    if (user.role === "developer" && (task.assigneeUserId !== user.id || Object.keys(patch).some((k) => k !== "status"))) return forbidden(reply);
    if (!(await checkTaskLinks(project, patch.dealId, patch.assigneeUserId, reply))) return reply;
    const at = new Date();
    const set: Partial<OpsTaskDoc> = { ...patch, updatedAt: at };
    const unset: Record<string, ""> = {};
    if (patch.status === "done" && task.status !== "done") set.completedAt = at;
    if (patch.status && patch.status !== "done" && task.status === "done") unset.completedAt = "";
    await store.opsTasks.updateOne({ _id: task._id }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
    if (patch.status && patch.status !== task.status) await auditOps(user, project, "ops.task_status_changed", { task: task.title, from: task.status, to: patch.status });
    return { task: taskView((await store.opsTasks.findOne({ _id: task._id }))!) };
  });

  // ---- cuentas (vault) ---------------------------------------------------------

  /** Las cuentas las ven el CEO/CCO y el equipo del proyecto; Comercial y Financiera no. */
  const vaultRoute = async (request: Parameters<typeof readableProject>[1], reply: FastifyReply, id: string, manage: boolean) => {
    if (!vaultKey) {
      void reply.code(503).send({ error: "El vault de cuentas no está disponible: falta ACCOUNT_VAULT_KEY_PATH en el servidor." });
      return null;
    }
    const project = await readableProject(store, request, reply, id);
    if (!project) return null;
    const allowed = manage ? canManageProject(request.user!, project) : canWorkOnProject(request.user!, project);
    if (!allowed) {
      void forbidden(reply);
      return null;
    }
    return project;
  };

  app.get("/api/ops/projects/:id/accounts", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const project = await vaultRoute(request, reply, params.data.id, false);
    if (!project) return reply;
    const accounts = await store.vaultAccounts.find({ projectId: project._id }).sort({ label: 1 }).toArray();
    return { accounts: accounts.map(accountView) };
  });

  app.post("/api/ops/projects/:id/accounts", { preHandler: requireAuth }, async (request, reply) => {
    registerSecret((request.body as { secret?: unknown } | null)?.secret as string | undefined);
    const params = idParams.safeParse(request.params);
    const body = createAccountSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const project = await vaultRoute(request, reply, params.data.id, true);
    if (!project) return reply;
    const at = new Date();
    const id = randomUUID();
    const account: VaultAccountDoc = {
      _id: id,
      projectId: project._id,
      label: body.data.label,
      kind: body.data.kind,
      url: body.data.url ?? null,
      username: body.data.username ?? null,
      notes: body.data.notes ?? "",
      sealed: body.data.secret ? seal(vaultKey!, body.data.secret, `vault:${project._id}:${id}`) : null,
      rotatedAt: body.data.secret ? at : null,
      createdBy: request.user!.username,
      createdAt: at,
      updatedAt: at
    };
    await store.vaultAccounts.insertOne(account);
    await auditOps(request.user!, project, "ops.account_created", { account: account.label });
    return reply.code(201).send({ account: accountView(account) });
  });

  app.patch("/api/ops/projects/:id/accounts/:childId", { preHandler: requireAuth }, async (request, reply) => {
    registerSecret((request.body as { secret?: unknown } | null)?.secret as string | undefined);
    const params = idsParams.safeParse(request.params);
    const body = updateAccountSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const project = await vaultRoute(request, reply, params.data.id, true);
    if (!project) return reply;
    const account = await store.vaultAccounts.findOne({ _id: params.data.childId, projectId: project._id });
    if (!account) return reply.code(404).send({ error: "Cuenta no encontrada." });
    const { secret, ...rest } = body.data;
    const at = new Date();
    const set: Partial<VaultAccountDoc> = { ...rest, updatedAt: at };
    if (secret) {
      set.sealed = seal(vaultKey!, secret, `vault:${project._id}:${account._id}`);
      set.rotatedAt = at;
    }
    await store.vaultAccounts.updateOne({ _id: account._id }, { $set: set });
    await auditOps(request.user!, project, secret ? "ops.account_rotated" : "ops.account_updated", { account: account.label });
    return { account: accountView((await store.vaultAccounts.findOne({ _id: account._id }))!) };
  });

  app.delete("/api/ops/projects/:id/accounts/:childId", { preHandler: requireAuth }, async (request, reply) => {
    const params = idsParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const project = await vaultRoute(request, reply, params.data.id, true);
    if (!project) return reply;
    const account = await store.vaultAccounts.findOneAndDelete({ _id: params.data.childId, projectId: project._id });
    if (!account) return reply.code(404).send({ error: "Cuenta no encontrada." });
    await auditOps(request.user!, project, "ops.account_deleted", { account: account.label });
    return { ok: true };
  });

  /**
   * Muestra el valor guardado. Queda en la auditoría (quién y cuándo, nunca el valor), se responde
   * sin caché y se serializa aquí: la redacción global ocultaría el campo.
   */
  app.post("/api/ops/projects/:id/accounts/:childId/reveal", { preHandler: requireAuth }, async (request, reply) => {
    const params = idsParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const project = await vaultRoute(request, reply, params.data.id, false);
    if (!project) return reply;
    const account = await store.vaultAccounts.findOne({ _id: params.data.childId, projectId: project._id });
    if (!account) return reply.code(404).send({ error: "Cuenta no encontrada." });
    if (!account.sealed) return reply.code(409).send({ error: "Esta cuenta no tiene un valor guardado." });
    let value: string;
    try {
      value = open(vaultKey!, account.sealed, `vault:${project._id}:${account._id}`);
    } catch {
      request.log.error({ accountId: account._id }, "Vault account could not be decrypted");
      return reply.code(500).send({ error: "No se pudo descifrar la cuenta (¿cambió la clave del vault?)." });
    }
    await auditOps(request.user!, project, "ops.account_revealed", { account: account.label });
    return reply
      .header("Cache-Control", "no-store")
      .type("application/json; charset=utf-8")
      .send(JSON.stringify({ username: account.username, credential: value }));
  });

  // ---- novedades ---------------------------------------------------------------

  app.get("/api/ops/projects/:id/updates", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const project = await readableProject(store, request, reply, params.data.id);
    if (!project) return reply;
    const updates = await store.projectUpdates.find({ projectId: project._id }).sort({ createdAt: -1 }).limit(200).toArray();
    return { updates: updates.map((u) => ({ id: u._id, kind: u.kind, body: u.body, authorName: u.authorName, createdAt: u.createdAt })) };
  });

  app.post("/api/ops/projects/:id/updates", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = updateNoteSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const project = await readableProject(store, request, reply, params.data.id);
    if (!project) return reply;
    const user = request.user!;
    if (!canWorkOnProject(user, project)) return forbidden(reply);
    const doc = { _id: randomUUID(), projectId: project._id, kind: "manual" as const, body: body.data.body, authorUsername: user.username, authorName: user.name, createdAt: new Date() };
    await store.projectUpdates.insertOne(doc);
    await store.opsProjects.updateOne({ _id: project._id }, { $set: { updatedAt: doc.createdAt } });
    return reply.code(201).send({ update: { id: doc._id, kind: doc.kind, body: doc.body, authorName: doc.authorName, createdAt: doc.createdAt } });
  });

  // ---- propuestas ---------------------------------------------------------------

  app.get("/api/ops/projects/:id/proposals", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const project = await readableProject(store, request, reply, params.data.id);
    if (!project) return reply;
    const proposals = await store.proposals.find({ projectId: project._id }).sort({ createdAt: -1 }).limit(200).toArray();
    return { proposals: proposals.map(proposalView) };
  });

  /** Una propuesta ligada a un deal queda como la propuesta del deal. */
  async function linkDeal(project: OpsProjectDoc, dealId: string | null | undefined, url: string, reply: FastifyReply) {
    if (!dealId) return true;
    const linked = await store.deals.updateOne({ _id: dealId, projectId: project._id }, { $set: { proposalUrl: url, updatedAt: new Date() } });
    if (!linked.matchedCount) {
      void reply.code(400).send({ error: "El deal no pertenece a este proyecto." });
      return false;
    }
    return true;
  }

  app.post("/api/ops/projects/:id/proposals", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = createProposalSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const project = await readableProject(store, request, reply, params.data.id);
    if (!project) return reply;
    const user = request.user!;
    if (!canManageProject(user, project)) return forbidden(reply);
    if (!(await linkDeal(project, body.data.dealId, body.data.url, reply))) return reply;
    const at = new Date();
    const status = body.data.status ?? "draft";
    const proposal: ProposalDoc = {
      _id: randomUUID(),
      leadId: project.leadId ?? null,
      projectId: project._id,
      dealId: body.data.dealId ?? null,
      title: body.data.title,
      url: body.data.url,
      amountCents: body.data.amountCents ?? null,
      currency: body.data.currency ?? "USD",
      status,
      area: "operations",
      ...statusDates(status, null, at),
      createdBy: user.username,
      createdAt: at,
      updatedAt: at
    };
    await store.proposals.insertOne(proposal);
    await note(user, project._id, `Nueva propuesta: «${proposal.title}» (${PROPOSAL_LABELS[status]}).`);
    await auditOps(user, project, "ops.proposal_created", { proposal: proposal.title });
    return reply.code(201).send({ proposal: proposalView(proposal) });
  });

  app.patch("/api/ops/projects/:id/proposals/:childId", { preHandler: requireAuth }, async (request, reply) => {
    const params = idsParams.safeParse(request.params);
    const body = updateProposalSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const project = await readableProject(store, request, reply, params.data.id);
    if (!project) return reply;
    const user = request.user!;
    if (!canManageProject(user, project)) return forbidden(reply);
    const proposal = await store.proposals.findOne({ _id: params.data.childId, projectId: project._id });
    if (!proposal) return reply.code(404).send({ error: "Propuesta no encontrada." });
    const patch = body.data;
    const dealId = patch.dealId === undefined ? proposal.dealId : patch.dealId;
    if ((patch.dealId !== undefined || patch.url) && !(await linkDeal(project, dealId, patch.url ?? proposal.url, reply))) return reply;
    const at = new Date();
    await store.proposals.updateOne({ _id: proposal._id }, { $set: { ...patch, ...(patch.status ? statusDates(patch.status, proposal.status, at) : {}), updatedAt: at } });
    if (patch.status && patch.status !== proposal.status) {
      await note(user, project._id, `Propuesta «${proposal.title}»: ${PROPOSAL_LABELS[proposal.status]} → ${PROPOSAL_LABELS[patch.status]}`);
      await auditOps(user, project, "ops.proposal_status_changed", { proposal: proposal.title, from: proposal.status, to: patch.status });
    }
    return { proposal: proposalView((await store.proposals.findOne({ _id: proposal._id }))!) };
  });

  // ---- reuniones ---------------------------------------------------------------

  registerMeetingRoutes(app, {
    base: "/api/ops/projects/:id",
    collection: store.meetings,
    ownerKey: "projectId",
    processing: meetings,
    resolve: async (request, reply, id) => {
      const project = await readableProject(store, request, reply, id);
      if (!project) return null;
      return {
        id: project._id,
        canWork: canWorkOnProject(request.user!, project),
        context: `Proyecto: ${project.name}. Cliente: ${project.customerName}. Etapa actual: ${LABELS.stage[project.stage]}.`,
        note: (user, body) => note(user, project._id, body),
        audit: (user, action, details) => auditOps(user, project, `ops.${action}`, details)
      };
    }
  });
}
