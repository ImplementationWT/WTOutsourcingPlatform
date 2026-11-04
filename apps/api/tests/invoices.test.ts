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
  await seedUser(store, passwordHash, { username: "fede", name: "Fede", role: "finance", teamId: null });
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

async function deal(store: Awaited<ReturnType<typeof world>>["store"], projectId: string, rateCents: number) {
  const at = new Date();
  const id = crypto.randomUUID();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deal mínimo para los tests
  await store.deals.insertOne({ _id: id, dealCode: `DL-${rateCents}`, projectId, teamId: TEST_TEAM_ID, leadId: null, contactIds: [], ownerUserId: null, title: "Warranty app", description: "", salesStage: "won", status: "approved", hours: 100, rateCents, amountCents: 100 * rateCents, probability: 100, projectedCents: 0, currency: "USD", expectedCloseDate: null, actualCloseDate: null, saleType: null, product: null, channel: null, lostReason: null, proposalUrl: null, sowUrl: null, changeOrders: [], createdBy: "tests", createdAt: at, updatedAt: at } as any);
  return id;
}

describe("invoices", () => {
  it("bruto = horas × rate del deal y total = bruto + fee; numeración INV-0001", async () => {
    const { as, project, store } = await world();
    const dealId = await deal(store, project.id, 5000);
    const fede = await as("fede");
    const created = await fede("POST", "/api/invoices", { projectId: project.id, hours: 60, feeCents: 9000, month: "2026-10" });
    expect(created.status).toBe(201);
    expect(created.body.invoice).toMatchObject({ number: "INV-0001", deal: { id: dealId }, rateCents: 5000, grossCents: 300_000, feeCents: 9000, totalCents: 309_000, lead: { name: "Ana Líder" }, stage: "pending" });
    expect((await fede("POST", "/api/invoices", { projectId: project.id })).body.invoice.number).toBe("INV-0002");
  });

  it("Pending de un mes futuro se ve como Upcoming; pasar a Paid pone las fechas", async () => {
    const { as, project, store } = await world();
    await deal(store, project.id, 5000);
    const fede = await as("fede");
    const future = (await fede("POST", "/api/invoices", { projectId: project.id, month: "2099-01" })).body.invoice;
    expect(future.effectiveStage).toBe("upcoming");
    const paid = (await fede("PATCH", `/api/invoices/${future.id}`, { stage: "paid" })).body.invoice;
    const today = new Date().toISOString().slice(0, 10);
    expect(paid).toMatchObject({ stage: "paid", effectiveStage: "paid", invoicedDate: today, paidDate: today });
  });

  it("solo boss y finance; el deal debe ser del proyecto; borrar y deshacer", async () => {
    const { ana, as, project, store } = await world();
    await deal(store, project.id, 5000);
    const other = (await (await as("olga"))("POST", "/api/ops/projects", { name: "Otro proyecto", customerName: "Otro" })).body.project;
    const otherDeal = await deal(store, other.id, 3000);
    expect((await ana("GET", "/api/invoices")).status).toBe(403);
    expect((await (await as("marta"))("GET", "/api/invoices")).status).toBe(403);
    const fede = await as("fede");
    expect((await fede("POST", "/api/invoices", { projectId: project.id, dealId: otherDeal })).status).toBe(400);
    const inv = (await fede("POST", "/api/invoices", { projectId: project.id })).body.invoice;
    // Cambiar de proyecto toma su primer deal.
    expect((await fede("PATCH", `/api/invoices/${inv.id}`, { projectId: other.id })).body.invoice.deal.id).toBe(otherDeal);
    expect((await fede("DELETE", `/api/invoices/${inv.id}`)).status).toBe(200);
    expect((await fede("GET", "/api/invoices")).body.invoices).toEqual([]);
    await fede("POST", `/api/invoices/${inv.id}/restore`);
    expect((await fede("GET", "/api/invoices")).body.invoices).toHaveLength(1);
  });
});

describe("horas pagadas en el proyecto", () => {
  it("las ve Financiera (invoices en Paid); el equipo no", async () => {
    const { ana, as, project, store } = await world();
    await deal(store, project.id, 5000);
    const fede = await as("fede");
    const inv = (await fede("POST", "/api/invoices", { projectId: project.id, hours: 30 })).body.invoice;
    await fede("POST", "/api/invoices", { projectId: project.id, hours: 99 });
    await fede("PATCH", `/api/invoices/${inv.id}`, { stage: "paid" });
    expect((await fede("GET", `/api/ops/projects/${project.id}`)).body.finance).toEqual({ paidHours: 30, paidCents: 150_000 });
    expect((await ana("GET", `/api/ops/projects/${project.id}`)).body.finance).toBeNull();
  });
});
