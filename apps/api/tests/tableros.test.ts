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

describe("dashboard comercial", () => {
  it("cuenta leads por estado, temperatura y fuente; lo leen quienes leen Leads", async () => {
    const { ana, as, store } = await world();
    const at = new Date();
    const lead = (id: string, status: string, temperature: string | null, sourceName: string) =>
      ({ _id: id, company: id, contactName: null, email: null, status, temperature, sourceName, createdAt: at, updatedAt: at }) as never;
    await store.leads.insertMany([lead("a", "new", "hot", "LinkedIn"), lead("b", "new", "warm", "LinkedIn"), lead("c", "won", "hot", "Upwork")]);
    expect((await ana("GET", "/api/tableros/comercial")).status).toBe(403);
    const body = (await (await as("fede"))("GET", "/api/tableros/comercial")).body;
    expect(body.leads).toBe(3);
    expect(body.byStatus).toEqual([{ key: "new", count: 2 }, { key: "won", count: 1 }]);
    expect(body.byTemperature).toEqual(expect.arrayContaining([{ key: "hot", count: 2 }, { key: "warm", count: 1 }]));
    expect(body.bySource[0]).toEqual({ key: "LinkedIn", count: 2 });
    expect(body).not.toHaveProperty("pipeline");
  });
});
