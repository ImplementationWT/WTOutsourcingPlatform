import { Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";
import { FatalError } from "../src/lib/errors.js";
import { clearRegisteredSecrets } from "../src/lib/redact.js";
import { freshStore, startDb, stopDb } from "./helpers/db.js";
import { createFakes } from "./helpers/fakes.js";
import { seedUser } from "./helpers/users.js";

const ADMIN_PASSWORD = "correct horse battery staple";
let passwordHash: string;

beforeAll(async () => {
  await startDb();
  passwordHash = await hashPassword(ADMIN_PASSWORD);
});
afterAll(stopDb);
beforeEach(() => {
  clearRegisteredSecrets();
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
    auth: { adminUsername: "jefe", adminPasswordHash: passwordHash, sessionSecret: "x".repeat(40), secureCookies: false }
  });
  apps.push(app);
  await seedUser(store, passwordHash);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: ADMIN_PASSWORD } });
  const headers = { cookie: `pp_session=${login.cookies.find((c) => c.name === "pp_session")!.value}` };
  return { app, store, logs, headers, ...fakes };
}

async function provision(ctx: Awaited<ReturnType<typeof setup>>) {
  const created = await ctx.app.inject({
    method: "POST",
    url: "/api/clients",
    headers: ctx.headers,
    payload: { name: "Acme CRM", slug: "acme-crm", description: "CRM interno de Acme" }
  });
  await ctx.app.engine.idle();
  return created.json() as { jobId: string };
}

const status = (ctx: Awaited<ReturnType<typeof setup>>) =>
  ctx.app.inject({ method: "GET", url: "/api/clients/acme-crm/initial-password", headers: ctx.headers }).then((r) => r.json());
const reveal = (ctx: Awaited<ReturnType<typeof setup>>) =>
  ctx.app.inject({ method: "POST", url: "/api/clients/acme-crm/initial-password/reveal", headers: ctx.headers });

describe("revelación única de la contraseña inicial", () => {
  it("exige sesión", async () => {
    const ctx = await setup();
    await provision(ctx);
    expect((await ctx.app.inject({ method: "POST", url: "/api/clients/acme-crm/initial-password/reveal" })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "GET", url: "/api/clients/acme-crm/initial-password" })).statusCode).toBe(401);
  });

  it("funciona una sola vez, queda auditada sin el valor y después se elimina", async () => {
    const ctx = await setup();
    await provision(ctx);
    const written = ctx.github.env("acme-crm-app").secrets.get("INITIAL_ADMIN_PASSWORD")!;

    expect(await status(ctx)).toMatchObject({ mode: "random", state: "available", username: "admin", mustChangeOnFirstLogin: true });

    const first = await reveal(ctx);
    expect(first.statusCode).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.json()).toEqual({ username: "admin", password: written, mustChangeOnFirstLogin: true });

    const second = await reveal(ctx);
    expect(second.statusCode).toBe(410);
    expect(second.json()).toMatchObject({ state: "revealed" });
    expect(second.body).not.toContain(written);
    expect(await status(ctx)).toMatchObject({ state: "revealed", revealedBy: "admin" });

    const audit = await ctx.store.auditLog.find({ action: "initial_password_revealed" }).toArray();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: "admin", clientId: "acme-crm", target: "acme-crm" });
    expect(audit[0].details).toBeUndefined();
    expect(await ctx.store.initialPasswords.countDocuments()).toBe(0);
  });

  it("dos revelaciones simultáneas: solo una obtiene la contraseña", async () => {
    const ctx = await setup();
    await provision(ctx);
    const results = await Promise.all([reveal(ctx), reveal(ctx), reveal(ctx)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 410, 410]);
  });

  it("expira por TTL (30 min) y ya no se puede ver", async () => {
    const ctx = await setup();
    await provision(ctx);
    ctx.clock.advance(31 * 60_000);

    expect(await status(ctx)).toMatchObject({ state: "expired" });
    const response = await reveal(ctx);
    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ state: "expired" });
  });

  it("si el secret ya existía de un intento anterior y el valor no está, lo indica y no la inventa", async () => {
    const ctx = await setup();
    // 1ª ejecución: se escribe INITIAL_ADMIN_PASSWORD y luego falla.
    let failOnce = true;
    ctx.github.faults.set("setEnvironmentVariable", () => {
      if (!failOnce) return undefined;
      failOnce = false;
      return new FatalError("github_rejected", "GitHub rechazó la petición.");
    });
    const { jobId } = await provision(ctx);
    // El valor se perdió (p. ej. la base se restauró sin el almacén temporal).
    await ctx.store.initialPasswords.deleteMany({});
    await ctx.store.clients.updateOne({ _id: "acme-crm" }, { $unset: { initialAdmin: "" } });

    await ctx.app.inject({ method: "POST", url: `/api/jobs/${jobId}/retry`, headers: ctx.headers });
    await ctx.app.engine.idle();

    expect(ctx.github.calls.filter((c) => c.method === "putEnvironmentSecret" && c.args[1] === "INITIAL_ADMIN_PASSWORD")).toHaveLength(1);
    expect(await status(ctx)).toMatchObject({ mode: "random", state: "unavailable" });
    const response = await reveal(ctx);
    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ state: "unavailable" });
  });

  it("modo default: no hay contraseña que revelar", async () => {
    const ctx = await setup();
    ctx.deps.config = { ...ctx.deps.config, initialAdmin: { mode: "default", revealTtlMs: 60_000 } };
    await provision(ctx);
    expect(await status(ctx)).toMatchObject({ mode: "default", state: "default", username: "admin" });
    expect((await reveal(ctx)).statusCode).toBe(410);
  });

  it("ninguna salida (logs, eventos, API, base administrativa) contiene SESSION_SECRET, INITIAL_ADMIN_PASSWORD ni la URI", async () => {
    const ctx = await setup();
    const { jobId } = await provision(ctx);
    const env = ctx.github.env("acme-crm-app");
    const secrets = ["SESSION_SECRET", "INITIAL_ADMIN_PASSWORD", "MONGODB_URI"].map((name) => env.secrets.get(name)!);

    // Antes de revelar: detalle, estado, trabajo y eventos.
    const before = [
      (await ctx.app.inject({ method: "GET", url: "/api/clients/acme-crm", headers: ctx.headers })).body,
      (await ctx.app.inject({ method: "GET", url: "/api/clients/acme-crm/initial-password", headers: ctx.headers })).body,
      (await ctx.app.inject({ method: "GET", url: `/api/jobs/${jobId}`, headers: ctx.headers })).body,
      (await ctx.app.inject({ method: "GET", url: `/api/jobs/${jobId}/events`, headers: ctx.headers })).body,
      (await ctx.app.inject({ method: "GET", url: "/api/projects", headers: ctx.headers })).body,
      JSON.stringify(await ctx.store.initialPasswords.find().toArray())
    ];
    // La revelación no deja rastro en logs ni en la base.
    expect((await reveal(ctx)).statusCode).toBe(200);
    const after = [
      ...ctx.logs,
      JSON.stringify({
        clients: await ctx.store.clients.find().toArray(),
        jobs: await ctx.store.jobs.find().toArray(),
        resources: await ctx.store.resources.find().toArray(),
        audit: await ctx.store.auditLog.find().toArray(),
        initialPasswords: await ctx.store.initialPasswords.find().toArray()
      })
    ];

    const outputs = [...before, ...after].join("\n");
    for (const secret of secrets) {
      expect(outputs).not.toContain(secret);
      expect(outputs).not.toContain(encodeURIComponent(secret));
    }
    for (const password of ctx.atlas.seenPasswords) expect(outputs).not.toContain(password);
    expect(outputs).not.toMatch(/mongodb(\+srv)?:\/\/(?!\[REDACTED\])/);
    // Sí se ven las referencias y los nombres.
    expect(outputs).toContain("INITIAL_ADMIN_PASSWORD");
    expect(outputs).toContain("SESSION_SECRET");
    expect(outputs).toContain("client_acme_crm");
  });
});
