import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createLoginGuard } from "../src/auth/login-guard.js";
import { hashPassword } from "../src/auth/password.js";
import { clearRegisteredSecrets } from "../src/lib/redact.js";
import { dealAmountCents } from "../src/ops/models.js";
import type { AdminStore } from "../src/store/admin-store.js";
import { freshStore, startDb, stopDb } from "./helpers/db.js";
import { createFakes } from "./helpers/fakes.js";
import { OTHER_TEAM_ID, seedUser, TEST_TEAM_ID } from "./helpers/users.js";

const PASSWORD = "correct horse battery staple";
let passwordHash: string;

beforeAll(async () => {
  await startDb();
  passwordHash = await hashPassword(PASSWORD);
});
afterAll(stopDb);
beforeEach(() => clearRegisteredSecrets());

let apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

type App = Awaited<ReturnType<typeof buildApp>>;

async function build(store: AdminStore, { vaultKey, logs }: { vaultKey?: Buffer; logs?: string[] } = {}) {
  const fakes = createFakes(store);
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      logs?.push(String(chunk));
      cb();
    }
  });
  const app = await buildApp({
    store,
    deps: fakes.deps,
    logLevel: logs ? "debug" : "silent",
    logStream,
    vaultKey,
    auth: {
      adminUsername: "jefe",
      adminPasswordHash: passwordHash,
      sessionSecret: "x".repeat(40),
      secureCookies: false,
      loginGuard: createLoginGuard({ maxPerIp: 1000, maxPerUser: 1000 })
    }
  });
  apps.push(app);
  return app;
}

async function login(app: App, username: string) {
  const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: PASSWORD } });
  const cookie = response.cookies.find((c) => c.name === "pp_session");
  return { pp: cookie ? `pp_session=${cookie.value}` : "" };
}

function client(app: App, headers: { cookie: string }) {
  return async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
    const response = await app.inject({ method, url, headers, payload: payload as never });
    let body: unknown;
    try {
      body = response.json();
    } catch {
      body = response.body;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- respuestas JSON variadas en los tests
    return { status: response.statusCode, body: body as Record<string, any>, raw: response.body };
  };
}

/** Equipo A: lead + developer. Equipo B: otro lead. Además un CEO/CCO, un comercial y un finance. */
async function world({ vaultKey, logs }: { vaultKey?: Buffer; logs?: string[] } = {}) {
  const store = await freshStore();
  const app = await build(store, { vaultKey, logs });
  const lead = await seedUser(store, passwordHash, { username: "ana", name: "Ana Líder", role: "lead", teamId: TEST_TEAM_ID });
  const dev = await seedUser(store, passwordHash, { username: "dev", name: "Diego Dev", role: "developer", teamId: TEST_TEAM_ID });
  const dev2 = await seedUser(store, passwordHash, { username: "dev2", name: "Dora Dev", role: "developer", teamId: TEST_TEAM_ID });
  await seedUser(store, passwordHash, { username: "olga", name: "Olga Otra", role: "lead", teamId: OTHER_TEAM_ID, teamName: "Equipo B" });
  await seedUser(store, passwordHash, { username: "marta", name: "Marta Marketing", role: "commercial", teamId: null });
  await seedUser(store, passwordHash, { username: "fede", name: "Fede Finanzas", role: "finance", teamId: null });
  const as = async (username: string) => client(app, { cookie: (await login(app, username)).pp });
  return { store, app, as, lead, dev, dev2 };
}

async function newProject(api: Awaited<ReturnType<Awaited<ReturnType<typeof world>>["as"]>>, extra: Record<string, unknown> = {}) {
  const created = await api("POST", "/api/ops/projects", { name: "Manpersa", customerName: "Manpersa SAC", ...extra });
  expect(created.status).toBe(201);
  return created.body.project as { id: string };
}

describe("roles nuevos", () => {
  it("el CEO/CCO da de alta un comercial y un finance sin equipo", async () => {
    const { as, store } = await world();
    const boss = await as("jefe");
    for (const role of ["commercial", "finance"]) {
      const created = await boss("POST", "/api/admin/users", { username: `u-${role}`, name: `Persona ${role}`, role });
      expect(created.status).toBe(201);
    }
    expect((await store.users.findOne({ username: "u-commercial" }))?.teamId).toBeNull();
    const lead = await boss("POST", "/api/admin/users", { username: "sinequipo", name: "Sin Equipo", role: "lead" });
    expect(lead.status).toBe(400);
  });
});

describe("proyectos operativos", () => {
  it("el Team Leader crea en su equipo con los valores por defecto y queda auditado", async () => {
    const { as, store, lead } = await world();
    const ana = await as("ana");
    const created = await ana("POST", "/api/ops/projects", { name: "Manpersa", customerName: "Manpersa SAC", developerUserId: (await store.users.findOne({ username: "dev" }))!._id });
    expect(created.status).toBe(201);
    expect(created.body.project).toMatchObject({ stage: "kickoff", health: "neutral", priority: "medium", sentimentScore: 55, team: { id: TEST_TEAM_ID }, lead: { id: lead._id, name: "Ana Líder" }, developer: { name: "Diego Dev" } });
    expect(await store.auditLog.countDocuments({ action: "ops.project_created", actor: "ana" })).toBe(1);
  });

  it("un developer no crea proyectos; el CEO/CCO debe elegir equipo", async () => {
    const { as } = await world();
    expect((await (await as("dev"))("POST", "/api/ops/projects", { name: "Nuevo proyecto", customerName: "Cliente" })).status).toBe(403);
    const boss = await as("jefe");
    expect((await boss("POST", "/api/ops/projects", { name: "Nuevo proyecto", customerName: "Cliente" })).status).toBe(400);
    expect((await boss("POST", "/api/ops/projects", { name: "Nuevo proyecto", customerName: "Cliente", teamId: TEST_TEAM_ID })).status).toBe(201);
  });

  it("rechaza responsables de otro equipo o con otro rol", async () => {
    const { as, store } = await world();
    const ana = await as("ana");
    const olga = (await store.users.findOne({ username: "olga" }))!;
    const dev = (await store.users.findOne({ username: "dev" }))!;
    expect((await ana("POST", "/api/ops/projects", { name: "Proyecto X", customerName: "Cliente", leadUserId: olga._id })).status).toBe(400);
    expect((await ana("POST", "/api/ops/projects", { name: "Proyecto X", customerName: "Cliente", leadUserId: dev._id })).status).toBe(400);
  });

  it("aislamiento: otro equipo no lo ve (404); comercial y finance lo leen pero no lo cambian", async () => {
    const { as } = await world();
    const project = await newProject(await as("ana"));
    const olga = await as("olga");
    expect((await olga("GET", `/api/ops/projects/${project.id}`)).status).toBe(404);
    expect((await olga("GET", "/api/ops/projects")).body.rows).toHaveLength(0);
    expect((await olga("PATCH", `/api/ops/projects/${project.id}`, { priority: "low" })).status).toBe(404);

    for (const username of ["marta", "fede"]) {
      const api = await as(username);
      expect((await api("GET", `/api/ops/projects/${project.id}`)).status).toBe(200);
      expect((await api("GET", "/api/ops/projects")).body.rows).toHaveLength(1);
      expect((await api("PATCH", `/api/ops/projects/${project.id}`, { priority: "low" })).status).toBe(403);
      expect((await api("POST", `/api/ops/projects/${project.id}/tasks`, { title: "No debería poder" })).status).toBe(403);
    }
  });

  it("cambiar etapa, health o prioridad deja una novedad del sistema y auditoría; el Sentiment sale del Health", async () => {
    const { as, store } = await world();
    const ana = await as("ana");
    const project = await newProject(ana);
    const patched = await ana("PATCH", `/api/ops/projects/${project.id}`, { stage: "structure", health: "at_risk", priority: "critical" });
    expect(patched.status).toBe(200);
    expect(patched.body.project).toMatchObject({ stage: "structure", health: "at_risk", priority: "critical", sentimentScore: 20 });
    const updates = (await ana("GET", `/api/ops/projects/${project.id}/updates`)).body.updates as { kind: string; body: string }[];
    const system = updates.find((u) => u.kind === "system" && u.body.includes("Etapa"));
    expect(system?.body).toContain("Kick Off → Estructura");
    expect(system?.body).toContain("Health: Neutral → At Risk (Sentiment 55 → 20)");
    expect(await store.auditLog.countDocuments({ action: "ops.project_updated" })).toBe(1);
    // Filtros del listado.
    expect((await ana("GET", "/api/ops/projects?health=at_risk")).body.rows).toHaveLength(1);
    expect((await ana("GET", "/api/ops/projects?health=happy")).body.rows).toHaveLength(0);
  });

  it("valida etapa, health y prioridad; el Sentiment no se escribe a mano", async () => {
    const { as } = await world();
    const ana = await as("ana");
    const project = await newProject(ana);
    for (const patch of [{ stage: "otra" }, { health: "ok" }, { priority: "urgent" }, { sentimentScore: 40 }, {}]) {
      expect((await ana("PATCH", `/api/ops/projects/${project.id}`, patch)).status).toBe(400);
    }
  });

  it("un developer puede escribir novedades, pero no editar el proyecto", async () => {
    const { as } = await world();
    const project = await newProject(await as("ana"));
    const dev = await as("dev");
    expect((await dev("PATCH", `/api/ops/projects/${project.id}`, { stage: "structure" })).status).toBe(403);
    const posted = await dev("POST", `/api/ops/projects/${project.id}/updates`, { body: "Se terminó la estructura de datos." });
    expect(posted.status).toBe(201);
    expect(posted.body.update).toMatchObject({ kind: "manual", authorName: "Diego Dev" });
  });
});

describe("deals en el proyecto", () => {
  it("el monto lo calcula el servidor y el proyecto suma las horas de sus deals aprobados", async () => {
    const { as } = await world();
    const ana = await as("ana");
    const project = await newProject(ana);
    expect((await ana("POST", "/api/deals", { projectId: project.id, title: "Módulo de pedidos", hours: 40, rateCents: 2500, amountCents: 1 })).status).toBe(400);
    const created = await ana("POST", "/api/deals", { projectId: project.id, title: "Módulo de pedidos", hours: 40.5, rateCents: 2500 });
    expect(created.status).toBe(201);
    expect(created.body.deal).toMatchObject({ hours: 40.5, rateCents: 2500, amountCents: dealAmountCents(40.5, 2500), currency: "USD", status: "draft" });
    const edited = await ana("PATCH", `/api/deals/${created.body.deal.id}`, { hours: 50, status: "approved" });
    expect(edited.body.deal.amountCents).toBe(125_000);
    await ana("POST", "/api/deals", { projectId: project.id, title: "Borrador sin aprobar", hours: 10, rateCents: 2500 });
    const [row] = (await ana("GET", "/api/ops/projects")).body.rows;
    // Horas vendidas: solo los deals aprobados en adelante.
    expect(row.summary).toMatchObject({ deals: 2, soldHours: 50, amountCents: 125_000, billableHours: 0, billableVsSold: -50 });
  });
});

describe("tareas", () => {
  it("se ligan a un deal del mismo proyecto y a alguien del equipo", async () => {
    const { as, store } = await world();
    const ana = await as("ana");
    const project = await newProject(ana);
    const other = await newProject(ana, { name: "Otro proyecto" });
    const deal = (await ana("POST", "/api/deals", { projectId: other.id, title: "Módulo ajeno", hours: 5, rateCents: 100 })).body.deal;
    const dev = (await store.users.findOne({ username: "dev" }))!;
    const olga = (await store.users.findOne({ username: "olga" }))!;
    expect((await ana("POST", `/api/ops/projects/${project.id}/tasks`, { title: "Tarea con deal ajeno", dealId: deal.id })).status).toBe(400);
    expect((await ana("POST", `/api/ops/projects/${project.id}/tasks`, { title: "Tarea para otra persona", assigneeUserId: olga._id })).status).toBe(400);
    const ownDeal = (await ana("POST", "/api/deals", { projectId: project.id, title: "Módulo propio", hours: 5, rateCents: 100 })).body.deal;
    const ok = await ana("POST", `/api/ops/projects/${project.id}/tasks`, { title: "Pantalla de pedidos", dealId: ownDeal.id, assigneeUserId: dev._id, estimatedHours: 6 });
    expect(ok.status).toBe(201);
    expect((await ana("GET", `/api/ops/projects/${project.id}/tasks`)).body.tasks[0]).toMatchObject({ assigneeName: "Diego Dev", dealId: ownDeal.id });
  });

  it("completar fija completedAt y reabrir lo quita", async () => {
    const { as } = await world();
    const ana = await as("ana");
    const project = await newProject(ana);
    const task = (await ana("POST", `/api/ops/projects/${project.id}/tasks`, { title: "Primera tarea" })).body.task;
    const done = await ana("PATCH", `/api/ops/projects/${project.id}/tasks/${task.id}`, { status: "done" });
    expect(done.body.task.completedAt).toBeTruthy();
    const reopened = await ana("PATCH", `/api/ops/projects/${project.id}/tasks/${task.id}`, { status: "in_progress" });
    expect(reopened.body.task.completedAt).toBeNull();
  });

  it("un developer solo cambia el estado de sus propias tareas", async () => {
    const { as, dev, dev2 } = await world();
    const ana = await as("ana");
    const project = await newProject(ana);
    const mine = (await ana("POST", `/api/ops/projects/${project.id}/tasks`, { title: "Tarea de Diego", assigneeUserId: dev._id })).body.task;
    const theirs = (await ana("POST", `/api/ops/projects/${project.id}/tasks`, { title: "Tarea de Dora", assigneeUserId: dev2._id })).body.task;
    const diego = await as("dev");
    expect((await diego("PATCH", `/api/ops/projects/${project.id}/tasks/${mine.id}`, { status: "review" })).status).toBe(200);
    expect((await diego("PATCH", `/api/ops/projects/${project.id}/tasks/${mine.id}`, { title: "Cambio de título" })).status).toBe(403);
    expect((await diego("PATCH", `/api/ops/projects/${project.id}/tasks/${theirs.id}`, { status: "done" })).status).toBe(403);
  });
});

describe("vault de cuentas", () => {
  it("sin clave configurada responde 503 y el resto de Operativa sigue funcionando", async () => {
    const { as } = await world();
    const ana = await as("ana");
    const project = await newProject(ana);
    expect((await ana("GET", `/api/ops/projects/${project.id}/accounts`)).status).toBe(503);
    expect((await ana("GET", `/api/ops/projects/${project.id}`)).status).toBe(200);
  });

  it("el valor se guarda cifrado, no sale en listados ni logs, y revelarlo queda auditado", async () => {
    const logs: string[] = [];
    const { as, store } = await world({ vaultKey: randomBytes(32), logs });
    const ana = await as("ana");
    const project = await newProject(ana);
    const secret = "Zq9-clave-MUY-secreta-4471";
    const created = await ana("POST", `/api/ops/projects/${project.id}/accounts`, { label: "Panel de hosting", kind: "web", url: "https://hosting.example.com", username: "admin@cliente.pe", secret });
    expect(created.status).toBe(201);
    expect(created.body.account).toMatchObject({ label: "Panel de hosting", credentialSet: true });
    expect(created.raw).not.toContain(secret);

    const stored = await store.vaultAccounts.findOne({ _id: created.body.account.id });
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(stored?.sealed?.ciphertext).toBeTruthy();

    const listed = await ana("GET", `/api/ops/projects/${project.id}/accounts`);
    expect(listed.raw).not.toContain(secret);
    expect(listed.body.accounts[0]).toMatchObject({ username: "admin@cliente.pe", credentialSet: true });

    // Revelar: el equipo puede, queda auditado y la respuesta no se cachea.
    const dev = await as("dev");
    const revealed = await dev("POST", `/api/ops/projects/${project.id}/accounts/${created.body.account.id}/reveal`);
    expect(revealed.status).toBe(200);
    expect(revealed.body).toMatchObject({ username: "admin@cliente.pe", credential: secret });
    expect(await store.auditLog.countDocuments({ action: "ops.account_revealed", actor: "dev" })).toBe(1);
    expect(JSON.stringify(await store.auditLog.find().toArray())).not.toContain(secret);
    expect(logs.join("")).not.toContain(secret);
  });

  it("rotar cambia el valor y la fecha; otro equipo, comercial y finance no ven las cuentas", async () => {
    const { as } = await world({ vaultKey: randomBytes(32) });
    const ana = await as("ana");
    const project = await newProject(ana);
    const account = (await ana("POST", `/api/ops/projects/${project.id}/accounts`, { label: "Correo", kind: "email", secret: "primera-clave-123" })).body.account;
    const rotated = await ana("PATCH", `/api/ops/projects/${project.id}/accounts/${account.id}`, { secret: "segunda-clave-456" });
    expect(rotated.status).toBe(200);
    expect(rotated.body.account.rotatedAt).toBeTruthy();
    const again = await ana("POST", `/api/ops/projects/${project.id}/accounts/${account.id}/reveal`);
    expect(again.body.credential).toBe("segunda-clave-456");

    expect((await (await as("olga"))("GET", `/api/ops/projects/${project.id}/accounts`)).status).toBe(404);
    for (const username of ["marta", "fede"]) {
      const api = await as(username);
      expect((await api("GET", `/api/ops/projects/${project.id}/accounts`)).status).toBe(403);
      expect((await api("POST", `/api/ops/projects/${project.id}/accounts/${account.id}/reveal`)).status).toBe(403);
    }
    // Un developer ve y revela, pero no crea ni borra.
    const dev = await as("dev");
    expect((await dev("POST", `/api/ops/projects/${project.id}/accounts`, { label: "Otra", kind: "web" })).status).toBe(403);
    expect((await dev("DELETE", `/api/ops/projects/${project.id}/accounts/${account.id}`)).status).toBe(403);
  });

  it("un valor cifrado en un proyecto no se descifra en otro (contexto autenticado)", async () => {
    const { as, store } = await world({ vaultKey: randomBytes(32) });
    const ana = await as("ana");
    const a = await newProject(ana);
    const b = await newProject(ana, { name: "Segundo proyecto" });
    const account = (await ana("POST", `/api/ops/projects/${a.id}/accounts`, { label: "Correo", kind: "email", secret: "clave-del-proyecto-a" })).body.account;
    // Alguien con acceso a la base mueve el documento al otro proyecto.
    await store.vaultAccounts.updateOne({ _id: account.id }, { $set: { projectId: b.id } });
    const moved = await ana("POST", `/api/ops/projects/${b.id}/accounts/${account.id}/reveal`);
    expect(moved.status).toBe(500);
    expect(moved.raw).not.toContain("clave-del-proyecto-a");
  });
});

describe("reuniones y novedades", () => {
  it("registra reuniones manuales, evita duplicar la de un mismo origen y guarda el feedback", async () => {
    const { as } = await world();
    const ana = await as("ana");
    const project = await newProject(ana);
    const base = { title: "Kick Off con Manpersa", heldAt: "2026-10-28T15:00:00-05:00", source: "read_ai", externalId: "read-123", transcript: "…transcripción…" };
    const pending = await ana("POST", `/api/ops/projects/${project.id}/meetings`, base);
    expect(pending.status).toBe(201);
    expect(pending.body.meeting).toMatchObject({ status: "pending", transcriptLength: base.transcript.length });
    expect((await ana("POST", `/api/ops/projects/${project.id}/meetings`, base)).status).toBe(409);
    const processed = await ana("POST", `/api/ops/projects/${project.id}/meetings`, { title: "Revisión semanal", heldAt: "2026-10-29T10:00:00-05:00", summary: "Todo en orden.", feedback: ["Quieren reportes semanales."], actionItems: ["Enviar plan"] });
    expect(processed.body.meeting).toMatchObject({ status: "processed", source: "manual", feedback: ["Quieren reportes semanales."] });
    const list = (await ana("GET", `/api/ops/projects/${project.id}/meetings`)).body.meetings;
    expect(list).toHaveLength(2);
    expect(list[0].transcript).toBeUndefined();
    const detail = await ana("GET", `/api/ops/projects/${project.id}/meetings/${pending.body.meeting.id}`);
    expect(detail.body.meeting.transcript).toBe("…transcripción…");
  });
});
