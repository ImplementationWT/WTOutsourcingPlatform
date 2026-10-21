import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { backfillAiCosts } from "../src/ai/backfill.js";
import { csvCell } from "../src/ai/costs.js";
import { buildApp } from "../src/app.js";
import { createLoginGuard } from "../src/auth/login-guard.js";
import { hashPassword } from "../src/auth/password.js";
import { JobEngine } from "../src/jobs/engine.js";
import { clearRegisteredSecrets } from "../src/lib/redact.js";
import type { AdminStore } from "../src/store/admin-store.js";
import type { AiSessionDoc } from "../src/store/models.js";
import { freshStore, startDb, stopDb } from "./helpers/db.js";
import { FakeAgent } from "./helpers/fake-agent.js";
import { createFakes, silent } from "./helpers/fakes.js";
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

async function build(store: AdminStore, extra: { agent?: FakeAgent; logs?: string[] } = {}) {
  const fakes = createFakes(store);
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      extra.logs?.push(String(chunk));
      cb();
    }
  });
  const app = await buildApp({
    store,
    deps: fakes.deps,
    logLevel: extra.logs ? "debug" : "silent",
    logStream,
    auth: {
      adminUsername: "jefe",
      adminPasswordHash: passwordHash,
      sessionSecret: "x".repeat(40),
      secureCookies: false,
      // Sin el límite por IP: aquí se prueba el bloqueo persistente por usuario.
      loginGuard: createLoginGuard({ maxPerIp: 1000, maxPerUser: 1000 })
    },
    ai: extra.agent ? { agent: extra.agent, config: { sessionBudgetCents: 1000, workspace: "default" } } : undefined
  });
  apps.push(app);
  return { app, ...fakes };
}

async function login(app: App, username: string, password = PASSWORD) {
  const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  const cookie = response.cookies.find((c) => c.name === "pp_session");
  return { status: response.statusCode, body: response.json(), headers: { cookie: cookie ? `pp_session=${cookie.value}` : "" } };
}

function client(app: App, headers: { cookie: string }) {
  return async (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
    const response = await app.inject({ method, url, headers, payload: payload as never });
    let body: unknown;
    try {
      body = response.json();
    } catch {
      body = response.body;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- respuestas JSON variadas en los tests
    return { status: response.statusCode, body: body as Record<string, any>, raw: response.body, headers: response.headers };
  };
}

/** Dos equipos (A y B), un CEO/CCO, un lead y un developer en A y un lead en B. */
async function world({ agent }: { agent?: FakeAgent } = {}) {
  const store = await freshStore();
  const built = await build(store, { agent });
  await seedUser(store, passwordHash, { username: "admin", name: "Ana Líder", role: "lead", teamId: TEST_TEAM_ID });
  await seedUser(store, passwordHash, { username: "dev", name: "Diego Dev", role: "developer", teamId: TEST_TEAM_ID });
  await seedUser(store, passwordHash, { username: "otro", name: "Olga Otra", role: "lead", teamId: OTHER_TEAM_ID, teamName: "Equipo B" });
  const as = async (username: string) => client(built.app, (await login(built.app, username)).headers);
  return { store, ...built, as };
}

async function provision(store: AdminStore, deps: ReturnType<typeof createFakes>["deps"], slug: string, teamId: string | null) {
  const job = await store.createClientWithJob({ teamId, slug, name: slug, description: "Proyecto de prueba", actor: "admin" });
  expect((await new JobEngine(store, deps, silent).run(job._id, "admin"))?.status).toBe("succeeded");
}

describe("migración de la cuenta admin", () => {
  it("la cuenta de la configuración pasa a ser un CEO/CCO una sola vez (idempotente)", async () => {
    const store = await freshStore();
    await build(store);
    await build(store);
    const users = await store.users.find().toArray();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ username: "jefe", role: "boss", teamId: null, active: true, mustChangePassword: false, passwordHash });
    expect(await store.auditLog.countDocuments({ action: "user.migrated_from_config" })).toBe(1);

    // Entra con su misma contraseña, como CEO/CCO.
    const { app } = await build(store);
    const session = await login(app, "JEFE");
    expect(session.status).toBe(200);
    expect(session.body.user).toMatchObject({ username: "jefe", role: "boss", teamId: null });
  });
});

describe("login individual", () => {
  it("credenciales propias; la sesión lleva usuario, rol y equipo; logout la cierra", async () => {
    const { app } = await world();
    expect((await login(app, "admin", "mala-contraseña")).status).toBe(401);
    const session = await login(app, "Admin");
    expect(session.status).toBe(200);
    expect(session.body.user).toMatchObject({ username: "admin", name: "Ana Líder", role: "lead", teamId: TEST_TEAM_ID });
    expect(session.body.user.passwordHash).toBeUndefined();
    const api = client(app, session.headers);
    expect((await api("GET", "/api/auth/me")).body.user).toMatchObject({ role: "lead", teamId: TEST_TEAM_ID });
  });

  it("bloquea la cuenta tras 5 fallos seguidos, aunque después acierte", async () => {
    const { app, store } = await world();
    for (let i = 0; i < 4; i++) expect((await login(app, "dev", "no-es-esta")).status).toBe(401);
    expect((await login(app, "dev", "no-es-esta")).status).toBe(429);
    expect((await login(app, "dev")).status).toBe(429);
    expect(await store.auditLog.countDocuments({ action: "user.locked", target: "dev" })).toBe(1);
  });

  it("primer ingreso: obliga a cambiar la contraseña antes de usar el panel", async () => {
    const { app, as } = await world();
    const boss = await as("jefe");
    const created = await boss("POST", "/api/admin/users", { username: "nuevo", name: "Nora Nueva", role: "developer", teamId: TEST_TEAM_ID });
    expect(created.status).toBe(201);
    const temporary = created.body.temporaryPassword as string;
    expect(temporary.length).toBeGreaterThanOrEqual(16);

    const first = await login(app, "nuevo", temporary);
    expect(first.body.user.mustChangeCredentials).toBe(true);
    const api = client(app, first.headers);
    const blocked = await api("GET", "/api/projects");
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("password_change_required");

    expect((await api("POST", "/api/auth/password", { current: temporary, next: "corta" })).status).toBe(400);
    expect((await api("POST", "/api/auth/password", { current: "otra", next: "una contraseña larga" })).status).toBe(400);
    const changed = await api("POST", "/api/auth/password", { current: temporary, next: "una contraseña larga" });
    expect(changed.status).toBe(200);
    expect(changed.body.user.mustChangeCredentials).toBe(false);
    expect((await api("GET", "/api/projects")).status).toBe(200);
    expect((await login(app, "nuevo", temporary)).status).toBe(401);
    expect((await login(app, "nuevo", "una contraseña larga")).status).toBe(200);
  });
});

describe("roles", () => {
  it("el CEO/CCO tiene todos los permisos: crea en el equipo que elija y usa el AI Developer en cualquier proyecto", async () => {
    const agent = new FakeAgent();
    const { store, deps, as } = await world({ agent });
    await provision(store, deps, "acme-crm", OTHER_TEAM_ID);
    const boss = await as("jefe");

    // Sin equipo elegido no crea; con equipo, el proyecto queda en ese equipo.
    expect((await boss("POST", "/api/clients", { name: "Beta Shop", slug: "beta-shop", description: "Tienda en línea de Beta" })).status).toBe(400);
    const created = await boss("POST", "/api/clients", { name: "Beta Shop", slug: "beta-shop", description: "Tienda en línea de Beta", teamId: TEST_TEAM_ID });
    expect(created.status, created.raw).toBe(202);
    expect((await store.getClient("beta-shop"))?.teamId).toBe(TEST_TEAM_ID);
    expect((await boss("POST", "/api/clients", { name: "Gamma", slug: "gamma", description: "Proyecto de prueba", teamId: "33333333-3333-4333-8333-333333333333" })).status).toBe(400);

    // AI Developer y operaciones en un proyecto de cualquier equipo.
    const started = await boss("POST", "/api/clients/acme-crm/ai/sessions", { title: "Cambiar el logo" });
    expect(started.status, started.raw).toBe(201);
    expect((await store.aiSessions.findOne({ _id: started.body.session.id }))).toMatchObject({ teamId: OTHER_TEAM_ID, createdBy: "jefe" });
    expect((await boss("POST", `/api/ai/sessions/${started.body.session.id}/close`)).status).toBe(200);
    expect((await boss("POST", "/api/clients/acme-crm/redeploy")).status).not.toBe(403);
    expect((await boss("POST", "/api/servers", {})).status).toBe(400);
  });

  it("solo los CEO/CCO administran usuarios y equipos", async () => {
    const { as } = await world();
    const lead = await as("admin");
    expect((await lead("GET", "/api/teams")).body.teams).toEqual([{ id: TEST_TEAM_ID, name: "Equipo A" }]);
    const dev = await as("dev");
    for (const api of [lead, dev]) {
      expect((await api("GET", "/api/admin/users")).status).toBe(403);
      expect((await api("POST", "/api/admin/teams", { name: "Equipo C" })).status).toBe(403);
    }
    const boss = await as("jefe");
    expect((await boss("GET", "/api/teams")).body.teams.map((t: { name: string }) => t.name)).toEqual(["Equipo A", "Equipo B"]);
    expect((await boss("GET", "/api/admin/users")).body.users.map((u: { username: string }) => u.username).sort()).toEqual(["admin", "dev", "jefe", "otro"]);
    expect(JSON.stringify((await boss("GET", "/api/admin/users")).body)).not.toContain("scrypt$");
  });

  it("team leaders y developers crean proyectos en su equipo", async () => {
    const { store, as } = await world();
    const dev = await as("dev");
    const created = await dev("POST", "/api/clients", { name: "Beta Shop", slug: "beta-shop", description: "Tienda en línea de Beta", teamId: OTHER_TEAM_ID });
    expect(created.status).toBe(202);
    expect((await store.getClient("beta-shop"))?.teamId).toBe(TEST_TEAM_ID);
    // El developer no elige equipo: se ignora el que mande y queda en el suyo.
    expect((await store.getClient("beta-shop"))?.teamId).toBe(TEST_TEAM_ID);
    // El identificador es único en toda la plataforma: desde otro equipo también está ocupado.
    const other = await as("otro");
    expect((await other("POST", "/api/clients", { name: "Beta Shop", slug: "beta-shop", description: "Tienda en línea de Beta" })).status).toBe(409);
    expect((await other("GET", "/api/clients/beta-shop")).status).toBe(404);
  });
});

describe("aislamiento entre equipos", () => {
  it("un proyecto de otro equipo no aparece y responde 404 (también AI Developer e integraciones)", async () => {
    const agent = new FakeAgent();
    const { store, deps, as } = await world({ agent });
    await provision(store, deps, "acme-crm", TEST_TEAM_ID);
    await provision(store, deps, "beta-shop", OTHER_TEAM_ID);
    await provision(store, deps, "viejo", null);

    const lead = await as("admin");
    const projects = (await lead("GET", "/api/projects")).body.projects.map((p: { clientId: string }) => p.clientId);
    expect(projects).toEqual(["acme-crm"]);
    const dashboard = (await lead("GET", "/api/dashboard")).body;
    expect(dashboard.projects.map((p: { id: string }) => p.id)).toEqual(["acme-crm"]);
    expect(dashboard.activity.every((a: { clientId: string }) => a.clientId === "acme-crm")).toBe(true);

    for (const slug of ["beta-shop", "viejo"]) {
      for (const [method, url] of [
        ["GET", `/api/clients/${slug}`],
        ["POST", `/api/clients/${slug}/redeploy`],
        ["GET", `/api/clients/${slug}/ai/sessions`],
        ["POST", `/api/clients/${slug}/ai/sessions`],
        ["PUT", `/api/clients/${slug}/integrations/monday`]
      ] as const) {
        const payload = method === "POST" && url.endsWith("sessions") ? { title: "Intento" } : method === "PUT" ? { credentials: { apiToken: "x".repeat(40) } } : {};
        const response = await lead(method, url, payload);
        expect(response.status, `${method} ${url}`).toBe(404);
      }
    }

    // Sesión del AI Developer de otro equipo: 404 por id.
    const otherLead = await as("otro");
    const started = await otherLead("POST", "/api/clients/beta-shop/ai/sessions", { title: "Cambiar el logo" });
    expect(started.status, started.raw).toBe(201);
    expect((await lead("GET", `/api/ai/sessions/${started.body.session.id}`)).status).toBe(404);
    expect((await lead("POST", `/api/ai/sessions/${started.body.session.id}/close`)).status).toBe(404);

    // El CEO/CCO ve todo, también los proyectos sin equipo, y puede acotar a un equipo.
    const boss = await as("jefe");
    expect((await boss("GET", "/api/dashboard")).body.projects.map((p: { id: string }) => p.id).sort()).toEqual(["acme-crm", "beta-shop", "viejo"]);
    expect((await boss("GET", `/api/dashboard?teamId=${OTHER_TEAM_ID}`)).body.projects.map((p: { id: string }) => p.id)).toEqual(["beta-shop"]);
    expect((await boss("GET", "/api/clients/viejo")).status).toBe(200);
    expect((await boss("GET", `/api/ai/sessions/${started.body.session.id}`)).status).toBe(200);
  });

  it("el CEO/CCO asigna o mueve proyectos entre equipos", async () => {
    const { store, deps, as } = await world();
    await provision(store, deps, "viejo", null);
    const lead = await as("admin");
    expect((await lead("GET", "/api/clients/viejo")).status).toBe(404);
    const boss = await as("jefe");
    expect((await boss("POST", "/api/admin/clients/viejo/team", { teamId: TEST_TEAM_ID })).status).toBe(200);
    expect((await lead("GET", "/api/clients/viejo")).status).toBe(200);
    expect((await boss("GET", "/api/clients/viejo")).body.client.team).toEqual({ id: TEST_TEAM_ID, name: "Equipo A" });
    expect(await store.auditLog.findOne({ action: "client.team_changed" })).toMatchObject({ actor: "jefe", clientId: "viejo", details: { from: "", to: TEST_TEAM_ID } });
  });

  it("desactivar o cambiar de equipo a un usuario tiene efecto inmediato", async () => {
    const { store, deps, as } = await world();
    await provision(store, deps, "acme-crm", TEST_TEAM_ID);
    const dev = await as("dev");
    expect((await dev("GET", "/api/clients/acme-crm")).status).toBe(200);
    const boss = await as("jefe");
    const devId = (await store.users.findOne({ username: "dev" }))!._id;
    expect((await boss("PATCH", `/api/admin/users/${devId}`, { teamId: OTHER_TEAM_ID })).status).toBe(200);
    expect((await dev("GET", "/api/clients/acme-crm")).status).toBe(404);
    expect((await boss("PATCH", `/api/admin/users/${devId}`, { active: false })).status).toBe(200);
    expect((await dev("GET", "/api/clients/acme-crm")).status).toBe(401);
    expect((await boss("POST", `/api/admin/users/${devId}/reset-password`)).body.temporaryPassword).toBeTruthy();
  });

  it("un CEO/CCO no puede quitarse el rol ni dejar la plataforma sin CEO/CCO", async () => {
    const { store, as } = await world();
    const boss = await as("jefe");
    const bossId = (await store.users.findOne({ username: "jefe" }))!._id;
    expect((await boss("PATCH", `/api/admin/users/${bossId}`, { active: false })).status).toBe(400);
    expect((await boss("PATCH", `/api/admin/users/${bossId}`, { role: "lead", teamId: TEST_TEAM_ID })).status).toBe(400);
  });
});

describe("auditoría", () => {
  it("cada evento lleva el nombre real y el equipo de quien lo hizo, también los ai.*", async () => {
    const agent = new FakeAgent();
    const { store, deps, as } = await world({ agent });
    await provision(store, deps, "acme-crm", TEST_TEAM_ID);
    const dev = await as("dev");
    const started = await dev("POST", "/api/clients/acme-crm/ai/sessions", { title: "Arreglar el formulario", message: "Hola" });
    expect(started.status, started.raw).toBe(201);
    const started2 = await store.auditLog.findOne({ action: "ai.session_started" });
    expect(started2).toMatchObject({ actor: "dev", actorName: "Diego Dev", actorTeamId: TEST_TEAM_ID });
    expect(await store.auditLog.findOne({ action: "ai.message_sent" })).toMatchObject({ actorName: "Diego Dev", actorTeamId: TEST_TEAM_ID });
    // El agente sabe quién le escribe.
    expect(agent.systemMessages[0].text).toContain("Diego Dev");
  });

  it("las contraseñas temporales no aparecen en los logs", async () => {
    const store = await freshStore();
    const logs: string[] = [];
    const { app } = await build(store, { logs });
    const boss = client(app, (await login(app, "jefe")).headers);
    await boss("POST", "/api/admin/teams", { name: "Equipo A" });
    const team = (await boss("GET", "/api/admin/teams")).body.teams[0];
    const created = await boss("POST", "/api/admin/users", { username: "ana", name: "Ana", role: "lead", teamId: team.id });
    const reset = await boss("POST", `/api/admin/users/${created.body.user.id}/reset-password`);
    expect((await boss("PATCH", `/api/admin/teams/${team.id}`, { leadUserId: created.body.user.id })).status).toBe(200);
    const all = logs.join("\n");
    expect(all).not.toContain(created.body.temporaryPassword);
    expect(all).not.toContain(reset.body.temporaryPassword);
    expect(all).not.toContain(PASSWORD);
    expect(JSON.stringify(await store.auditLog.find().toArray())).not.toContain(reset.body.temporaryPassword);
  });
});

function session(overrides: Partial<AiSessionDoc>): AiSessionDoc {
  const at = overrides.createdAt ?? new Date("2026-09-10T12:00:00Z");
  return {
    _id: randomUUID(),
    clientId: "acme-crm",
    title: "Sesión",
    status: "closed",
    agentSessionId: `sesn_${randomUUID()}`,
    repoResourceId: "res",
    repository: "acme-crm-app",
    branch: "claude-develop",
    baseBranch: "main",
    baseSha: "a".repeat(40),
    createdBy: "admin",
    createdAt: at,
    updatedAt: at,
    teamId: TEST_TEAM_ID,
    costCents: 0,
    ...overrides
  };
}

describe("costos del AI Developer", () => {
  it("acumula el costo de la sesión sin duplicar (eventos acumulados, repetidos en historial y stream)", async () => {
    const agent = new FakeAgent();
    const { store, deps, as } = await world({ agent });
    await provision(store, deps, "acme-crm", TEST_TEAM_ID);
    const dev = await as("dev");
    const started = await dev("POST", "/api/clients/acme-crm/ai/sessions", { title: "Arreglar el formulario" });
    const doc = (await store.aiSessions.findOne({ _id: started.body.session.id }))!;
    expect(doc).toMatchObject({ startedByUserId: expect.any(String), teamId: TEST_TEAM_ID, costCents: 0, budgetCents: 1000 });

    agent.emit(doc.agentSessionId, { type: "session.usage", usage: { list_cost: { amount: "120", currency: "usd" } } });
    agent.emit(doc.agentSessionId, { type: "session.usage", usage: { list_cost: { amount: "250", currency: "usd" } } });
    agent.emit(doc.agentSessionId, { type: "session.usage", usage: { list_cost: { amount: "250", currency: "usd" } } });
    const controller = new AbortController();
    const seen = [];
    for await (const event of apps[0].aiDeveloper!.events(doc, controller.signal)) {
      seen.push(event);
      if (seen.length >= 3) break;
    }
    controller.abort();
    // Una segunda lectura del historial no suma otra vez.
    const again = new AbortController();
    for await (const event of apps[0].aiDeveloper!.events((await store.aiSessions.findOne({ _id: doc._id }))!, again.signal)) {
      if (event.kind === "cost") break;
    }
    again.abort();
    expect((await store.aiSessions.findOne({ _id: doc._id }))?.costCents).toBe(250);

    // Al cerrar se toma el gasto final del agente.
    agent.sessions.get(doc.agentSessionId)!.costCents = 310;
    expect((await dev("POST", `/api/ai/sessions/${doc._id}/close`)).status).toBe(200);
    expect((await store.aiSessions.findOne({ _id: doc._id }))?.costCents).toBe(310);
    // Un valor menor (p. ej. un evento antiguo) no lo reduce.
    await apps[0].aiDeveloper!.recordCost(doc, 100);
    expect((await store.aiSessions.findOne({ _id: doc._id }))?.costCents).toBe(310);

    // Borrar la conversación no borra su costo.
    expect((await dev("POST", `/api/ai/sessions/${doc._id}/delete`)).status).toBe(200);
    expect((await dev("GET", "/api/costs/summary")).body.totals.costCents).toBe(310);
  });

  async function costWorld() {
    const { store, as } = await world();
    const ids = Object.fromEntries((await store.users.find().toArray()).map((u) => [u.username, u._id]));
    await store.teams.updateOne({ _id: OTHER_TEAM_ID }, { $set: { name: "Equipo B" } });
    await store.clients.insertMany([
      { _id: "acme-crm", name: "Acme CRM", teamId: TEST_TEAM_ID } as never,
      { _id: "beta-shop", name: "Beta Shop", teamId: OTHER_TEAM_ID } as never
    ]);
    await store.aiSessions.insertMany([
      session({ startedByUserId: ids.admin, createdBy: "admin", costCents: 1000, status: "merged", createdAt: new Date("2026-08-05T10:00:00Z") }),
      session({ startedByUserId: ids.dev, createdBy: "dev", costCents: 250, status: "merged", createdAt: new Date("2026-09-02T10:00:00Z") }),
      session({ startedByUserId: ids.dev, createdBy: "dev", costCents: 125, title: "=HYPERLINK(\"x\")", createdAt: new Date("2026-09-20T10:00:00Z"), deletedAt: new Date() }),
      session({ clientId: "beta-shop", teamId: OTHER_TEAM_ID, startedByUserId: ids.otro, createdBy: "otro", costCents: 4000, createdAt: new Date("2026-09-15T10:00:00Z") })
    ]);
    return { store, as };
  }

  it("agrega por equipo, proyecto, persona y mes; costo por PR fusionado", async () => {
    const { as } = await costWorld();
    const boss = await as("jefe");
    const summary = (await boss("GET", "/api/costs/summary")).body;
    expect(summary).toMatchObject({ currency: "USD", listPrice: true, scope: "boss" });
    expect(summary.totals).toEqual({ costCents: 5375, sessions: 4, mergedPrs: 2, costPerMergedPrCents: 2688 });
    expect(summary.byMonth).toEqual([
      { month: "2026-08", costCents: 1000, sessions: 1, mergedPrs: 1, costPerMergedPrCents: 1000 },
      { month: "2026-09", costCents: 4375, sessions: 3, mergedPrs: 1, costPerMergedPrCents: 4375 }
    ]);
    expect(summary.byTeam.map((t: { name: string; costCents: number }) => [t.name, t.costCents])).toEqual([
      ["Equipo B", 4000],
      ["Equipo A", 1375]
    ]);
    expect(summary.byProject[0]).toMatchObject({ clientId: "beta-shop", name: "Beta Shop", teamName: "Equipo B", costCents: 4000, costPerMergedPrCents: null });
    expect(summary.byPerson.map((p: { name: string; costCents: number }) => [p.name, p.costCents])).toEqual([
      ["Olga Otra", 4000],
      ["Ana Líder", 1000],
      ["Diego Dev", 375]
    ]);

    // Rango de fechas (to incluye ese día) y filtro de equipo del CEO/CCO.
    expect((await boss("GET", "/api/costs/summary?from=2026-09-01&to=2026-09-15")).body.totals.costCents).toBe(4250);
    expect((await boss("GET", `/api/costs/summary?teamId=${TEST_TEAM_ID}`)).body.totals.costCents).toBe(1375);
    expect((await boss("GET", "/api/costs/summary?from=2026-13-01")).status).toBe(400);
    expect((await boss("GET", "/api/costs/summary?from=2026-09-10&to=2026-09-01")).status).toBe(400);
  });

  it("cada rol ve su alcance: lead su equipo, developer sus sesiones", async () => {
    const { as } = await costWorld();
    const lead = (await (await as("admin"))("GET", `/api/costs/summary?teamId=${OTHER_TEAM_ID}`)).body;
    expect(lead.scope).toBe("lead");
    // Un lead no puede elegir otro equipo: el filtro se ignora.
    expect(lead.totals.costCents).toBe(1375);
    expect(lead.byPerson.map((p: { username: string }) => p.username)).toEqual(["admin", "dev"]);

    const dev = await as("dev");
    expect((await dev("GET", "/api/costs/summary")).body.totals).toMatchObject({ costCents: 375, sessions: 2 });
    const sessions = (await dev("GET", "/api/costs/sessions")).body.sessions;
    expect(sessions.map((s: { costCents: number }) => s.costCents)).toEqual([125, 250]);

    const other = await as("otro");
    expect((await other("GET", "/api/costs/summary")).body.totals.costCents).toBe(4000);
  });

  it("exporta CSV con el alcance del rol, en USD y sin fórmulas", async () => {
    const { as } = await costWorld();
    const dev = await as("dev");
    const csv = await dev("GET", "/api/costs/export.csv?from=2026-09-01");
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toMatch(/attachment; filename="costos-ai-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = csv.raw.replace(/^\uFEFF/, "").trim().split("\r\n");
    expect(lines[0]).toBe("fecha,mes,proyecto,equipo,persona,usuario,sesion,titulo,estado,pr,costo_usd");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(",Equipo A,Diego Dev,dev,");
    expect(lines[1].endsWith(",1.25")).toBe(true);
    expect(lines[1]).toContain(`"'=HYPERLINK(""x"")"`);
    expect(lines[2].endsWith(",2.50")).toBe(true);
    expect(csv.raw).not.toContain("Olga");
    expect(csvCell("-12.5")).toBe("-12.5");
    expect(csvCell("+cmd")).toBe("'+cmd");
  });

  it("backfill idempotente: lee el costo de Anthropic y rellena equipo y persona", async () => {
    const store = await freshStore();
    await seedUser(store, passwordHash, { username: "admin", role: "lead" });
    await store.clients.insertOne({ _id: "acme-crm", name: "Acme CRM", teamId: TEST_TEAM_ID } as never);
    const agent = new FakeAgent();
    const created = await agent.createSession({ title: "x", repoUrl: "", branch: "b", mountPath: "/r", repoToken: "t", budgetCents: 1000, metadata: {} });
    agent.sessions.get(created.id)!.costCents = 777;
    const legacy = session({ agentSessionId: created.id, createdBy: "admin" });
    delete legacy.teamId;
    delete legacy.costCents;
    const missing = session({ agentSessionId: "sesn_inexistente", createdBy: "antiguo" });
    delete missing.teamId;
    await store.aiSessions.insertMany([legacy, missing]);
    const failing = { getSession: async (id: string) => (id === created.id ? agent.getSession(id) : Promise.reject(new Error("not found"))) };

    const first = await backfillAiCosts({ store, agent: failing });
    expect(first).toEqual({ scanned: 2, updated: 2, costErrors: 1 });
    const doc = await store.aiSessions.findOne({ _id: legacy._id });
    expect(doc).toMatchObject({ costCents: 777, teamId: TEST_TEAM_ID, startedByUserId: (await store.users.findOne({ username: "admin" }))!._id, budgetCents: 1000 });
    expect(await store.aiSessions.findOne({ _id: missing._id })).toMatchObject({ teamId: TEST_TEAM_ID, startedByUserId: null, costCents: 0 });

    // Repetirlo no cambia nada.
    const second = await backfillAiCosts({ store, agent: failing });
    expect(second).toEqual({ scanned: 2, updated: 0, costErrors: 1 });
    expect((await store.aiSessions.findOne({ _id: legacy._id }))?.costCents).toBe(777);
  });
});
