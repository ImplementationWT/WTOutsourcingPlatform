import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";
import { JobEngine } from "../src/jobs/engine.js";
import { TransientError } from "../src/lib/errors.js";
import { clearRegisteredSecrets } from "../src/lib/redact.js";
import { freshStore, startDb, stopDb } from "./helpers/db.js";
import { createFakes, silent } from "./helpers/fakes.js";
import { seedUser, TEST_TEAM_ID } from "./helpers/users.js";

const ADMIN_PASSWORD = "correct horse battery staple";
let passwordHash: string;

beforeAll(async () => {
  await startDb();
  passwordHash = await hashPassword(ADMIN_PASSWORD);
});
afterAll(stopDb);
beforeEach(() => clearRegisteredSecrets());

let apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

async function setup() {
  const store = await freshStore();
  const fakes = createFakes(store);
  const app = await buildApp({
    store,
    deps: fakes.deps,
    logLevel: "silent",
    auth: { adminUsername: "jefe", adminPasswordHash: passwordHash, sessionSecret: "x".repeat(40), secureCookies: false }
  });
  apps.push(app);
  await seedUser(store, passwordHash);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: ADMIN_PASSWORD } });
  const cookie = login.cookies.find((c) => c.name === "pp_session")!;
  return { app, store, headers: { cookie: `pp_session=${cookie.value}` }, ...fakes };
}

const repo = (name: string) => ({ name, fullName: `acme-org/${name}`, url: `https://github.com/acme-org/${name}`, private: true, defaultBranch: "main" });

describe("etiquetas de proyectos (topics de GitHub)", () => {
  it("el aprovisionamiento etiqueta el repo nuevo con el topic de la plataforma", async () => {
    const { store, deps, github } = await setup();
    const job = await store.createClientWithJob({ teamId: TEST_TEAM_ID, slug: "acme-crm", name: "Acme CRM", description: "CRM interno de Acme", actor: "admin" });
    const result = await new JobEngine(store, deps, silent).run(job._id, "admin");
    expect(result?.status).toBe("succeeded");
    expect(github.topics.get("acme-crm-app")).toEqual(["launchpad"]);
  });

  it("si GitHub no deja etiquetar, el alta sigue adelante", async () => {
    const { store, deps, github } = await setup();
    github.faults.set("setRepositoryTopics", () => new TransientError("github_unavailable", "HTTP 503"));
    const job = await store.createClientWithJob({ teamId: TEST_TEAM_ID, slug: "acme-crm", name: "Acme CRM", description: "CRM interno de Acme", actor: "admin" });
    const result = await new JobEngine(store, deps, silent).run(job._id, "admin");
    expect(result?.status).toBe("succeeded");
    expect(github.topics.has("acme-crm-app")).toBe(false);
  });

  it("GET /api/projects devuelve los topics y PUT los reemplaza (ordenados y sin duplicados), auditado", async () => {
    const { app, store, headers, github } = await setup();
    await store.createClientWithJob({ teamId: TEST_TEAM_ID, slug: "tienda", name: "Tienda", description: "Tienda web", actor: "admin" });
    github.repos.set("tienda-app", repo("tienda-app"));
    github.topics.set("tienda-app", ["legacy"]);
    // Un repo que no es de un proyecto de la plataforma (sin equipo): solo lo ven los jefes.
    github.repos.set("tienda-web", repo("tienda-web"));

    const list = (await app.inject({ method: "GET", url: "/api/projects", headers })).json();
    expect(list.projects.map((p: { name: string }) => p.name)).toEqual(["tienda-app"]);
    expect(list.projects[0]).toMatchObject({ topics: ["legacy"], clientId: "tienda", teamId: TEST_TEAM_ID });
    expect(list.platformTopic).toBe("launchpad");

    const put = await app.inject({ method: "PUT", url: "/api/projects/tienda-app/topics", headers, payload: { topics: ["shopify", "cliente-x", "shopify"] } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ topics: ["cliente-x", "shopify"] });
    expect(github.topics.get("tienda-app")).toEqual(["cliente-x", "shopify"]);
    expect((await app.inject({ method: "PUT", url: "/api/projects/tienda-web/topics", headers, payload: { topics: ["x"] } })).statusCode).toBe(404);

    const audit = await store.auditLog.findOne({ action: "project.topics_updated" });
    expect(audit).toMatchObject({ actor: "admin", actorName: "Admin", actorTeamId: TEST_TEAM_ID, target: "acme-org/tienda-app", details: { topics: ["cliente-x", "shopify"] } });
  });

  it("rechaza etiquetas que GitHub no admite y repos fuera de la lista", async () => {
    const { app, store, headers, github } = await setup();
    await store.createClientWithJob({ teamId: TEST_TEAM_ID, slug: "tienda", name: "Tienda", description: "Tienda web", actor: "admin" });
    github.repos.set("tienda-app", repo("tienda-app"));
    const put = (url: string, payload: unknown) => app.inject({ method: "PUT", url, headers, payload });

    for (const topics of [["Mayusculas"], ["con espacio"], ["-guion"], ["x".repeat(51)], Array.from({ length: 21 }, (_, i) => `t${i}`)]) {
      expect((await put("/api/projects/tienda-app/topics", { topics })).statusCode, JSON.stringify(topics)).toBe(400);
    }
    expect((await put("/api/projects/tienda-app/topics", { topics: [], extra: 1 })).statusCode).toBe(400);
    // No está entre los repos de proyectos (p. ej. un interno WT o de otra cuenta).
    expect((await put("/api/projects/wt-interno/topics", { topics: ["x"] })).statusCode).toBe(404);
    expect(github.count("setRepositoryTopics")).toBe(0);
  });

  it("exige sesión", async () => {
    const { app } = await setup();
    const response = await app.inject({ method: "PUT", url: "/api/projects/tienda-web/topics", payload: { topics: [] } });
    expect(response.statusCode).toBe(401);
  });
});
