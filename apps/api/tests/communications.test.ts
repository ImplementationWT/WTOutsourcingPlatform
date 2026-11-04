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

const ago = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

async function lead(store: Awaited<ReturnType<typeof world>>["store"], submittedAt: string) {
  const at = new Date();
  const id = "44444444-4444-4444-8444-444444444444";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- lead mínimo para los tests
  await store.leads.insertOne({ _id: id, company: "Acme", contactName: "Lucía", email: "l@acme.pe", status: "contacted", submittedAt, createdAt: at, updatedAt: at } as any);
  return id;
}

describe("comunicaciones", () => {
  it("se registran en un proyecto o en un lead (no en ambos) y el seguimiento vencido cuenta", async () => {
    const { ana, as, project, store } = await world();
    const leadId = await lead(store, ago(1));
    const marta = await as("marta");
    expect((await marta("POST", "/api/communications", { kind: "email", direction: "sent", subject: "Hola", projectId: project.id, leadId })).status).toBe(400);
    expect((await marta("POST", "/api/communications", { kind: "email", direction: "sent", projectId: project.id })).status).toBe(400);
    const sent = await marta("POST", "/api/communications", { kind: "email", direction: "sent", subject: "Propuesta enviada", contactName: "Lucía", leadId, followUpDate: ago(1) });
    expect(sent.status).toBe(201);
    expect(sent.body.communication).toMatchObject({ lead: { id: leadId, name: "Acme" }, owner: { name: "Marta" }, followUpDone: false });
    expect((await ana("POST", "/api/communications", { kind: "call", direction: "received", subject: "Revisión", projectId: project.id })).status).toBe(201);
    const summary = (await marta("GET", "/api/communications/summary")).body;
    expect(summary.followUpsDue).toBe(1);
    await marta("PATCH", `/api/communications/${sent.body.communication.id}`, { followUpDone: true });
    expect((await marta("GET", "/api/communications/summary")).body.followUpsDue).toBe(0);
  });

  it("alcance: el equipo ve las de sus proyectos y no las de leads; Financiera lee sin escribir", async () => {
    const { ana, as, project, store } = await world();
    const leadId = await lead(store, ago(1));
    const marta = await as("marta");
    await marta("POST", "/api/communications", { kind: "email", direction: "sent", subject: "Al lead", leadId });
    await ana("POST", "/api/communications", { kind: "whatsapp", direction: "sent", subject: "Al cliente", projectId: project.id });
    expect((await ana("GET", "/api/communications")).body.communications.map((c: { subject: string }) => c.subject)).toEqual(["Al cliente"]);
    expect((await ana("GET", `/api/communications?leadId=${leadId}`)).status).toBe(403);
    expect((await (await as("olga"))("GET", `/api/communications?projectId=${project.id}`)).status).toBe(404);
    const fede = await as("fede");
    expect((await fede("GET", "/api/communications")).body.communications).toHaveLength(2);
    expect((await fede("POST", "/api/communications", { kind: "email", direction: "sent", subject: "X", leadId })).status).toBe(403);
    // Borrar y deshacer.
    const id = (await marta("GET", "/api/communications")).body.communications[0].id;
    expect((await marta("DELETE", `/api/communications/${id}`)).status).toBe(200);
    expect((await marta("GET", "/api/communications")).body.communications).toHaveLength(1);
    await marta("POST", `/api/communications/${id}/restore`);
    expect((await marta("GET", "/api/communications")).body.communications).toHaveLength(2);
  });

  it("avisa de proyectos sin contacto hace más de 7 días y de leads sin respuesta hace más de 2", async () => {
    const { ana, as, project, store } = await world();
    const leadId = await lead(store, ago(5));
    const marta = await as("marta");
    let cold = (await marta("GET", "/api/communications/summary")).body.cold;
    expect(cold).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "lead", id: leadId, days: 5, since: "arrival" }), expect.objectContaining({ kind: "project", id: project.id, since: "never" })]));
    await ana("POST", "/api/communications", { kind: "email", direction: "sent", subject: "Viejo", projectId: project.id, date: ago(10) });
    await marta("POST", "/api/communications", { kind: "call", direction: "sent", subject: "Hoy", leadId });
    cold = (await marta("GET", "/api/communications/summary")).body.cold;
    expect(cold).toEqual([expect.objectContaining({ kind: "project", days: 10, since: "contact" })]);
  });
});
