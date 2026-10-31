import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createLoginGuard } from "../src/auth/login-guard.js";
import { hashPassword } from "../src/auth/password.js";
import { migrateToV2, migrateToV4 } from "../src/core/migrate.js";
import { runTableQuery, tableQuerySchema } from "../src/lib/table-query.js";
import { PROJECT_STAGES } from "../src/ops/models.js";
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

type App = Awaited<ReturnType<typeof buildApp>>;
let apps: App[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

/** Equipo A (ana lead, dev), equipo B (olga lead), un CEO/CCO (jefe), comercial (marta) y finance (fede). */
async function world() {
  const store = await freshStore();
  const app = await buildApp({
    store,
    deps: createFakes(store).deps,
    logLevel: "silent",
    auth: { adminUsername: "jefe", adminPasswordHash: passwordHash, sessionSecret: "x".repeat(40), secureCookies: false, loginGuard: createLoginGuard({ maxPerIp: 1000, maxPerUser: 1000 }) }
  });
  apps.push(app);
  await seedUser(store, passwordHash, { username: "ana", name: "Ana Líder", role: "lead", teamId: TEST_TEAM_ID });
  await seedUser(store, passwordHash, { username: "dev", name: "Diego Dev", role: "developer", teamId: TEST_TEAM_ID });
  await seedUser(store, passwordHash, { username: "olga", name: "Olga Otra", role: "lead", teamId: OTHER_TEAM_ID, teamName: "Equipo B" });
  const marta = await seedUser(store, passwordHash, { username: "marta", name: "Marta Marketing", role: "commercial", teamId: null });
  await seedUser(store, passwordHash, { username: "fede", name: "Fede Finanzas", role: "finance", teamId: null });
  const as = async (username: string) => {
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: PASSWORD } });
    const cookie = login.cookies.find((c) => c.name === "pp_session");
    const headers = { cookie: cookie ? `pp_session=${cookie.value}` : "" };
    return async (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => {
      const response = await app.inject({ method, url, headers, payload: payload as never });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- respuestas JSON variadas en los tests
      return { status: response.statusCode, body: response.json() as Record<string, any> };
    };
  };
  return { store, as, marta };
}

describe("tabla en el servidor", () => {
  it("pagina, ordena un catálogo por su orden propio, busca, cuenta por estado y suma el conjunto filtrado", async () => {
    const store = await freshStore();
    const at = new Date();
    const stages = ["maintenance", "kickoff", "structure", "kickoff", "completed"] as const;
    await store.opsProjects.insertMany(
      stages.map((stage, i) => ({
        _id: randomUUID(),
        name: `Proyecto ${i}`,
        customerName: i === 2 ? "Manpersa SAC" : "Otro",
        teamId: TEST_TEAM_ID,
        leadUserId: null,
        developerUserId: null,
        clientSlug: null,
        proposalUrl: null,
        stage,
        health: "neutral" as const,
        priority: "medium" as const,
        createdBy: "tests",
        createdAt: at,
        updatedAt: at
      }))
    );
    const query = (q: Record<string, string>) => tableQuerySchema.parse(q);
    const sortable = { stage: { field: "stage", order: PROJECT_STAGES }, name: "name" };
    const page1 = await runTableQuery(store.opsProjects, { match: {}, query: query({ sort: "stage", pageSize: "2" }), sortable, defaultSort: { key: "name", dir: "asc" }, facetField: "stage" });
    expect(page1.rows.map((p) => p.stage)).toEqual(["kickoff", "kickoff"]);
    expect(page1).toMatchObject({ total: 5, page: 1, pageSize: 2, facets: { kickoff: 2, structure: 1, maintenance: 1, completed: 1 } });
    const page3 = await runTableQuery(store.opsProjects, { match: {}, query: query({ sort: "stage", pageSize: "2", page: "3" }), sortable, defaultSort: { key: "name", dir: "asc" } });
    expect(page3.rows.map((p) => p.stage)).toEqual(["completed"]);
    const search = await runTableQuery(store.opsProjects, { match: {}, query: query({ q: "manp" }), sortable, defaultSort: { key: "name", dir: "asc" }, search: ["customerName"] });
    expect(search.rows.map((p) => p.name)).toEqual(["Proyecto 2"]);
    // Un texto con caracteres de regex se busca literal.
    expect((await runTableQuery(store.opsProjects, { match: {}, query: query({ q: ".*" }), sortable, defaultSort: { key: "name", dir: "asc" }, search: ["name"] })).total).toBe(0);
    expect(tableQuerySchema.safeParse({ pageSize: "500" }).success).toBe(false);
  });
});

describe("contactos", () => {
  it("CEO/CCO y Comercial los crean; Financiera solo lee; los equipos no tienen acceso", async () => {
    const { as } = await world();
    const marta = await as("marta");
    const contact = await marta("POST", "/api/contacts", { name: "Francisco Wong", emails: ["FRANCISCO@manpersa.pe"], title: "Gerente", company: "Manpersa SAC" });
    expect(contact.status).toBe(201);
    expect(contact.body.contact).toMatchObject({ emails: ["francisco@manpersa.pe"], company: "Manpersa SAC" });
    expect((await marta("POST", "/api/contacts", { name: "Con id de empresa", companyId: randomUUID() })).status).toBe(400);

    const fede = await as("fede");
    expect((await fede("GET", "/api/contacts?q=manpersa")).body).toMatchObject({ total: 1, rows: [{ name: "Francisco Wong" }] });
    expect((await fede("POST", "/api/contacts", { name: "No debería" })).status).toBe(403);
    for (const username of ["ana", "dev"]) {
      const api = await as(username);
      expect((await api("GET", "/api/contacts")).status).toBe(403);
    }
    // Empresas, Partners, Catálogo y Sources ya no existen.
    for (const url of ["/api/companies", "/api/partners", "/api/products", "/api/use-cases", "/api/sales/sources"]) expect((await marta("GET", url)).status).toBe(404);
  });

  it("el contacto muestra sus relaciones: deals y proyectos", async () => {
    const { as } = await world();
    const jefe = await as("jefe");
    const contact = (await jefe("POST", "/api/contacts", { name: "Ana Pérez", company: "Acme" })).body.contact;
    const project = (await jefe("POST", "/api/ops/projects", { name: "Portal Acme", customerName: "Acme", contactIds: [contact.id], teamId: TEST_TEAM_ID })).body.project;
    expect(project).toMatchObject({ customerName: "Acme", contacts: [{ id: contact.id, name: "Ana Pérez" }] });
    expect(project).not.toHaveProperty("company");
    const deal = (await jefe("POST", "/api/deals", { title: "Módulo de pagos", projectId: project.id, contactIds: [contact.id] })).body.deal;
    const detail = (await jefe("GET", `/api/contacts/${contact.id}`)).body;
    expect(detail).toMatchObject({ contact: { company: "Acme" }, deals: [{ id: deal.id, dealCode: deal.dealCode }], projects: [{ id: project.id }] });
  });
});

describe("deals (tabla de primer nivel)", () => {
  it("código DL-0001 autoincremental, valor y valor proyectado calculados en el servidor", async () => {
    const { as } = await world();
    const marta = await as("marta");
    const a = (await marta("POST", "/api/deals", { title: "Automatización de pedidos", hours: 40, rateCents: 3500, probability: 60 })).body.deal;
    const b = (await marta("POST", "/api/deals", { title: "Portal de clientes" })).body.deal;
    expect(a).toMatchObject({ dealCode: "DL-0001", amountCents: 140_000, projectedCents: 84_000, salesStage: "new", status: "draft", project: null });
    expect(b.dealCode).toBe("DL-0002");
    expect((await marta("POST", "/api/deals", { title: "Con monto", amountCents: 5 })).status).toBe(400);
    const list = (await marta("GET", "/api/deals?sort=dealCode&dir=asc")).body;
    expect(list).toMatchObject({ total: 2, totals: { hours: 40, amountCents: 140_000, projectedCents: 84_000 }, facets: { draft: 2 } });
    expect(list.rows.map((d: { dealCode: string }) => d.dealCode)).toEqual(["DL-0001", "DL-0002"]);
  });

  it("Comercial crea y edita hasta «Propuesto»; Financiera lee; el equipo ve solo los suyos", async () => {
    const { as } = await world();
    const marta = await as("marta");
    const jefe = await as("jefe");
    expect((await marta("POST", "/api/deals", { title: "Ya aprobado", status: "approved" })).status).toBe(403);
    const deal = (await marta("POST", "/api/deals", { title: "Módulo de pedidos", status: "proposed" })).body.deal;
    expect((await marta("PATCH", `/api/deals/${deal.id}`, { status: "approved" })).status).toBe(403);
    // Al ganarse pasa a un proyecto del equipo A.
    const project = (await jefe("POST", "/api/ops/projects", { name: "Proyecto A", customerName: "Cliente", teamId: TEST_TEAM_ID })).body.project;
    expect((await jefe("PATCH", `/api/deals/${deal.id}`, { projectId: project.id, status: "approved" })).status).toBe(200);
    expect((await marta("PATCH", `/api/deals/${deal.id}`, { title: "Ya no puede" })).status).toBe(403);

    const fede = await as("fede");
    expect((await fede("GET", `/api/deals/${deal.id}`)).body.deal.canEdit).toBe(false);
    expect((await fede("PATCH", `/api/deals/${deal.id}`, { title: "Título válido" })).status).toBe(403);

    const ana = await as("ana");
    expect((await ana("PATCH", `/api/deals/${deal.id}`, { hours: 12, rateCents: 4000 })).body.deal.amountCents).toBe(48_000);
    expect((await ana("GET", "/api/deals")).body.total).toBe(1);
    expect((await ana("POST", "/api/deals", { title: "Sin proyecto" })).status).toBe(400);
    const dev = await as("dev");
    expect((await dev("GET", `/api/deals/${deal.id}`)).status).toBe(200);
    expect((await dev("PATCH", `/api/deals/${deal.id}`, { title: "Título válido" })).status).toBe(403);
    // Otro equipo: no existe para él.
    const olga = await as("olga");
    expect((await olga("GET", `/api/deals/${deal.id}`)).status).toBe(404);
    expect((await olga("GET", "/api/deals")).body.total).toBe(0);
    expect((await olga("POST", "/api/deals", { title: "Ajeno", projectId: project.id })).status).toBe(403);
  });

  it("facturado o cobrado bloquea horas y tarifa; los cambios van como change order", async () => {
    const { as, store } = await world();
    const jefe = await as("jefe");
    const deal = (await jefe("POST", "/api/deals", { title: "Módulo A", hours: 10, rateCents: 3000, status: "invoiced" })).body.deal;
    expect((await jefe("PATCH", `/api/deals/${deal.id}`, { hours: 99 })).status).toBe(409);
    const co = await jefe("POST", `/api/deals/${deal.id}/change-orders`, { description: "Reporte adicional", hours: 5, rateCents: 3000 });
    expect(co.body.changeOrder).toMatchObject({ amountCents: 15_000, status: "draft", approvedAt: null });
    const approved = await jefe("PATCH", `/api/deals/${deal.id}/change-orders/${co.body.changeOrder.id}`, { status: "approved", signedBy: "Francisco Wong" });
    expect(approved.body.changeOrder.approvedAt).toBeTruthy();
    expect((await jefe("PATCH", `/api/deals/${deal.id}/change-orders/${co.body.changeOrder.id}`, { hours: 50 })).status).toBe(409);
    const paid = await jefe("PATCH", `/api/deals/${deal.id}`, { status: "paid" });
    expect(paid.body.deal.paidAt).toBeTruthy();
    expect(paid.body.deal.changeOrders).toHaveLength(1);
    expect(await store.auditLog.countDocuments({ action: "core.deal_change_order_created" })).toBe(1);
  });
});

describe("migraciones", () => {
  it("deals de la Fase 1 → códigos DL y equipo del proyecto; repetirla no cambia nada", async () => {
    const store = await freshStore();
    const at = new Date();
    const projectId = randomUUID();
    await store.opsProjects.insertOne({ _id: projectId, name: "P", customerName: "Manpersa SAC", teamId: TEST_TEAM_ID, leadUserId: null, developerUserId: null, clientSlug: null, proposalUrl: null, stage: "kickoff", health: "neutral", sentimentScore: 50, priority: "medium", createdBy: "tests", createdAt: at, updatedAt: at });
    const legacy = (status: string, minutes: number) => ({ _id: randomUUID(), projectId, title: `Deal ${status}`, description: "", hours: 10, rateCents: 1000, amountCents: 10_000, currency: "USD", status, proposalUrl: null, createdBy: "tests", createdAt: new Date(at.getTime() + minutes * 60_000), updatedAt: at });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- documentos con la forma de la Fase 1
    await store.deals.insertMany([legacy("approved", 1), legacy("draft", 2)] as any);

    await migrateToV2(store);
    await migrateToV2(store);
    const deals = await store.deals.find().sort({ createdAt: 1 }).toArray();
    expect(deals.map((d) => [d.dealCode, d.teamId, d.salesStage, d.probability])).toEqual([
      ["DL-0001", TEST_TEAM_ID, "won", 100],
      ["DL-0002", TEST_TEAM_ID, "proposal", 50]
    ]);
    // El siguiente deal nuevo sigue la secuencia.
    expect(await store.nextSequence("deal")).toBe(3);
  });

  it("reuniones a la tabla única con su equipo, y se borra lo que salió del producto", async () => {
    const store = await freshStore();
    const db = store.db;
    const at = new Date();
    const projectId = randomUUID();
    const companyId = randomUUID();
    await store.opsProjects.insertOne({ _id: projectId, name: "P", customerName: "Acme", companyId, teamId: TEST_TEAM_ID, leadUserId: null, developerUserId: null, clientSlug: null, proposalUrl: null, stage: "kickoff", health: "neutral", priority: "medium", createdBy: "tests", createdAt: at, updatedAt: at } as never);
    await db.collection("core_companies").insertOne({ _id: companyId, name: "Acme SAC" } as never);
    await store.contacts.insertOne({ _id: randomUUID(), name: "Ana", emails: [], phone: null, title: null, linkedinUrl: null, companyId, createdBy: "tests", createdAt: at, updatedAt: at } as never);
    await db.collection("sales_partners").insertOne({ _id: randomUUID(), name: "Agencia" } as never);
    const meeting = (extra: Record<string, unknown>) => ({ _id: randomUUID(), title: "Reunión", heldAt: at, source: "manual", externalId: null, transcript: "", summary: "", feedback: [], actionItems: [], status: "processed", createdBy: "tests", createdAt: at, updatedAt: at, ...extra });
    await db.collection("ops_meetings").insertOne(meeting({ projectId }) as never);
    await db.collection("sales_meetings").insertOne(meeting({ leadId: randomUUID() }) as never);
    await db.collection("meetings_inbox").insertOne(meeting({ candidates: [] }) as never);

    await migrateToV4(store);
    await migrateToV4(store);
    const rows = await store.meetings.find().toArray();
    expect(rows).toHaveLength(3);
    expect(rows.find((m) => m.projectId === projectId)).toMatchObject({ teamId: TEST_TEAM_ID, leadId: null });
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    for (const gone of ["ops_meetings", "sales_meetings", "meetings_inbox", "core_companies", "sales_partners"]) expect(names).not.toContain(gone);
    expect(await store.contacts.findOne({})).toMatchObject({ company: "Acme SAC" });
    expect(await store.contacts.findOne({})).not.toHaveProperty("companyId");
    expect(await store.opsProjects.findOne({ _id: projectId })).not.toHaveProperty("companyId");
  });
});
