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
    return async (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) => {
      const r = await app.inject({ method, url, headers: { cookie }, payload: payload as never });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- respuestas JSON variadas en los tests
      return { status: r.statusCode, body: (r.body ? r.json() : {}) as Record<string, any> };
    };
  };
  const ana = await as("ana");
  const project = (await ana("POST", "/api/ops/projects", { name: "Manpersa", customerName: "Manpersa SAC" })).body.project as { id: string };
  return { store, as, ana, lead, dev, dev2, project };
}

const thisMonth = new Date().toISOString().slice(0, 7);
const prevMonth = (() => {
  const [y, m] = thisMonth.split("-").map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
})();

describe("pagos / comisiones", () => {
  it("lista Team Leaders y developers con básico + comisión = total; solo Financiera", async () => {
    const { ana, as, dev } = await world();
    expect((await ana("GET", "/api/payouts")).status).toBe(403);
    const fede = await as("fede");
    expect((await fede("PUT", `/api/payouts/${dev._id}/${thisMonth}`, { basicCents: 120_000, commissionCents: 26_000 })).status).toBe(200);
    const list = (await fede("GET", `/api/payouts?month=${thisMonth}`)).body;
    expect(list.rows.map((r: { user: { name: string } }) => r.user.name)).toEqual(["Diego Dev", "Dora Dev", "Ana Líder", "Olga Otra"]);
    expect(list.rows[0]).toMatchObject({ basicCents: 120_000, commissionCents: 26_000, totalCents: 146_000, status: "pending", user: { role: "developer", team: { name: "Equipo A" } } });
    expect(list.canEditPeople).toBe(false);
    await fede("PUT", `/api/payouts/${dev._id}/${thisMonth}`, { status: "paid" });
    const paid = (await fede("GET", `/api/payouts?month=${thisMonth}`)).body.rows[0];
    expect(paid).toMatchObject({ status: "paid", paidDate: new Date().toISOString().slice(0, 10), basicCents: 120_000 });
  });

  it("copia los básicos del mes anterior sin pisar los que ya tienen", async () => {
    const { as, dev, dev2 } = await world();
    const fede = await as("fede");
    await fede("PUT", `/api/payouts/${dev._id}/${prevMonth}`, { basicCents: 100_000 });
    await fede("PUT", `/api/payouts/${dev2._id}/${prevMonth}`, { basicCents: 90_000 });
    await fede("PUT", `/api/payouts/${dev2._id}/${thisMonth}`, { basicCents: 95_000 });
    expect((await fede("POST", "/api/payouts/copy-basics", { month: thisMonth })).body.copied).toBe(1);
    const rows = (await fede("GET", `/api/payouts?month=${thisMonth}`)).body.rows;
    expect(rows.find((r: { user: { id: string } }) => r.user.id === dev._id).basicCents).toBe(100_000);
    expect(rows.find((r: { user: { id: string } }) => r.user.id === dev2._id).basicCents).toBe(95_000);
  });

  it("las horas del mes se reparten por día entre el inicio y el fin de cada tarea", async () => {
    const { ana, as, dev, project } = await world();
    const [y, m] = thisMonth.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const next = new Date(Date.UTC(y, m, 2)).toISOString().slice(0, 10);
    // 3 días en este mes y 2 en el siguiente: 10 h invertidas → 6 h este mes.
    const start = new Date(Date.UTC(y, m - 1, Number(last.slice(8)) - 2)).toISOString().slice(0, 10);
    const task = (await ana("POST", "/api/tasks", { projectId: project.id, title: "Repartida" })).body.task;
    await ana("POST", "/api/tasks", { projectId: project.id, parentTaskId: task.id, title: "Sub", assigneeUserId: dev._id, startDate: start, dueDate: next, investedHours: 10, billableHours: 5 });
    const fede = await as("fede");
    const row = (await fede("GET", `/api/payouts?month=${thisMonth}`)).body.rows.find((r: { user: { id: string } }) => r.user.id === dev._id);
    expect(row.hours).toEqual({ invested: 6, billable: 3 });
  });

  it("solo boss cambia rol, seniority y team; mover a un Team Leader actualiza el líder de ambos equipos", async () => {
    const { as, lead, dev, store } = await world();
    expect((await (await as("fede"))("PATCH", `/api/payouts/people/${dev._id}`, { seniority: "senior" })).status).toBe(403);
    await store.teams.updateOne({ _id: TEST_TEAM_ID }, { $set: { leadUserId: lead._id } });
    const boss = await as("jefe");
    expect((await boss("PATCH", `/api/payouts/people/${dev._id}`, { seniority: "semi_senior" })).body.user.seniority).toBe("semi_senior");
    expect((await store.users.findOne({ _id: dev._id }))?.seniority).toBe("semi_senior");
    const moved = await boss("PATCH", `/api/payouts/people/${lead._id}`, { teamId: OTHER_TEAM_ID });
    expect(moved.body.replacedLead).toBeNull();
    expect((await store.teams.findOne({ _id: TEST_TEAM_ID }))?.leadUserId).toBeNull();
    expect((await store.teams.findOne({ _id: OTHER_TEAM_ID }))?.leadUserId).toBe(lead._id);
    // Un developer que pasa a Team Leader de su equipo queda como su líder.
    await boss("PATCH", `/api/payouts/people/${dev._id}`, { role: "lead" });
    expect((await store.teams.findOne({ _id: TEST_TEAM_ID }))?.leadUserId).toBe(dev._id);
    expect((await boss("PATCH", `/api/payouts/people/${dev._id}`, { seniority: "nivel-x" })).status).toBe(400);
  });
});
