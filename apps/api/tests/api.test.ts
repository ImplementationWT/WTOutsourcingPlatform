import { Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";
import { clearRegisteredSecrets, registerSecret } from "../src/lib/redact.js";
import type { AdminStore } from "../src/store/admin-store.js";
import { freshStore, startDb, stopDb } from "./helpers/db.js";
import { createFakes, TEST_CONFIG } from "./helpers/fakes.js";

const ADMIN_PASSWORD = "correct horse battery staple";
let passwordHash: string;

beforeAll(async () => {
  await startDb();
  passwordHash = await hashPassword(ADMIN_PASSWORD);
});
afterAll(stopDb);
beforeEach(() => {
  clearRegisteredSecrets();
  registerSecret(TEST_CONFIG.deploy!.privateKey);
});

let apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

async function setup() {
  const store = await freshStore();
  const fakes = createFakes(store);
  const logs: string[] = [];
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      logs.push(String(chunk));
      cb();
    }
  });
  const app = await buildApp({
    store,
    deps: fakes.deps,
    logStream,
    logLevel: "debug",
    auth: { adminUsername: "admin", adminPasswordHash: passwordHash, sessionSecret: "x".repeat(40), secureCookies: false }
  });
  apps.push(app);
  return { app, store, logs, ...fakes };
}

async function login(app: Awaited<ReturnType<typeof buildApp>>) {
  const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: ADMIN_PASSWORD } });
  expect(response.statusCode).toBe(200);
  const cookie = response.cookies.find((c) => c.name === "pp_session")!;
  expect(cookie.httpOnly).toBe(true);
  return { cookie: `pp_session=${cookie.value}` };
}

const newClient = { name: "Acme CRM", slug: "acme-crm", description: "CRM interno de Acme" };

describe("autenticación", () => {
  it("los endpoints de creación, consulta y reintento exigen sesión", async () => {
    const { app } = await setup();
    const id = "00000000-0000-4000-8000-000000000000";
    for (const [method, url] of [
      ["POST", "/api/clients"],
      ["GET", "/api/clients/acme-crm"],
      ["GET", `/api/jobs/${id}`],
      ["GET", `/api/jobs/${id}/events`],
      ["POST", `/api/jobs/${id}/retry`],
      ["GET", "/api/projects"]
    ] as const) {
      const response = await app.inject({ method, url, payload: method === "POST" ? {} : undefined });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("rechaza credenciales incorrectas y cookies manipuladas", async () => {
    const { app } = await setup();
    const bad = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "admin123" } });
    expect(bad.statusCode).toBe(401);

    const forged = Buffer.from(JSON.stringify({ username: "admin", role: "admin", exp: Date.now() + 1e9 })).toString("base64url");
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: `pp_session=${forged}.firma` } });
    expect(me.statusCode).toBe(401);
  });
});

describe("creación de clientes", () => {
  it("deriva base y usuario solo del slug validado e ignora nombres enviados por el navegador", async () => {
    const { app, atlas, mongo } = await setup();
    const headers = await login(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers,
      payload: { ...newClient, database: "admin", dbUser: "root", repository: "otro-repo" }
    });
    expect(response.statusCode).toBe(202);
    await app.engine.idle();

    expect([...atlas.users.keys()]).toEqual(["app_acme_crm"]);
    expect([...mongo.databases.keys()]).toEqual(["client_acme_crm"]);

    const detail = (await app.inject({ method: "GET", url: "/api/clients/acme-crm", headers })).json();
    expect(detail.resources).toEqual({
      repository: { fullName: "acme-org/acme-crm-app", url: "https://github.com/acme-org/acme-crm-app" },
      database: "client_acme_crm",
      databaseUser: "app_acme_crm",
      subdomain: "acme-crm.apps.example.test",
      baseUrl: "https://acme-crm.apps.example.test"
    });
    expect(detail.client).toMatchObject({ status: "ready", readiness: { ready: true } });
  });

  it("rechaza slugs inválidos", async () => {
    const { app } = await setup();
    const headers = await login(app);
    for (const slug of ["Acme", "../etc", "a", "acme_crm", "-acme", "acme--crm-", "x".repeat(31)]) {
      const response = await app.inject({ method: "POST", url: "/api/clients", headers, payload: { ...newClient, slug } });
      expect(response.statusCode, slug).toBe(400);
    }
  });

  it("dos solicitudes simultáneas del mismo cliente no duplican recursos", async () => {
    const { app, atlas, github } = await setup();
    const headers = await login(app);
    const responses = await Promise.all(
      [1, 2].map(() => app.inject({ method: "POST", url: "/api/clients", headers, payload: newClient }))
    );
    expect(responses.map((r) => r.statusCode).sort()).toEqual([202, 409]);
    await app.engine.idle();

    expect(atlas.count("createDatabaseUser")).toBe(1);
    expect(github.count("createRepositoryFromTemplate")).toBe(1);
    expect(github.calls.filter((c) => c.method === "putEnvironmentSecret" && c.args[1] === "MONGODB_URI")).toHaveLength(1);
  });

  it("reintento reanuda desde la etapa fallida", async () => {
    const { app, github } = await setup();
    const headers = await login(app);
    github.nextRunConclusion = "failure";
    const { jobId } = (await app.inject({ method: "POST", url: "/api/clients", headers, payload: newClient })).json();
    await app.engine.idle();
    expect((await app.inject({ method: "GET", url: `/api/jobs/${jobId}`, headers })).json().status).toBe("failed");

    github.nextRunConclusion = "success";
    const retry = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/retry`, headers });
    expect(retry.statusCode).toBe(202);
    expect(retry.json().resumeFrom).toBe("deploy");
    await app.engine.idle();

    const job = (await app.inject({ method: "GET", url: `/api/jobs/${jobId}`, headers })).json();
    expect(job.status).toBe("succeeded");
    expect(github.count("createRepositoryFromTemplate")).toBe(1);

    const again = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/retry`, headers });
    expect(again.statusCode).toBe(409);
  });
});

describe("redacción de secretos", () => {
  it("ninguna salida (logs, eventos, API, base administrativa) contiene contraseñas, URI ni claves", async () => {
    const { app, store, logs, atlas, github } = await setup();
    const headers = await login(app);

    // 1ª ejecución: una librería lanza un error que incluye la URI completa.
    let leak = true;
    github.faults.set("putEnvironmentSecret", () => {
      if (!leak) return undefined;
      const uri = `mongodb+srv://app_acme_crm:${atlas.seenPasswords.at(-1)}@shared-cluster.abcde.mongodb.net/`;
      return new Error(`write failed for ${uri} token ghs_${"a".repeat(36)}`);
    });

    const { jobId } = (await app.inject({ method: "POST", url: "/api/clients", headers, payload: newClient })).json();
    await app.engine.idle();
    const failedJob = (await app.inject({ method: "GET", url: `/api/jobs/${jobId}`, headers })).json();
    expect(failedJob.stages[2].error.code).toBe("internal_error");

    // 2ª ejecución: rotación y éxito.
    leak = false;
    await app.inject({ method: "POST", url: `/api/jobs/${jobId}/retry`, headers });
    await app.engine.idle();

    const outputs = [
      ...logs,
      (await app.inject({ method: "GET", url: `/api/jobs/${jobId}`, headers })).body,
      (await app.inject({ method: "GET", url: `/api/jobs/${jobId}/events`, headers })).body,
      (await app.inject({ method: "GET", url: "/api/clients/acme-crm", headers })).body,
      (await app.inject({ method: "GET", url: "/api/projects", headers })).body,
      JSON.stringify(await dumpAdminDb(store))
    ].join("\n");

    expect(atlas.seenPasswords.length).toBe(2);
    for (const password of atlas.seenPasswords) {
      expect(outputs).not.toContain(password);
      expect(outputs).not.toContain(encodeURIComponent(password));
    }
    expect(outputs).not.toMatch(/mongodb(\+srv)?:\/\/(?!\[REDACTED\])/);
    expect(outputs).not.toContain("ghs_aaaa");
    expect(outputs).not.toContain("ZmFrZS10ZXN0LWtleQ");
    expect(outputs).not.toContain(ADMIN_PASSWORD);
    // Sí se ven las referencias.
    expect(outputs).toContain("client_acme_crm");
    expect(outputs).toContain("app_acme_crm");
  });
});

async function dumpAdminDb(store: AdminStore) {
  return {
    clients: await store.clients.find().toArray(),
    jobs: await store.jobs.find().toArray(),
    resources: await store.resources.find().toArray(),
    audit: await store.auditLog.find().toArray()
  };
}
