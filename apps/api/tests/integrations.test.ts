import { Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";
import { INTEGRATIONS, MONDAY_API_URL, MONDAY_API_VERSION } from "../src/integrations/catalog.js";
import { FatalError } from "../src/lib/errors.js";
import { clearRegisteredSecrets } from "../src/lib/redact.js";
import { freshStore, startDb, stopDb } from "./helpers/db.js";
import { createFakes } from "./helpers/fakes.js";

const ADMIN_PASSWORD = "correct horse battery staple";
const TOKEN = "token-valido-eyJhbGciOiJIUzI1NiJ9-monday-0123456789";
const TOKEN_2 = "token-valido-segundo-9876543210-abcdef";
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
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: ADMIN_PASSWORD } });
  const headers = { cookie: `pp_session=${login.cookies.find((c) => c.name === "pp_session")!.value}` };
  const create = async (payload: Record<string, unknown> = {}) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers,
      payload: { name: "Acme CRM", slug: "acme-crm", description: "CRM interno de Acme", ...payload }
    });
    await app.engine.idle();
    return response;
  };
  const put = async (token: string, slug = "acme-crm") => {
    const response = await app.inject({ method: "PUT", url: `/api/clients/${slug}/integrations/monday`, headers, payload: { token } });
    await app.engine.idle();
    return response;
  };
  const detail = async () => (await app.inject({ method: "GET", url: "/api/clients/acme-crm", headers })).json();
  const writes = (name: string) => fakes.github.calls.filter((c) => c.method === "putEnvironmentSecret" && c.args[1] === name).length;
  return { app, store, logs, headers, create, put, detail, writes, ...fakes };
}

describe("catálogo y prueba de conexión", () => {
  it("el catálogo no incluye funciones ni secretos, y exige sesión", async () => {
    const ctx = await setup();
    expect((await ctx.app.inject({ method: "GET", url: "/api/integrations/catalog" })).statusCode).toBe(401);
    const catalog = (await ctx.app.inject({ method: "GET", url: "/api/integrations/catalog", headers: ctx.headers })).json();
    expect(catalog.available).toBe(true);
    expect(catalog.providers).toEqual([
      expect.objectContaining({
        id: "monday",
        label: "Monday.com",
        fields: [{ name: "token", label: "Token de la API", type: "secret", maxLength: 2000 }]
      })
    ]);
    expect(catalog.providers[0].help.join(" ")).toContain("usuario dedicado");
    expect(JSON.stringify(catalog)).not.toContain("MONDAY_API_TOKEN");
  });

  it("Probar conexión: ok, o un código genérico; auditado sin valores", async () => {
    const ctx = await setup();
    const validate = (payload: unknown) =>
      ctx.app.inject({ method: "POST", url: "/api/integrations/monday/validate", headers: ctx.headers, payload: payload as object });
    expect((await validate({ token: TOKEN })).json()).toEqual({ ok: true });
    expect((await validate({ token: "token-malo-123456" })).json()).toMatchObject({ ok: false, code: "auth_failed" });
    ctx.integrationCheck.failWith = { ok: false, code: "timeout" };
    expect((await validate({ token: TOKEN })).json()).toMatchObject({ ok: false, code: "timeout" });
    expect((await validate({ token: TOKEN, extra: 1 })).statusCode).toBe(400);
    expect((await validate({})).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: "POST", url: "/api/integrations/nope/validate", headers: ctx.headers, payload: { token: TOKEN } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "POST", url: "/api/integrations/monday/validate", payload: { token: TOKEN } })).statusCode).toBe(401);
    const audit = await ctx.store.auditLog.find({ action: "integration_validated" }).toArray();
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain(TOKEN);
  });

  it("Probar conexión tiene límite de peticiones", async () => {
    const ctx = await setup();
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      codes.push((await ctx.app.inject({ method: "POST", url: "/api/integrations/monday/validate", headers: ctx.headers, payload: { token: TOKEN } })).statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });
});

describe("validación de Monday contra su API (host fijo)", () => {
  const monday = INTEGRATIONS.monday;
  type Call = { url: string; init: RequestInit };
  const fake = (respond: () => Promise<Response> | Response) => {
    const calls: Call[] = [];
    const fn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond();
    }) as unknown as typeof fetch;
    return { fn, calls };
  };

  it("consulta https://api.monday.com/v2 con Authorization, API-Version, timeout y sin seguir redirecciones", async () => {
    const { fn, calls } = fake(() => new Response(JSON.stringify({ data: { me: { id: "123" } } }), { status: 200 }));
    expect(await monday.validate({ token: TOKEN }, fn)).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(MONDAY_API_URL);
    expect(calls[0].init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(TOKEN);
    expect(headers["API-Version"]).toBe(MONDAY_API_VERSION);
  });

  it("401 o errores de GraphQL → auth_failed; redirección o 5xx → unavailable; timeout → timeout", async () => {
    expect(await monday.validate({ token: TOKEN }, fake(() => new Response("{}", { status: 401 })).fn)).toEqual({ ok: false, code: "auth_failed" });
    expect(
      await monday.validate({ token: TOKEN }, fake(() => new Response(JSON.stringify({ errors: [{ message: "Not Authenticated" }] }), { status: 200 })).fn)
    ).toEqual({ ok: false, code: "auth_failed" });
    expect(await monday.validate({ token: TOKEN }, fake(() => new Response(null, { status: 302, headers: { location: "https://evil.example" } })).fn)).toEqual({
      ok: false,
      code: "unavailable"
    });
    expect(await monday.validate({ token: TOKEN }, fake(() => new Response("", { status: 503 })).fn)).toEqual({ ok: false, code: "unavailable" });
    const timeout = fake(() => Promise.reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })));
    expect(await monday.validate({ token: TOKEN }, timeout.fn)).toEqual({ ok: false, code: "timeout" });
  });
});

describe("crear un cliente con Monday activado", () => {
  it("Zod estricto: campos extra, proveedores desconocidos o credencial vacía → 400", async () => {
    const ctx = await setup();
    for (const integrations of [{ monday: { token: TOKEN, otro: "x" } }, { otro: { token: TOKEN } }, { monday: {} }, { monday: { token: "" } }, { monday: { token: "con espacio" } }]) {
      const response = await ctx.create({ integrations });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain(TOKEN);
    }
    expect(await ctx.store.getClient("acme-crm")).toBeNull();
  });

  it("flujo completo: el secret queda en el entorno production y la colección transitoria vacía", async () => {
    const ctx = await setup();
    expect((await ctx.create({ integrations: { monday: { token: TOKEN } } })).statusCode).toBe(202);
    const env = ctx.github.env("acme-crm-app");
    expect(env.secrets.get("MONDAY_API_TOKEN")).toBe(TOKEN);
    expect(await ctx.store.provisioningSecrets.countDocuments()).toBe(0);
    const client = await ctx.store.getClient("acme-crm");
    expect(client?.status).toBe("ready");
    expect(client?.integrations?.monday).toMatchObject({ enabled: true });
    expect(client?.integrations?.monday?.configuredAt).toBeInstanceOf(Date);
    const view = (await ctx.detail()).client.integrations;
    expect(view).toEqual([{ provider: "monday", enabled: true, configuredAt: expect.any(String), updatedAt: expect.any(String) }]);
    expect((await ctx.store.auditLog.find({ action: "integration_enabled" }).toArray())).toHaveLength(1);
  });

  it("sin integraciones no se escribe nada de Monday", async () => {
    const ctx = await setup();
    await ctx.create();
    expect(ctx.github.env("acme-crm-app").secrets.has("MONDAY_API_TOKEN")).toBe(false);
    expect((await ctx.detail()).client.integrations).toEqual([]);
  });

  it("un reintento tras un fallo posterior a los secrets no duplica nada", async () => {
    const ctx = await setup();
    let failOnce = true;
    ctx.github.faults.set("setEnvironmentVariable", () => {
      if (!failOnce || ctx.github.calls.at(-1)?.args[1] !== "APP_DISPLAY_NAME") return undefined;
      failOnce = false;
      return new FatalError("github_rejected", "x");
    });
    const { jobId } = (await ctx.create({ integrations: { monday: { token: TOKEN } } })).json();
    expect((await ctx.store.getClient("acme-crm"))?.status).toBe("failed");
    await ctx.app.inject({ method: "POST", url: `/api/jobs/${jobId}/retry`, headers: ctx.headers });
    await ctx.app.engine.idle();
    expect((await ctx.store.getClient("acme-crm"))?.status).toBe("ready");
    expect(ctx.writes("MONDAY_API_TOKEN")).toBe(1);
    expect(await ctx.store.provisioningSecrets.countDocuments()).toBe(0);
  });

  it("si la credencial caduca antes de github_secrets, el trabajo falla con un mensaje accionable", async () => {
    const ctx = await setup();
    ctx.mongo.faults.set("bootstrap", () => new FatalError("mongodb_error", "x"));
    const { jobId } = (await ctx.create({ integrations: { monday: { token: TOKEN } } })).json();
    ctx.mongo.faults.delete("bootstrap");
    ctx.clock.advance(25 * 3_600_000);
    await ctx.app.inject({ method: "POST", url: `/api/jobs/${jobId}/retry`, headers: ctx.headers });
    await ctx.app.engine.idle();
    const job = (await ctx.app.inject({ method: "GET", url: `/api/jobs/${jobId}`, headers: ctx.headers })).json();
    const failed = job.stages.find((s: { status: string }) => s.status === "failed");
    expect(failed.name).toBe("github_secrets");
    expect(failed.error.code).toBe("integration_credential_expired");
    expect(failed.error.message).toContain("detalle del cliente");
  });
});

describe("cifrado transitorio", () => {
  it("el AAD impide mover el texto cifrado a otro cliente o proveedor; el TTL vence; nunca hay texto plano", async () => {
    const ctx = await setup();
    await ctx.secrets.put("acme-crm", "monday", { token: TOKEN });
    const doc = (await ctx.store.provisioningSecrets.findOne({ _id: "acme-crm:monday" }))!;
    expect(Object.keys(doc).sort()).toEqual(["_id", "authTag", "ciphertext", "clientId", "createdAt", "expiresAt", "iv", "provider"]);
    expect(JSON.stringify(doc)).not.toContain(TOKEN);
    expect(await ctx.secrets.get("acme-crm", "monday")).toEqual({ token: TOKEN });

    await ctx.store.provisioningSecrets.insertOne({ ...doc, _id: "otro-cliente:monday", clientId: "otro-cliente" });
    await expect(ctx.secrets.get("otro-cliente", "monday")).rejects.toThrow();
    await ctx.store.provisioningSecrets.insertOne({ ...doc, _id: "acme-crm:otro", provider: "otro" });
    await expect(ctx.secrets.get("acme-crm", "otro")).rejects.toThrow();

    ctx.clock.advance(24 * 3_600_000 + 1);
    expect(await ctx.secrets.get("acme-crm", "monday")).toBeNull();
    const index = (await ctx.store.provisioningSecrets.indexes()).find((i) => i.name === "ttl");
    expect(index ?? null).toBeNull(); // el índice TTL lo crea init() en el arranque
    await ctx.secrets.init();
    expect((await ctx.store.provisioningSecrets.indexes()).find((i) => i.name === "ttl")).toMatchObject({ expireAfterSeconds: 0 });
  });
});

describe("actualizar o quitar la integración de un cliente existente", () => {
  it("exige sesión y credenciales válidas con Zod estricto", async () => {
    const ctx = await setup();
    await ctx.create();
    expect((await ctx.app.inject({ method: "PUT", url: "/api/clients/acme-crm/integrations/monday", payload: { token: TOKEN } })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "DELETE", url: "/api/clients/acme-crm/integrations/monday" })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "PUT", url: "/api/clients/acme-crm/integrations/monday", headers: ctx.headers, payload: { token: TOKEN, x: 1 } })).statusCode).toBe(400);
    const bad = await ctx.put("token-malo-123456");
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ code: "auth_failed" });
  });

  it("cliente listo: escribe la credencial y redespliega, como trabajo seguido en el panel", async () => {
    const ctx = await setup();
    await ctx.create({ integrations: { monday: { token: TOKEN } } });
    const dispatches = ctx.github.count("dispatchWorkflow");
    const response = await ctx.put(TOKEN_2);
    expect(response.statusCode).toBe(202);
    expect(response.json().action).toBe("redeploy");
    const job = (await ctx.app.inject({ method: "GET", url: `/api/jobs/${response.json().jobId}`, headers: ctx.headers })).json();
    expect(job.status).toBe("succeeded");
    expect(job.stages.map((s: { name: string }) => s.name)).toEqual(["integration_secret", "deploy", "health_check"]);
    expect(ctx.github.env("acme-crm-app").secrets.get("MONDAY_API_TOKEN")).toBe(TOKEN_2);
    expect(ctx.github.count("dispatchWorkflow")).toBe(dispatches + 1);
    expect(await ctx.store.provisioningSecrets.countDocuments()).toBe(0);
    expect(await ctx.store.auditLog.countDocuments({ action: "integration_updated" })).toBe(1);
    expect((await ctx.detail()).job.id).toBe(job.id);
  });

  it("cliente listo sin Monday: la activa (integration_enabled)", async () => {
    const ctx = await setup();
    await ctx.create();
    expect((await ctx.put(TOKEN)).statusCode).toBe(202);
    expect(ctx.github.env("acme-crm-app").secrets.get("MONDAY_API_TOKEN")).toBe(TOKEN);
    expect(await ctx.store.auditLog.countDocuments({ action: "integration_enabled" })).toBe(1);
  });

  it("cliente failed antes de github_secrets: guarda la credencial cifrada y el reintento la escribe", async () => {
    const ctx = await setup();
    ctx.mongo.faults.set("bootstrap", () => new FatalError("mongodb_error", "x"));
    const { jobId } = (await ctx.create()).json();
    ctx.mongo.faults.delete("bootstrap");
    const response = await ctx.put(TOKEN);
    expect(response.statusCode).toBe(202);
    expect(response.json().action).toBe("stored");
    expect(await ctx.store.provisioningSecrets.countDocuments()).toBe(1);
    expect(ctx.writes("MONDAY_API_TOKEN")).toBe(0);
    await ctx.app.inject({ method: "POST", url: `/api/jobs/${jobId}/retry`, headers: ctx.headers });
    await ctx.app.engine.idle();
    expect(ctx.github.env("acme-crm-app").secrets.get("MONDAY_API_TOKEN")).toBe(TOKEN);
    expect(await ctx.store.provisioningSecrets.countDocuments()).toBe(0);
  });

  it("cliente failed después de github_secrets: escribe en GitHub sin redesplegar; el reintento despliega", async () => {
    const ctx = await setup();
    ctx.github.nextRunConclusion = "failure";
    const { jobId } = (await ctx.create()).json();
    const dispatches = ctx.github.count("dispatchWorkflow");
    const response = await ctx.put(TOKEN);
    expect(response.statusCode).toBe(200);
    expect(response.json().action).toBe("written");
    expect(ctx.github.env("acme-crm-app").secrets.get("MONDAY_API_TOKEN")).toBe(TOKEN);
    expect(ctx.github.count("dispatchWorkflow")).toBe(dispatches);
    expect(await ctx.store.provisioningSecrets.countDocuments()).toBe(0);
    ctx.github.nextRunConclusion = "success";
    await ctx.app.inject({ method: "POST", url: `/api/jobs/${jobId}/retry`, headers: ctx.headers });
    await ctx.app.engine.idle();
    expect((await ctx.store.getClient("acme-crm"))?.status).toBe("ready");
    expect(ctx.github.count("dispatchWorkflow")).toBe(dispatches + 1);
  });

  it("cliente en aprovisionamiento: 409", async () => {
    const ctx = await setup();
    await ctx.store.createClientWithJob({ slug: "acme-crm", name: "Acme CRM", description: "CRM interno de Acme", actor: "admin" });
    expect((await ctx.put(TOKEN)).statusCode).toBe(409);
    expect((await ctx.app.inject({ method: "DELETE", url: "/api/clients/acme-crm/integrations/monday", headers: ctx.headers })).statusCode).toBe(409);
  });

  it("desactivar: borra el secret y redespliega; auditado; 409 si no está listo", async () => {
    const ctx = await setup();
    await ctx.create({ integrations: { monday: { token: TOKEN } } });
    const dispatches = ctx.github.count("dispatchWorkflow");
    const response = await ctx.app.inject({ method: "DELETE", url: "/api/clients/acme-crm/integrations/monday", headers: ctx.headers });
    await ctx.app.engine.idle();
    expect(response.statusCode).toBe(202);
    expect(ctx.github.env("acme-crm-app").secrets.has("MONDAY_API_TOKEN")).toBe(false);
    expect(ctx.github.count("dispatchWorkflow")).toBe(dispatches + 1);
    expect(await ctx.store.auditLog.countDocuments({ action: "integration_removed" })).toBe(1);
    expect((await ctx.detail()).client.integrations).toEqual([]);
    expect((await ctx.app.inject({ method: "DELETE", url: "/api/clients/acme-crm/integrations/monday", headers: ctx.headers })).statusCode).toBe(404);
  });
});

describe("ninguna salida contiene credenciales", () => {
  it("logs, eventos, auditoría, respuestas y base administrativa (fuera del cifrado transitorio)", async () => {
    const ctx = await setup();
    const { jobId } = (await ctx.create({ integrations: { monday: { token: TOKEN } } })).json();
    await ctx.put(TOKEN_2);
    // Un cuerpo malformado con la credencial no se devuelve ni se registra.
    const malformed = await ctx.app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { ...ctx.headers, "content-type": "application/json" },
      payload: `{"name":"x","integrations":{"monday":{"token":"${TOKEN}"}`
    });
    expect(malformed.statusCode).toBe(400);
    // JSON inválido cuyo mensaje de error cita el texto recibido (token sin comillas).
    const quoted = await ctx.app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { ...ctx.headers, "content-type": "application/json" },
      payload: `{"integrations":{"monday":{"token":${TOKEN}}}}`
    });
    expect(quoted.statusCode).toBe(400);
    const outputs = [
      malformed.body,
      quoted.body,
      ...ctx.logs,
      (await ctx.app.inject({ method: "GET", url: "/api/clients/acme-crm", headers: ctx.headers })).body,
      (await ctx.app.inject({ method: "GET", url: `/api/jobs/${jobId}`, headers: ctx.headers })).body,
      (await ctx.app.inject({ method: "GET", url: `/api/jobs/${jobId}/events`, headers: ctx.headers })).body,
      (await ctx.app.inject({ method: "GET", url: "/api/integrations/catalog", headers: ctx.headers })).body,
      (await ctx.app.inject({ method: "GET", url: "/api/dashboard", headers: ctx.headers })).body,
      JSON.stringify({
        clients: await ctx.store.clients.find().toArray(),
        jobs: await ctx.store.jobs.find().toArray(),
        resources: await ctx.store.resources.find().toArray(),
        audit: await ctx.store.auditLog.find().toArray()
      })
    ].join("\n");
    for (const token of [TOKEN, TOKEN_2]) expect(outputs).not.toContain(token);
  });
});
