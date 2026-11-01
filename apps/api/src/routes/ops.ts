import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { canSeeClient } from "../auth/access.js";
import { requireAuth } from "../auth/session.js";
import type { SessionUser } from "../auth/users.js";
import { open, seal } from "../lib/server-cipher.js";
import { registerSecret } from "../lib/redact.js";
import { canManageProject, canWorkOnProject, forbidden, projectScope, readableProject } from "../ops/access.js";
import { runTableQuery, tableQuerySchema } from "../lib/table-query.js";
import {
  ACCOUNT_KINDS,
  type ActionItemDoc,
  HEALTH_SCORES,
  type MeetingCore,
  newChangeOrder,
  NEXT_ACTIONS,
  type OpsProjectDoc,
  type OpsTaskDoc,
  PAYMENT_TYPES,
  PRIORITIES,
  PROJECT_STAGES,
  sentimentOf,
  SOLD_DEAL_STATUSES,
  TASK_STATUSES,
  type VaultAccountDoc
} from "../ops/models.js";
import type { MeetingProcessing } from "../meetings/processing.js";
import { type ConvertInput, registerMeetingRoutes } from "../meetings/routes.js";
import { canEditDeal } from "../core/access.js";
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

const projectFields = {
  name: text(80).min(3),
  /** Nombre del cliente: si llega `contactIds`, sale del contacto (su empresa o su nombre). */
  customerName: text(80).min(2),
  leadUserId: userId,
  developerUserId: userId,
  clientSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/).nullable(),
  // Del proyecto solo queda el SOW (sin propuesta ni Project Plan).
  sowUrl: optionalUrl,
  kickoffDate: isoDate.nullable(),
  /** El cliente del proyecto es su contacto (el primero). */
  contactIds: z.array(z.string().uuid()).max(50),
  stage: z.enum(PROJECT_STAGES),
  health: z.enum(HEALTH_SCORES),
  priority: z.enum(PRIORITIES),
  paymentType: z.enum(PAYMENT_TYPES).nullable(),
  nextAction: z.enum(NEXT_ACTIONS).nullable()
};

// Sentiment no se acepta: se deriva del Health (docs/rework-plataforma.md §3).
const createProjectSchema = z
  .object({ ...projectFields, teamId: z.string().uuid() })
  .partial()
  .required({ name: true })
  .strict()
  .refine((v) => Boolean(v.customerName || v.contactIds?.length), "Indica el cliente.");

const updateProjectSchema = z
  .object(projectFields)
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

const listQuery = tableQuerySchema.extend({
  stage: z.enum(PROJECT_STAGES).optional(),
  health: z.enum(HEALTH_SCORES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  teamId: z.string().uuid().optional(),
});

/** Responde el error y devuelve null (conversiones que no se pueden hacer). */
const refuse = (_sent: unknown) => null;

/** Contexto de una reunión de proyecto para el modelo. */
export const meetingContext = (project: Pick<OpsProjectDoc, "name" | "customerName" | "stage">) =>
  `Proyecto: ${project.name}. Cliente: ${project.customerName}. Etapa actual: ${LABELS.stage[project.stage]}.`;

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

  /**
   * Vista de proyectos con sus nombres y los campos calculados en el servidor (§4.2): horas vendidas
   * (deals aprobados en adelante), horas facturables (de las subtareas, que llegan en el paso 2: hoy
   * 0), facturable vs deals y avance (tareas hechas / totales).
   */
  async function people(projects: OpsProjectDoc[]) {
    const ids = [...new Set(projects.flatMap((p) => [p.leadUserId, p.developerUserId]).filter((v): v is string => Boolean(v)))];
    const teamIds = [...new Set(projects.map((p) => p.teamId))];
    const projectIds = projects.map((p) => p._id);
    const contactIds = [...new Set(projects.flatMap((p) => p.contactIds ?? []))];
    const [users, teams, deals, tasks, contacts] = await Promise.all([
      ids.length ? store.users.find({ _id: { $in: ids } }, { projection: { name: 1 } }).toArray() : [],
      teamIds.length ? store.teams.find({ _id: { $in: teamIds } }, { projection: { name: 1 } }).toArray() : [],
      projectIds.length
        ? store.deals
            .aggregate<{ _id: string; deals: number; soldHours: number; amountCents: number }>([
              { $match: { projectId: { $in: projectIds }, status: { $ne: "cancelled" } } },
              {
                $group: {
                  _id: "$projectId",
                  deals: { $sum: 1 },
                  soldHours: { $sum: { $cond: [{ $in: ["$status", [...SOLD_DEAL_STATUSES]] }, "$hours", 0] } },
                  amountCents: { $sum: { $cond: [{ $in: ["$status", [...SOLD_DEAL_STATUSES]] }, "$amountCents", 0] } }
                }
              }
            ])
            .toArray()
        : [],
      projectIds.length
        ? store.opsTasks
            .aggregate<{ _id: string; tasks: number; done: number }>([
              { $match: { projectId: { $in: projectIds } } },
              { $group: { _id: "$projectId", tasks: { $sum: 1 }, done: { $sum: { $cond: [{ $eq: ["$status", "done"] }, 1, 0] } } } }
            ])
            .toArray()
        : [],
      contactIds.length ? store.contacts.find({ _id: { $in: contactIds } }, { projection: { name: 1, company: 1 } }).toArray() : []
    ]);
    const userName = new Map(users.map((u) => [u._id, u.name]));
    const teamName = new Map(teams.map((t) => [t._id, t.name]));
    const dealsOf = new Map(deals.map((d) => [d._id, d]));
    const tasksOf = new Map(tasks.map((t) => [t._id, t]));
    const contactName = new Map(contacts.map((c) => [c._id, c.name]));
    const contactCompany = new Map(contacts.map((c) => [c._id, c.company ?? null]));
    return (project: OpsProjectDoc) => {
      const d = dealsOf.get(project._id);
      const t = tasksOf.get(project._id);
      const soldHours = d?.soldHours ?? 0;
      const billableHours = 0;
      return {
        id: project._id,
        name: project.name,
        customerName: project.customerName,
        team: { id: project.teamId, name: teamName.get(project.teamId) ?? null },
        lead: project.leadUserId ? { id: project.leadUserId, name: userName.get(project.leadUserId) ?? null } : null,
        developer: project.developerUserId ? { id: project.developerUserId, name: userName.get(project.developerUserId) ?? null } : null,
        contacts: (project.contactIds ?? []).map((id) => ({ id, name: contactName.get(id) ?? null })),
        /** El cliente: el contacto del proyecto (con su empresa). */
        client: project.contactIds?.[0] ? { id: project.contactIds[0], name: contactName.get(project.contactIds[0]) ?? null, company: contactCompany.get(project.contactIds[0]) ?? null } : null,
        clientSlug: project.clientSlug,
        sowUrl: project.sowUrl ?? null,
        kickoffDate: project.kickoffDate ?? null,
        leadId: project.leadId ?? null,
        stage: project.stage,
        health: project.health,
        sentimentScore: sentimentOf(project.health),
        priority: project.priority,
        paymentType: project.paymentType ?? null,
        nextAction: project.nextAction ?? null,
        summary: {
          deals: d?.deals ?? 0,
          amountCents: d?.amountCents ?? 0,
          soldHours,
          billableHours,
          billableVsSold: billableHours - soldHours,
          tasks: t?.tasks ?? 0,
          tasksDone: t?.done ?? 0,
          progress: t?.tasks ? Math.round((t.done / t.tasks) * 100) : 0
        },
        createdAt: project.createdAt,
        updatedAt: project.updatedAt
      };
    };
  }

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

  /** Los contactos del proyecto deben existir. */
  async function checkContacts(contactIds: string[] | undefined, reply: FastifyReply) {
    if (contactIds?.length && (await store.contacts.countDocuments({ _id: { $in: contactIds } })) !== new Set(contactIds).size) {
      void reply.code(400).send({ error: "Algún contacto no existe." });
      return false;
    }
    return true;
  }

  /** Nombre del cliente a partir de su contacto: la empresa o, si no tiene, el nombre. */
  async function customerOf(contactIds: string[] | undefined) {
    if (!contactIds?.length) return null;
    const contact = await store.contacts.findOne({ _id: contactIds[0] }, { projection: { name: 1, company: 1 } });
    return contact ? (contact.company?.trim() || contact.name).slice(0, 80) : null;
  }

  /**
   * Contactos para elegir el cliente de un proyecto: solo nombre y empresa, para quien crea o
   * gestiona proyectos (el Team Leader no ve la lista completa de Contactos).
   */
  app.get("/api/ops/contact-options", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user!;
    if (user.role !== "boss" && user.role !== "lead") return forbidden(reply);
    const contacts = await store.contacts.find({}, { projection: { name: 1, company: 1 } }).sort({ name: 1 }).limit(500).toArray();
    return { contacts: contacts.map((c) => ({ id: c._id, name: c.name, company: c.company ?? null })) };
  });

  /** Tabla de proyectos: paginada, ordenada y filtrada en el servidor, con contadores por etapa y totales. */
  app.get("/api/ops/projects", { preHandler: requireAuth }, async (request, reply) => {
    const query = listQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, query.error);
    const user = request.user!;
    const match = {
      ...projectScope(user, query.data.teamId),
      ...(query.data.stage ? { stage: query.data.stage } : {}),
      ...(query.data.health ? { health: query.data.health } : {}),
      ...(query.data.priority ? { priority: query.data.priority } : {}),
    };
    const result = await runTableQuery(store.opsProjects, {
      match,
      query: query.data,
      sortable: {
        name: "name",
        customerName: "customerName",
        stage: { field: "stage", order: PROJECT_STAGES },
        health: { field: "health", order: HEALTH_SCORES },
        priority: { field: "priority", order: PRIORITIES },
        kickoffDate: "kickoffDate",
        updatedAt: "updatedAt"
      },
      defaultSort: { key: "updatedAt", dir: "desc" },
      search: ["name", "customerName"],
      facetField: "stage"
    });
    const present = await people(result.rows);
    // Totales del conjunto filtrado (no solo de la página): horas vendidas y valor de deals vendidos.
    const ids = (await store.opsProjects.find(match, { projection: { _id: 1 } }).toArray()).map((p) => p._id);
    const [sold] = ids.length
      ? await store.deals
          .aggregate<{ soldHours: number; amountCents: number }>([
            { $match: { projectId: { $in: ids }, status: { $in: [...SOLD_DEAL_STATUSES] } } },
            { $group: { _id: null, soldHours: { $sum: "$hours" }, amountCents: { $sum: "$amountCents" } } }
          ])
          .toArray()
      : [];
    return {
      ...result,
      rows: result.rows.map((p) => ({ ...present(p), canManage: canManageProject(user, p) })),
      totals: { soldHours: sold?.soldHours ?? 0, billableHours: 0, amountCents: sold?.amountCents ?? 0 },
      canCreate: user.role === "boss" || user.role === "lead"
    };
  });

  app.post("/api/ops/projects", { preHandler: requireAuth }, async (request, reply) => {
    const body = createProjectSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const user = request.user!;
    if (user.role !== "boss" && user.role !== "lead") return forbidden(reply);
    const input = body.data;
    const teamId = user.role === "boss" ? input.teamId : user.teamId;
    if (!teamId) return reply.code(400).send({ error: user.role === "boss" ? "Elige el equipo del proyecto." : "Tu usuario no tiene equipo." });
    const team = await store.teams.findOne({ _id: teamId });
    if (!team) return reply.code(400).send({ error: "El equipo no existe." });
    if (!(await teamMember(input.leadUserId, teamId, ["lead"]))) return reply.code(400).send({ error: "El Team Leader debe ser un team leader activo de ese equipo." });
    if (!(await teamMember(input.developerUserId, teamId, ["developer"]))) return reply.code(400).send({ error: "El Developer debe ser un developer activo de ese equipo." });
    if (!(await checkContacts(input.contactIds, reply))) return reply;
    if (input.clientSlug) {
      const app_ = await store.getClient(input.clientSlug);
      if (!app_ || !canSeeClient(user, app_)) return reply.code(400).send({ error: "La app de Infraestructura no existe." });
      if (await store.opsProjects.findOne({ clientSlug: input.clientSlug })) return reply.code(409).send({ error: "Esa app ya está enlazada a otro proyecto." });
    }
    const customerName = (await customerOf(input.contactIds)) ?? input.customerName;
    if (!customerName) return reply.code(400).send({ error: "Indica el cliente." });
    // Sin Team Leader elegido: el del equipo (si sigue activo en él); si no, quien lo crea.
    const teamLead = team.leadUserId && (await teamMember(team.leadUserId, teamId, ["lead"])) ? team.leadUserId : null;
    const at = new Date();
    const project: OpsProjectDoc = {
      _id: randomUUID(),
      name: input.name,
      customerName,
      contactIds: [...new Set(input.contactIds ?? [])],
      teamId,
      leadUserId: input.leadUserId ?? teamLead ?? (user.role === "lead" ? user.id : null),
      developerUserId: input.developerUserId ?? null,
      clientSlug: input.clientSlug ?? null,
      sowUrl: input.sowUrl ?? null,
      kickoffDate: input.kickoffDate ?? null,
      stage: input.stage ?? "kickoff",
      health: input.health ?? "neutral",
      priority: input.priority ?? "medium",
      paymentType: input.paymentType ?? null,
      nextAction: input.nextAction ?? null,
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
    if (!(await checkContacts(patch.contactIds, reply))) return reply;
    if (patch.clientSlug) {
      const app_ = await store.getClient(patch.clientSlug);
      if (!app_ || !canSeeClient(user, app_)) return reply.code(400).send({ error: "La app de Infraestructura no existe." });
      const taken = await store.opsProjects.findOne({ clientSlug: patch.clientSlug, _id: { $ne: project._id } });
      if (taken) return reply.code(409).send({ error: "Esa app ya está enlazada a otro proyecto." });
    }

    const changes: string[] = [];
    if (patch.stage && patch.stage !== project.stage) changes.push(`Etapa: ${LABELS.stage[project.stage]} → ${LABELS.stage[patch.stage]}`);
    // Cambiar el Health recalcula el Sentiment (§5.5): la novedad deja ambos.
    if (patch.health && patch.health !== project.health) {
      changes.push(`Health: ${LABELS.health[project.health]} → ${LABELS.health[patch.health]} (Sentiment ${sentimentOf(project.health)} → ${sentimentOf(patch.health)})`);
    }
    if (patch.priority && patch.priority !== project.priority) changes.push(`Prioridad: ${LABELS.priority[project.priority]} → ${LABELS.priority[patch.priority]}`);
    if (patch.leadUserId !== undefined && patch.leadUserId !== project.leadUserId) changes.push("Cambió el Team Leader.");
    if (patch.developerUserId !== undefined && patch.developerUserId !== project.developerUserId) changes.push("Cambió el Developer.");

    const updatedAt = new Date();
    const customerName = await customerOf(patch.contactIds);
    if (customerName && customerName !== project.customerName) changes.push(`Cliente: ${project.customerName} → ${customerName}`);
    const set = {
      ...patch,
      ...(patch.contactIds ? { contactIds: [...new Set(patch.contactIds)] } : {}),
      ...(customerName ? { customerName } : {}),
      updatedAt
    };
    await store.opsProjects.updateOne({ _id: project._id }, { $set: set });
    if (changes.length) {
      await note(user, project._id, changes.join("\n"));
      await auditOps(user, project, "ops.project_updated", { changes: changes.length });
    }
    const fresh = (await store.opsProjects.findOne({ _id: project._id }))!;
    const present = await people([fresh]);
    return { project: present(fresh) };
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

  /**
   * Action item → Task (Team Leader del proyecto) o → Change Order del deal (quien puede editar el
   * deal). Las horas propuestas pasan como estimadas; la persona puede corregirlas antes.
   */
  async function convertActionItem(project: OpsProjectDoc, user: SessionUser, meeting: MeetingCore, item: ActionItemDoc, input: ConvertInput, reply: FastifyReply) {
    const at = new Date();
    if (input.to === "task") {
      if (!canManageProject(user, project)) return refuse(forbidden(reply));
      const assigneeUserId = input.assigneeUserId !== undefined ? input.assigneeUserId : item.ownerUserId;
      const dealId = meeting.dealId ?? null;
      if (!(await checkTaskLinks(project, dealId, assigneeUserId, reply))) return null;
      const task: OpsTaskDoc = {
        _id: randomUUID(),
        projectId: project._id,
        dealId,
        title: (input.title ?? item.text).slice(0, 160),
        assigneeUserId: assigneeUserId ?? null,
        estimatedHours: input.hours ?? item.projectedHours ?? 0,
        status: "todo",
        dueDate: input.dueDate ?? null,
        createdBy: user.username,
        createdAt: at,
        updatedAt: at
      };
      await store.opsTasks.insertOne(task);
      await auditOps(user, project, "ops.task_created", { task: task.title, fromMeeting: true });
      return { id: task._id, label: "tarea" };
    }
    const dealId = input.dealId ?? meeting.dealId;
    if (!dealId) return refuse(reply.code(400).send({ error: "Elige el deal del change order." }));
    const deal = await store.deals.findOne({ _id: dealId, projectId: project._id });
    if (!deal) return refuse(reply.code(400).send({ error: "El deal no es de este proyecto." }));
    if (!canEditDeal(user, deal)) return refuse(forbidden(reply));
    const co = newChangeOrder({ description: (input.title ?? item.text).slice(0, 1000), hours: input.hours ?? item.projectedHours ?? 0, rateCents: deal.rateCents }, user.username, at);
    await store.deals.updateOne({ _id: deal._id }, { $push: { changeOrders: co }, $set: { updatedAt: at } });
    await store.audit({ actor: user.username, action: "core.deal_change_order_created", clientId: `core:${deal._id}`, target: `${deal.dealCode} ${deal.title}`, details: { hours: co.hours, fromMeeting: true } });
    return { id: co._id, label: `change order de ${deal.dealCode}` };
  }

  registerMeetingRoutes(app, {
    base: "/api/ops/projects/:id",
    store,
    collection: store.meetings,
    ownerKey: "projectId",
    processing: meetings,
    resolve: async (request, reply, id) => {
      const project = await readableProject(store, request, reply, id);
      if (!project) return null;
      return {
        id: project._id,
        teamId: project.teamId,
        canWork: canWorkOnProject(request.user!, project),
        context: meetingContext(project),
        conversions: ["task", "change_order"],
        validDeal: async (dealId) => Boolean(await store.deals.findOne({ _id: dealId, projectId: project._id }, { projection: { _id: 1 } })),
        convert: (user, meeting, item, input, reply) => convertActionItem(project, user, meeting, item, input, reply),
        note: (user, body) => note(user, project._id, body),
        audit: (user, action, details) => auditOps(user, project, `ops.${action}`, details)
      };
    }
  });
}
