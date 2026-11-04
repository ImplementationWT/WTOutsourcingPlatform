import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireModule } from "../auth/modules.js";
import type { SessionUser } from "../auth/users.js";
import { canManageProject, canWorkOnProject, forbidden, projectScope } from "../ops/access.js";
import { type OpsProjectDoc, type OpsTaskDoc, SOLD_DEAL_STATUSES, type SprintDoc, TASK_STATUSES } from "../ops/models.js";
import { DERIVED_FIELDS, deriveTask, subtasksByParent } from "../ops/tasks.js";
import type { AdminStore } from "../store/admin-store.js";

const idParams = z.object({ id: z.string().uuid() });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Usa el formato AAAA-MM-DD.");
const hours = z.number().min(0).max(10_000);
const title = z.string().trim().min(1).max(160);

const taskFields = {
  title,
  sprintId: z.string().uuid().nullable(),
  assigneeUserId: z.string().uuid().nullable(),
  status: z.enum(TASK_STATUSES),
  startDate: isoDate.nullable(),
  dueDate: isoDate.nullable(),
  estimatedHours: hours,
  investedHours: hours,
  billableHours: hours,
  details: z.string().max(10_000)
};
const createTaskSchema = z
  .object({ projectId: z.string().uuid(), parentTaskId: z.string().uuid().nullable(), ...taskFields })
  .partial()
  .required({ projectId: true, title: true })
  .strict();
const updateTaskSchema = z
  .object({ ...taskFields, projectId: z.string().uuid() })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, "No hay nada que cambiar.");
/** Lo único que un developer cambia en sus tareas (docs/rework-plataforma.md §6). */
const DEVELOPER_FIELDS = new Set(["status", "investedHours", "billableHours"]);

const sprintSchema = z.object({ projectId: z.string().uuid(), name: z.string().trim().min(1).max(120), startDate: isoDate, endDate: isoDate }).strict();
const updateSprintSchema = z
  .object({ name: z.string().trim().min(1).max(120), startDate: isoDate, endDate: isoDate })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, "No hay nada que cambiar.");

const invalid = (reply: FastifyReply, error: z.ZodError) =>
  reply.code(400).send({ error: error.issues[0]?.message ?? "Datos inválidos.", issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
const live = { deletedAt: null } as const;
const notDeleted = { $or: [{ deletedAt: { $exists: false } }, live] };

/**
 * Tasks (tablero estilo Monday): tareas con subtareas, sprints, timeline y horas. Todo vive dentro
 * de un proyecto y hereda su alcance (`projectScope`); crear y asignar es del CEO/CCO y del Team
 * Leader, y un developer solo cambia status y horas de lo suyo.
 */
export async function registerTaskRoutes(app: FastifyInstance, { store }: { store: AdminStore }) {
  const guard = { preHandler: requireModule("tasks") };
  const audit = (user: SessionUser, projectId: string, action: string, target: string) => store.audit({ actor: user.username, action, clientId: `ops:${projectId}`, target });

  async function visibleProjects(user: SessionUser) {
    return store.opsProjects.find(projectScope(user), { projection: { name: 1, teamId: 1, leadUserId: 1, developerUserId: 1, developerUserIds: 1, stage: 1 } }).sort({ name: 1 }).toArray();
  }

  /** Proyecto visible para el usuario o 404 (sin confirmar que existe). */
  async function projectFor(request: FastifyRequest, reply: FastifyReply, id: string) {
    const project = await store.opsProjects.findOne({ _id: id, ...projectScope(request.user!) });
    if (!project) void reply.code(404).send({ error: "Proyecto no encontrado." });
    return project;
  }

  async function taskFor(request: FastifyRequest, reply: FastifyReply, id: string) {
    const task = await store.opsTasks.findOne({ _id: id, ...notDeleted });
    const project = task ? await store.opsProjects.findOne({ _id: task.projectId, ...projectScope(request.user!) }) : null;
    if (!task || !project) {
      void reply.code(404).send({ error: "Tarea no encontrada." });
      return null;
    }
    return { task, project };
  }

  const member = async (userId: string | null | undefined, project: Pick<OpsProjectDoc, "teamId">) =>
    !userId || Boolean(await store.users.findOne({ _id: userId, active: true, teamId: project.teamId, role: { $in: ["lead", "developer"] } }));
  const sprintOf = async (sprintId: string | null | undefined, projectId: string) => !sprintId || Boolean(await store.sprints.findOne({ _id: sprintId, projectId, ...notDeleted }));

  const taskView = (t: OpsTaskDoc) => ({
    id: t._id,
    projectId: t.projectId,
    parentTaskId: t.parentTaskId ?? null,
    sprintId: t.sprintId ?? null,
    dealId: t.dealId,
    title: t.title,
    status: t.status,
    assigneeUserId: t.assigneeUserId,
    startDate: t.startDate ?? null,
    dueDate: t.dueDate,
    estimatedHours: t.estimatedHours ?? 0,
    investedHours: t.investedHours ?? 0,
    billableHours: t.billableHours ?? 0,
    details: t.details ?? "",
    updatedAt: t.updatedAt
  });
  const sprintView = (s: SprintDoc) => ({ id: s._id, projectId: s.projectId, number: s.number, name: s.name, startDate: s.startDate, endDate: s.endDate });

  /**
   * Tablero: todos los proyectos visibles con sus sprints, tareas (con subtareas y valores
   * calculados) y las personas de sus equipos. Los filtros y vistas se aplican en el navegador.
   */
  app.get("/api/tasks/board", guard, async (request) => {
    const user = request.user!;
    const projects = await visibleProjects(user);
    const ids = projects.map((p) => p._id);
    const teamIds = [...new Set(projects.map((p) => p.teamId))];
    const [tasks, sprints, people, teams, updates, sold] = await Promise.all([
      store.opsTasks.find({ projectId: { $in: ids }, ...notDeleted }).sort({ createdAt: 1 }).toArray(),
      store.sprints.find({ projectId: { $in: ids }, ...notDeleted }).sort({ startDate: 1, number: 1 }).toArray(),
      store.users.find({ teamId: { $in: teamIds }, active: true, role: { $in: ["lead", "developer"] } }, { projection: { name: 1, role: 1, teamId: 1 } }).sort({ name: 1 }).toArray(),
      store.teams.find({ _id: { $in: teamIds } }, { projection: { name: 1 } }).toArray(),
      store.taskUpdates.aggregate<{ _id: string; n: number }>([{ $match: { projectId: { $in: ids } } }, { $group: { _id: "$taskId", n: { $sum: 1 } } }]).toArray(),
      // Horas vendidas: deals aprobados en adelante (como en Proyectos).
      store.deals.aggregate<{ _id: string; hours: number }>([{ $match: { projectId: { $in: ids }, status: { $in: [...SOLD_DEAL_STATUSES] } } }, { $group: { _id: "$projectId", hours: { $sum: "$hours" } } }]).toArray()
    ]);
    const soldOf = new Map(sold.map((d) => [d._id, d.hours]));
    const subs = subtasksByParent(tasks);
    const teamName = new Map(teams.map((t) => [t._id, t.name]));
    const updatesOf = new Map(updates.map((u) => [u._id, u.n]));
    return {
      projects: projects.map((p) => ({
        id: p._id,
        name: p.name,
        stage: p.stage,
        team: { id: p.teamId, name: teamName.get(p.teamId) ?? null },
        leadUserId: p.leadUserId,
        developerUserIds: p.developerUserIds ?? (p.developerUserId ? [p.developerUserId] : []),
        soldHours: soldOf.get(p._id) ?? 0,
        canManage: canManageProject(user, p),
        canWork: canWorkOnProject(user, p)
      })),
      sprints: sprints.map(sprintView),
      people: people.map((u) => ({ id: u._id, name: u.name, role: u.role, teamId: u.teamId })),
      tasks: tasks
        .filter((t) => !t.parentTaskId)
        .map((t) => {
          const children = subs.get(t._id) ?? [];
          return { ...taskView(t), updates: updatesOf.get(t._id) ?? 0, derived: deriveTask(t, children), subtasks: children.map((c) => ({ ...taskView(c), updates: updatesOf.get(c._id) ?? 0 })) };
        }),
      me: user.id
    };
  });

  /** Para el contador del menú: tareas (no subtareas) sin sprint en los proyectos visibles. */
  app.get("/api/tasks/backlog-count", { preHandler: requireModule("backlog") }, async (request) => {
    const ids = (await visibleProjects(request.user!)).map((p) => p._id);
    const count = ids.length ? await store.opsTasks.countDocuments({ projectId: { $in: ids }, parentTaskId: null, sprintId: null, deletedAt: null }) : 0;
    return { count };
  });

  app.post("/api/tasks", guard, async (request, reply) => {
    const body = createTaskSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const input = body.data;
    const project = await projectFor(request, reply, input.projectId);
    if (!project) return reply;
    const user = request.user!;
    if (!canManageProject(user, project)) return forbidden(reply);
    let parent: OpsTaskDoc | null = null;
    if (input.parentTaskId) {
      parent = await store.opsTasks.findOne({ _id: input.parentTaskId, projectId: project._id, ...notDeleted });
      if (!parent || parent.parentTaskId) return reply.code(400).send({ error: "La tarea padre no existe en este proyecto (las subtareas no tienen subtareas)." });
    }
    if (!(await member(input.assigneeUserId, project))) return reply.code(400).send({ error: "El owner debe ser del equipo del proyecto." });
    if (!parent && !(await sprintOf(input.sprintId, project._id))) return reply.code(400).send({ error: "El sprint no es de este proyecto." });
    if (input.startDate && input.dueDate && input.startDate > input.dueDate) return reply.code(400).send({ error: "El inicio no puede ser después del fin." });
    if (!parent && input.status) return reply.code(400).send({ error: "El status vive en las subtareas." });
    const at = new Date();
    const task: OpsTaskDoc = {
      _id: randomUUID(),
      projectId: project._id,
      dealId: null,
      title: input.title,
      assigneeUserId: input.assigneeUserId ?? null,
      estimatedHours: input.estimatedHours ?? 0,
      investedHours: input.investedHours ?? 0,
      billableHours: input.billableHours ?? 0,
      status: input.status ?? "todo",
      startDate: input.startDate ?? null,
      dueDate: input.dueDate ?? null,
      parentTaskId: parent?._id ?? null,
      sprintId: parent ? null : (input.sprintId ?? null),
      details: input.details ?? "",
      deletedAt: null,
      createdBy: user.username,
      createdAt: at,
      updatedAt: at
    };
    await store.opsTasks.insertOne(task);
    await audit(user, project._id, parent ? "tasks.subtask_created" : "tasks.task_created", task.title);
    return reply.code(201).send({ task: taskView(task) });
  });

  app.patch("/api/tasks/:id", guard, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = updateTaskSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const found = await taskFor(request, reply, params.data.id);
    if (!found) return reply;
    const { task, project } = found;
    const user = request.user!;
    const patch = body.data;
    const keys = Object.keys(patch);
    if (!canManageProject(user, project)) {
      const own = canWorkOnProject(user, project) && task.assigneeUserId === user.id;
      if (!own || keys.some((k) => !DEVELOPER_FIELDS.has(k))) return forbidden(reply);
    }
    const isParent = !task.parentTaskId;
    const hasSubs = isParent && (await store.opsTasks.countDocuments({ parentTaskId: task._id, ...notDeleted })) > 0;
    if (hasSubs && keys.some((k) => (DERIVED_FIELDS as readonly string[]).includes(k))) return reply.code(400).send({ error: "Se calcula desde las subtareas: edítalo en ellas." });
    if (isParent && patch.status) return reply.code(400).send({ error: "El status vive en las subtareas." });
    if (!isParent && (patch.sprintId !== undefined || patch.projectId)) return reply.code(400).send({ error: "Una subtarea usa el sprint y el proyecto de su tarea." });

    let target = project;
    if (patch.projectId && patch.projectId !== project._id) {
      const next = await store.opsProjects.findOne({ _id: patch.projectId, ...projectScope(user) });
      if (!next || !canManageProject(user, next)) return reply.code(400).send({ error: "No puedes mover la tarea a ese proyecto." });
      target = next;
    }
    if (patch.assigneeUserId !== undefined && !(await member(patch.assigneeUserId, target))) return reply.code(400).send({ error: "El owner debe ser del equipo del proyecto." });
    if (patch.sprintId !== undefined && !(await sprintOf(patch.sprintId, target._id))) return reply.code(400).send({ error: "El sprint no es de este proyecto." });
    const start = patch.startDate !== undefined ? patch.startDate : (task.startDate ?? null);
    const end = patch.dueDate !== undefined ? patch.dueDate : task.dueDate;
    if (start && end && start > end) return reply.code(400).send({ error: "El inicio no puede ser después del fin." });

    const at = new Date();
    const set: Partial<OpsTaskDoc> = { ...patch, updatedAt: at };
    if (patch.status === "done" && task.status !== "done") set.completedAt = at;
    if (target._id !== project._id) {
      // Al cambiar de proyecto el sprint y el owner que no son del equipo nuevo se quitan, también en sus subtareas.
      set.sprintId = patch.sprintId ?? null;
      if (patch.assigneeUserId === undefined && !(await member(task.assigneeUserId, target))) set.assigneeUserId = null;
      for (const sub of await store.opsTasks.find({ parentTaskId: task._id }).toArray()) {
        await store.opsTasks.updateOne({ _id: sub._id }, { $set: { projectId: target._id, updatedAt: at, ...((await member(sub.assigneeUserId, target)) ? {} : { assigneeUserId: null }) } });
      }
    }
    await store.opsTasks.updateOne({ _id: task._id }, { $set: set, ...(patch.status && patch.status !== "done" && task.status === "done" ? { $unset: { completedAt: "" } } : {}) });
    if (patch.status && patch.status !== task.status) await audit(user, target._id, "tasks.status_changed", `${task.title}: ${task.status} → ${patch.status}`);
    return { task: taskView((await store.opsTasks.findOne({ _id: task._id }))!) };
  });

  /** Borrar deja la tarea (y sus subtareas) marcada: «Deshacer» la recupera. */
  app.delete("/api/tasks/:id", guard, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const found = await taskFor(request, reply, params.data.id);
    if (!found) return reply;
    if (!canManageProject(request.user!, found.project)) return forbidden(reply);
    const at = new Date();
    await store.opsTasks.updateOne({ _id: found.task._id }, { $set: { deletedAt: at, updatedAt: at } });
    await store.opsTasks.updateMany({ parentTaskId: found.task._id, ...notDeleted }, { $set: { deletedAt: at, deletedWith: found.task._id, updatedAt: at } });
    await audit(request.user!, found.project._id, "tasks.deleted", found.task.title);
    return { ok: true };
  });

  app.post("/api/tasks/:id/restore", guard, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const task = await store.opsTasks.findOne({ _id: params.data.id, deletedAt: { $type: "date" } });
    const project = task ? await store.opsProjects.findOne({ _id: task.projectId, ...projectScope(request.user!) }) : null;
    if (!task || !project) return reply.code(404).send({ error: "Tarea no encontrada." });
    if (!canManageProject(request.user!, project)) return forbidden(reply);
    await store.opsTasks.updateOne({ _id: task._id }, { $set: { deletedAt: null, updatedAt: new Date() } });
    await store.opsTasks.updateMany({ parentTaskId: task._id, deletedWith: task._id }, { $set: { deletedAt: null, deletedWith: null } });
    await audit(request.user!, project._id, "tasks.restored", task.title);
    return { ok: true };
  });

  // ---- actualizaciones ----------------------------------------------------------

  app.get("/api/tasks/:id/updates", guard, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const found = await taskFor(request, reply, params.data.id);
    if (!found) return reply;
    const rows = await store.taskUpdates.find({ taskId: found.task._id }).sort({ createdAt: -1 }).limit(200).toArray();
    return { updates: rows.map((u) => ({ id: u._id, body: u.body, authorName: u.authorName, createdAt: u.createdAt })) };
  });

  app.post("/api/tasks/:id/updates", guard, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = z.object({ body: z.string().trim().min(1).max(4000) }).strict().safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const found = await taskFor(request, reply, params.data.id);
    if (!found) return reply;
    const user = request.user!;
    if (!canWorkOnProject(user, found.project)) return forbidden(reply);
    const doc = { _id: randomUUID(), taskId: found.task._id, projectId: found.project._id, body: body.data.body, authorUsername: user.username, authorName: user.name, createdAt: new Date() };
    await store.taskUpdates.insertOne(doc);
    return reply.code(201).send({ update: { id: doc._id, body: doc.body, authorName: doc.authorName, createdAt: doc.createdAt } });
  });

  // ---- sprints --------------------------------------------------------------------

  async function sprintFor(request: FastifyRequest, reply: FastifyReply, id: string, deleted = false) {
    const sprint = await store.sprints.findOne({ _id: id, ...(deleted ? { deletedAt: { $type: "date" } } : notDeleted) });
    const project = sprint ? await store.opsProjects.findOne({ _id: sprint.projectId, ...projectScope(request.user!) }) : null;
    if (!sprint || !project) {
      void reply.code(404).send({ error: "Sprint no encontrado." });
      return null;
    }
    if (!canManageProject(request.user!, project)) {
      void forbidden(reply);
      return null;
    }
    return { sprint, project };
  }

  app.post("/api/sprints", guard, async (request, reply) => {
    const body = sprintSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const project = await projectFor(request, reply, body.data.projectId);
    if (!project) return reply;
    const user = request.user!;
    if (!canManageProject(user, project)) return forbidden(reply);
    if (body.data.startDate > body.data.endDate) return reply.code(400).send({ error: "El inicio no puede ser después del fin." });
    // El número no se reutiliza aunque se borre un sprint.
    const last = await store.sprints.find({ projectId: project._id }).sort({ number: -1 }).limit(1).toArray();
    const at = new Date();
    const sprint: SprintDoc = { _id: randomUUID(), projectId: project._id, number: (last[0]?.number ?? 0) + 1, name: body.data.name, startDate: body.data.startDate, endDate: body.data.endDate, deletedAt: null, createdBy: user.username, createdAt: at, updatedAt: at };
    await store.sprints.insertOne(sprint);
    await audit(user, project._id, "sprints.created", `Sprint ${sprint.number}: ${sprint.name}`);
    return reply.code(201).send({ sprint: sprintView(sprint) });
  });

  app.patch("/api/sprints/:id", guard, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = updateSprintSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const found = await sprintFor(request, reply, params.data.id);
    if (!found) return reply;
    const start = body.data.startDate ?? found.sprint.startDate;
    const end = body.data.endDate ?? found.sprint.endDate;
    if (start > end) return reply.code(400).send({ error: "El inicio no puede ser después del fin." });
    await store.sprints.updateOne({ _id: found.sprint._id }, { $set: { ...body.data, updatedAt: new Date() } });
    return { sprint: sprintView((await store.sprints.findOne({ _id: found.sprint._id }))!) };
  });

  /** Borrar un sprint deja sus tareas sin sprint; «Deshacer» las vuelve a poner. */
  app.delete("/api/sprints/:id", guard, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const found = await sprintFor(request, reply, params.data.id);
    if (!found) return reply;
    const detached = (await store.opsTasks.find({ sprintId: found.sprint._id }, { projection: { _id: 1 } }).toArray()).map((t) => t._id);
    const at = new Date();
    await store.opsTasks.updateMany({ _id: { $in: detached } }, { $set: { sprintId: null, updatedAt: at } });
    await store.sprints.updateOne({ _id: found.sprint._id }, { $set: { deletedAt: at, detachedTaskIds: detached, updatedAt: at } });
    await audit(request.user!, found.project._id, "sprints.deleted", `Sprint ${found.sprint.number}: ${found.sprint.name}`);
    return { ok: true, detached: detached.length };
  });

  app.post("/api/sprints/:id/restore", guard, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const found = await sprintFor(request, reply, params.data.id, true);
    if (!found) return reply;
    await store.sprints.updateOne({ _id: found.sprint._id }, { $set: { deletedAt: null, detachedTaskIds: [], updatedAt: new Date() } });
    await store.opsTasks.updateMany({ _id: { $in: found.sprint.detachedTaskIds ?? [] }, sprintId: null }, { $set: { sprintId: found.sprint._id } });
    return { ok: true };
  });
}
