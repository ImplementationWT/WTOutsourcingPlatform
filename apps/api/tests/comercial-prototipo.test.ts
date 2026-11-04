import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createLoginGuard } from "../src/auth/login-guard.js";
import { hashPassword } from "../src/auth/password.js";
import { freshStore, startDb, stopDb } from "./helpers/db.js";
import { createFakes } from "./helpers/fakes.js";
import { OTHER_TEAM_ID, seedUser, TEST_TEAM_ID } from "./helpers/users.js";
import { advanceTo } from "../src/sales/models.js";

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

describe("Comercial al estilo del prototipo", () => {
  it("actividad con tipo comercial: inicio automático y tiempo invertido al cerrarla", async () => {
    const { as, store } = await world();
    const marta = await as("marta");
    const at = new Date();
    await store.leads.insertOne({ _id: "77777777-7777-4777-8777-777777777777", company: "Acme", status: "new", createdAt: at, updatedAt: at } as never);
    const created = await marta("POST", "/api/activities", { title: "Triage con Acme", kind: "triage_call", leadId: "77777777-7777-4777-8777-777777777777" });
    expect(created.status).toBe(201);
    const id = created.body.activity.id;
    expect(created.body.activity).toMatchObject({ kind: "triage_call", investedMinutes: null });
    // Empezó hace 90 minutos.
    await store.activities.updateOne({ _id: id }, { $set: { createdAt: new Date(Date.now() - 90 * 60_000) } });
    const closed = await marta("PATCH", `/api/activities/${id}`, { status: "done" });
    expect(closed.body.activity.investedMinutes).toBe(90);
  });

  it("Ghosted es un estado frío: una demo o una propuesta lo devuelven al embudo", async () => {
    expect(advanceTo("ghosted", "demo")).toBe("demo");
    expect(advanceTo("ghosted", "contacted")).toBe("ghosted");
    const { as, store } = await world();
    const at = new Date();
    await store.leads.insertOne({ _id: "55555555-5555-4555-8555-555555555555", company: "Ghost SAC", status: "new", createdAt: at, updatedAt: at } as never);
    const marta = await as("marta");
    expect((await marta("PATCH", "/api/sales/leads/55555555-5555-4555-8555-555555555555", { status: "ghosted" })).status).toBe(200);
    expect((await store.leads.findOne({ company: "Ghost SAC" }))?.status).toBe("ghosted");
  });

  it("contactos: tipo Cliente si está en un proyecto y Lead si solo está en un lead", async () => {
    const { ana, as, store } = await world();
    const marta = await as("marta");
    const client = (await marta("POST", "/api/contacts", { name: "Mike Hakobyan" })).body.contact;
    const prospect = (await marta("POST", "/api/contacts", { name: "Lucía Prospecto" })).body.contact;
    await marta("POST", "/api/contacts", { name: "Nadie Relacionado" });
    await ana("POST", "/api/ops/projects", { name: "Arzuman", contactIds: [client.id] });
    const at = new Date();
    await store.leads.insertOne({ _id: "66666666-6666-4666-8666-666666666666", company: "X", contactId: prospect.id, status: "new", createdAt: at, updatedAt: at } as never);
    const rows = (await marta("GET", "/api/contacts?page=1&pageSize=25")).body.rows as { name: string; kind: string | null }[];
    expect(Object.fromEntries(rows.map((r) => [r.name, r.kind]))).toMatchObject({ "Mike Hakobyan": "client", "Lucía Prospecto": "lead", "Nadie Relacionado": null });
  });
});
