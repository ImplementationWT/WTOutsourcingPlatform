import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createLoginGuard } from "../src/auth/login-guard.js";
import { hashPassword } from "../src/auth/password.js";
import { freshStore, startDb, stopDb } from "./helpers/db.js";
import { createFakes } from "./helpers/fakes.js";
import { OTHER_TEAM_ID, seedUser, TEST_TEAM_ID } from "./helpers/users.js";

const PASSWORD = "correct horse battery staple";
let passwordHash: string;
let apps: Awaited<ReturnType<typeof buildApp>>[] = [];
beforeAll(async () => {
  await startDb();
  passwordHash = await hashPassword(PASSWORD);
});
afterAll(stopDb);
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

async function world() {
  const store = await freshStore();
  const app = await buildApp({
    store,
    deps: createFakes(store).deps,
    logLevel: "silent",
    auth: { adminUsername: "jefe", adminPasswordHash: passwordHash, sessionSecret: "x".repeat(40), secureCookies: false, loginGuard: createLoginGuard({ maxPerIp: 1000, maxPerUser: 1000 }) }
  });
  apps.push(app);
  const lead = await seedUser(store, passwordHash, { username: "ana", name: "Ana Líder", role: "lead", teamId: TEST_TEAM_ID });
  const dev = await seedUser(store, passwordHash, { username: "dev", name: "Diego Dev", role: "developer", teamId: TEST_TEAM_ID });
  const dev2 = await seedUser(store, passwordHash, { username: "dev2", name: "Dora Dev", role: "developer", teamId: TEST_TEAM_ID });
  await seedUser(store, passwordHash, { username: "olga", name: "Olga Otra", role: "lead", teamId: OTHER_TEAM_ID, teamName: "Equipo B" });
  await seedUser(store, passwordHash, { username: "marta", name: "Marta", role: "commercial", teamId: null });
  const as = async (username: string) => {
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: PASSWORD } });
    const cookie = `pp_session=${login.cookies.find((c) => c.name === "pp_session")!.value}`;
    return async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
      const r = await app.inject({ method, url, headers: { cookie }, payload: payload as never });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- respuestas JSON variadas en los tests
      return { status: r.statusCode, body: (r.body ? r.json() : {}) as Record<string, any> };
    };
  };
  const ana = await as("ana");
  const project = (await ana("POST", "/api/ops/projects", { name: "Manpersa", customerName: "Manpersa SAC" })).body.project as { id: string };
  return { store, as, ana, lead, dev, dev2, project };
}

describe("tasks con subtareas", () => {
  it("la tarea padre se calcula desde sus subtareas y no se edita a mano", async () => {
    const { ana, dev, dev2, project } = await world();
    const task = (await ana("POST", "/api/tasks", { projectId: project.id, title: "Checklist engine", estimatedHours: 5 })).body.task;
    let board = (await ana("GET", "/api/tasks/board")).body;
    expect(board.tasks[0].derived).toMatchObject({ status: null, estimatedHours: 5 });
    const sub = async (title: string, extra: Record<string, unknown>) => (await ana("POST", "/api/tasks", { projectId: project.id, parentTaskId: task.id, title, ...extra })).body.task;
    await sub("Plantillas", { assigneeUserId: dev._id, status: "done", startDate: "2026-11-02", dueDate: "2026-11-04", estimatedHours: 3, investedHours: 4, billableHours: 3 });
    await sub("Recordatorios", { assigneeUserId: dev2._id, status: "stuck", startDate: "2026-11-05", dueDate: "2026-11-09", estimatedHours: 2, investedHours: 1 });
    board = (await ana("GET", "/api/tasks/board")).body;
    expect(board.tasks).toHaveLength(1);
    expect(board.tasks[0].derived).toEqual({
      status: "stuck",
      statusCounts: { done: 1, stuck: 1 },
      ownerIds: [dev._id, dev2._id],
      startDate: "2026-11-02",
      dueDate: "2026-11-09",
      estimatedHours: 5,
      investedHours: 5,
      billableHours: 3
    });
    for (const patch of [{ estimatedHours: 9 }, { assigneeUserId: dev._id }, { dueDate: "2026-12-01" }]) expect((await ana("PATCH", `/api/tasks/${task.id}`, patch)).status).toBe(400);
    expect((await ana("PATCH", `/api/tasks/${task.id}`, { title: "Checklist Item Engine" })).status).toBe(200);
    // La sub con status vacío no existe en tareas padre.
    expect((await ana("POST", "/api/tasks", { projectId: project.id, title: "Otra", status: "done" })).status).toBe(400);
    // Las horas facturables del proyecto salen de las subtareas.
    expect((await ana("GET", `/api/ops/projects/${project.id}`)).body.project.summary.billableHours).toBe(3);
  });

  it("un developer solo cambia status y horas de lo suyo; no crea", async () => {
    const { ana, as, dev, dev2, project } = await world();
    const task = (await ana("POST", "/api/tasks", { projectId: project.id, title: "API" })).body.task;
    const mine = (await ana("POST", "/api/tasks", { projectId: project.id, parentTaskId: task.id, title: "Mía", assigneeUserId: dev._id })).body.task;
    const theirs = (await ana("POST", "/api/tasks", { projectId: project.id, parentTaskId: task.id, title: "De Dora", assigneeUserId: dev2._id })).body.task;
    const diego = await as("dev");
    expect((await diego("PATCH", `/api/tasks/${mine.id}`, { status: "in_progress", investedHours: 2 })).status).toBe(200);
    expect((await diego("PATCH", `/api/tasks/${mine.id}`, { title: "Renombrada" })).status).toBe(403);
    expect((await diego("PATCH", `/api/tasks/${theirs.id}`, { status: "done" })).status).toBe(403);
    expect((await diego("POST", "/api/tasks", { projectId: project.id, title: "Nueva" })).status).toBe(403);
  });

  it("aislamiento: otro equipo no ve ni toca; Comercial lee sin editar", async () => {
    const { ana, as, project } = await world();
    const task = (await ana("POST", "/api/tasks", { projectId: project.id, title: "Privada" })).body.task;
    const olga = await as("olga");
    expect((await olga("GET", "/api/tasks/board")).body.tasks).toEqual([]);
    expect((await olga("PATCH", `/api/tasks/${task.id}`, { title: "X" })).status).toBe(404);
    const marta = await as("marta");
    const board = (await marta("GET", "/api/tasks/board")).body;
    expect(board.tasks.map((t: { title: string }) => t.title)).toEqual(["Privada"]);
    expect(board.projects[0]).toMatchObject({ canManage: false, canWork: false });
    expect((await marta("PATCH", `/api/tasks/${task.id}`, { title: "X" })).status).toBe(403);
  });

  it("borrar una tarea se lleva sus subtareas y deshacer las recupera", async () => {
    const { ana, project } = await world();
    const task = (await ana("POST", "/api/tasks", { projectId: project.id, title: "Padre" })).body.task;
    await ana("POST", "/api/tasks", { projectId: project.id, parentTaskId: task.id, title: "Hija" });
    expect((await ana("DELETE", `/api/tasks/${task.id}`)).status).toBe(200);
    expect((await ana("GET", "/api/tasks/board")).body.tasks).toEqual([]);
    expect((await ana("POST", `/api/tasks/${task.id}/restore`)).status).toBe(200);
    const board = (await ana("GET", "/api/tasks/board")).body;
    expect(board.tasks[0].subtasks.map((s: { title: string }) => s.title)).toEqual(["Hija"]);
  });

  it("actualizaciones de una tarea", async () => {
    const { ana, project } = await world();
    const task = (await ana("POST", "/api/tasks", { projectId: project.id, title: "Con notas" })).body.task;
    expect((await ana("POST", `/api/tasks/${task.id}/updates`, { body: "Bloqueada por el cliente" })).status).toBe(201);
    expect((await ana("GET", `/api/tasks/${task.id}/updates`)).body.updates[0]).toMatchObject({ body: "Bloqueada por el cliente", authorName: "Ana Líder" });
    expect((await ana("GET", "/api/tasks/board")).body.tasks[0].updates).toBe(1);
  });
});

describe("sprints", () => {
  it("numera solo y no reutiliza números; borrar deja las tareas sin sprint y deshacer las devuelve", async () => {
    const { ana, project } = await world();
    const s1 = (await ana("POST", "/api/sprints", { projectId: project.id, name: "Kick-Off", startDate: "2026-11-01", endDate: "2026-11-14" })).body.sprint;
    expect(s1.number).toBe(1);
    expect((await ana("POST", "/api/sprints", { projectId: project.id, name: "Mal", startDate: "2026-11-10", endDate: "2026-11-01" })).status).toBe(400);
    const task = (await ana("POST", "/api/tasks", { projectId: project.id, title: "En sprint", sprintId: s1.id })).body.task;
    expect((await ana("PATCH", `/api/sprints/${s1.id}`, { name: "Kick-Off & PoC" })).body.sprint.name).toBe("Kick-Off & PoC");
    expect((await ana("DELETE", `/api/sprints/${s1.id}`)).body.detached).toBe(1);
    let board = (await ana("GET", "/api/tasks/board")).body;
    expect(board.sprints).toEqual([]);
    expect(board.tasks[0].sprintId).toBeNull();
    const s2 = (await ana("POST", "/api/sprints", { projectId: project.id, name: "Automation", startDate: "2026-11-15", endDate: "2026-11-30" })).body.sprint;
    expect(s2.number).toBe(2);
    await ana("POST", `/api/sprints/${s1.id}/restore`);
    board = (await ana("GET", "/api/tasks/board")).body;
    expect(board.sprints.map((s: { number: number }) => s.number)).toEqual([1, 2]);
    expect(board.tasks.find((t: { id: string }) => t.id === task.id).sprintId).toBe(s1.id);
    // Un sprint de otro proyecto no se puede asignar.
    expect((await ana("POST", "/api/tasks", { projectId: project.id, title: "X", sprintId: "33333333-3333-4333-8333-333333333333" })).status).toBe(400);
  });
});

describe("backlog", () => {
  it("cuenta las tareas sin sprint de los proyectos visibles (no subtareas ni borradas)", async () => {
    const { ana, as, project } = await world();
    const s1 = (await ana("POST", "/api/sprints", { projectId: project.id, name: "MVP", startDate: "2026-11-02", endDate: "2026-11-13" })).body.sprint;
    const loose = (await ana("POST", "/api/tasks", { projectId: project.id, title: "Sin sprint" })).body.task;
    await ana("POST", "/api/tasks", { projectId: project.id, parentTaskId: loose.id, title: "Subtarea" });
    await ana("POST", "/api/tasks", { projectId: project.id, title: "En sprint", sprintId: s1.id });
    const gone = (await ana("POST", "/api/tasks", { projectId: project.id, title: "Borrada" })).body.task;
    await ana("DELETE", `/api/tasks/${gone.id}`);
    expect((await ana("GET", "/api/tasks/backlog-count")).body.count).toBe(1);
    expect((await (await as("olga"))("GET", "/api/tasks/backlog-count")).body.count).toBe(0);
  });
});
