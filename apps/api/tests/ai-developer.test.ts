import Anthropic from "@anthropic-ai/sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatEvent } from "../src/ai/events.js";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";
import { JobEngine } from "../src/jobs/engine.js";
import { clearRegisteredSecrets } from "../src/lib/redact.js";
import { freshStore, startDb, stopDb } from "./helpers/db.js";
import { FakeAgent } from "./helpers/fake-agent.js";
import { createFakes, silent } from "./helpers/fakes.js";

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

const REPO = "acme-crm-app";

async function setup({ withAi = true, provision = true } = {}) {
  const store = await freshStore();
  const fakes = createFakes(store);
  const agent = new FakeAgent();
  if (provision) {
    const job = await store.createClientWithJob({ slug: "acme-crm", name: "Acme CRM", description: "CRM interno de Acme", actor: "admin" });
    expect((await new JobEngine(store, fakes.deps, silent).run(job._id, "admin"))?.status).toBe("succeeded");
  }
  const app = await buildApp({
    store,
    deps: fakes.deps,
    logLevel: "silent",
    auth: { adminUsername: "admin", adminPasswordHash: passwordHash, sessionSecret: "x".repeat(40), secureCookies: false },
    ai: withAi ? { agent, config: { sessionBudgetCents: 1000, workspace: "default" } } : undefined
  });
  apps.push(app);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: ADMIN_PASSWORD } });
  const headers = { cookie: `pp_session=${login.cookies.find((c) => c.name === "pp_session")!.value}` };
  const api = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const response = await app.inject({ method, url, headers, payload: payload as never });
    return { status: response.statusCode, body: response.json(), raw: response.body };
  };
  return { app, store, agent, headers, api, ...fakes };
}

async function startSession(api: Awaited<ReturnType<typeof setup>>["api"], message?: string) {
  const response = await api("POST", "/api/clients/acme-crm/ai/sessions", { title: "Validaciones del registro", ...(message ? { message } : {}) });
  expect(response.status, response.raw).toBe(201);
  return response.body.session as { id: string; branch: string; status: string };
}

async function collect(iterable: AsyncIterable<ChatEvent>, count: number) {
  const out: ChatEvent[] = [];
  for await (const event of iterable) {
    out.push(event);
    if (out.length >= count) break;
  }
  return out;
}

describe("AI Developer: sesiones", () => {
  it("sin clave de Anthropic responde 503 y sin sesión 401", async () => {
    const { app, api } = await setup({ withAi: false, provision: false });
    expect((await api("GET", "/api/ai/status")).body).toMatchObject({ enabled: false });
    expect((await api("POST", "/api/clients/acme-crm/ai/sessions", { title: "Prueba" })).status).toBe(503);
    const id = "00000000-0000-4000-8000-000000000000";
    for (const [method, url] of [
      ["GET", "/api/ai/status"],
      ["GET", "/api/clients/acme-crm/ai/sessions"],
      ["POST", "/api/clients/acme-crm/ai/sessions"],
      ["GET", `/api/ai/sessions/${id}`],
      ["GET", `/api/ai/sessions/${id}/events`],
      ["POST", `/api/ai/sessions/${id}/messages`],
      ["POST", `/api/ai/sessions/${id}/confirm`],
      ["POST", `/api/ai/sessions/${id}/merge`],
      ["POST", `/api/ai/sessions/${id}/close`]
    ] as const) {
      expect((await app.inject({ method, url, payload: method === "POST" ? {} : undefined })).statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("crea la rama desde main y una sesión con el repo montado y un token limitado a ese repo", async () => {
    const { api, agent, github, store } = await setup();
    const session = await startSession(api, "Agrega validaciones al formulario de registro");

    expect(session.branch).toMatch(/^ai\/\d{8}-[0-9a-f]{8}$/);
    expect(github.branches.has(`${REPO}/${session.branch}`)).toBe(true);
    const [agentSession] = [...agent.sessions.values()];
    expect(agentSession.input).toMatchObject({
      repoUrl: `https://github.com/acme-org/${REPO}`,
      branch: session.branch,
      mountPath: "/workspace/app",
      budgetCents: 1000
    });
    // El token se pide solo para ese repo y se renueva antes de cada mensaje.
    expect(github.calls.filter((c) => c.method === "createRepoToken").map((c) => c.args[0])).toEqual([REPO, REPO]);
    expect(agent.calls).toEqual(["createSession", `rotate:res_${[...agent.sessions.keys()][0]}`, "sendMessage"]);
    // Contexto de operador con la rama y el aviso de revisión.
    expect(agent.systemMessages[0].text).toContain(`Rama de trabajo: ${session.branch}`);

    const doc = await store.aiSessions.findOne({ _id: session.id });
    expect(doc).toMatchObject({ clientId: "acme-crm", status: "active", repository: REPO, baseBranch: "main" });
    expect(await store.auditLog.countDocuments({ action: "ai.session_started" })).toBe(1);

    // Ningún token del repo sale en respuestas, base o auditoría.
    const outputs = JSON.stringify([
      (await api("GET", `/api/ai/sessions/${session.id}`)).body,
      (await api("GET", "/api/clients/acme-crm/ai/sessions")).body,
      await store.aiSessions.find().toArray(),
      await store.auditLog.find().toArray()
    ]);
    for (const token of github.issuedTokens) expect(outputs).not.toContain(token);
  });

  it("si a la GitHub App le faltan permisos lo dice antes de crear nada", async () => {
    const { api, github, agent } = await setup();
    github.installationPermissions = { administration: "write", contents: "read", actions: "write" };
    expect((await api("GET", "/api/ai/status")).body.missingPermissions).toEqual([
      "Contents: Read and write",
      "Pull requests: Read and write",
      "Checks: Read-only"
    ]);
    const response = await api("POST", "/api/clients/acme-crm/ai/sessions", { title: "Prueba" });
    expect(response.status).toBe(409);
    expect(response.body.error).toContain("Contents: Read and write");
    expect(github.count("createBranch")).toBe(0);
    expect(agent.sessions.size).toBe(0);
  });

  it("una sola sesión activa por proyecto, y solo con el proyecto listo", async () => {
    const { api, store } = await setup();
    await startSession(api);
    expect((await api("POST", "/api/clients/acme-crm/ai/sessions", { title: "Otra" })).status).toBe(409);

    await store.clients.updateOne({ _id: "acme-crm" }, { $set: { status: "failed" } });
    await store.aiSessions.updateMany({}, { $set: { status: "closed" } });
    expect((await api("POST", "/api/clients/acme-crm/ai/sessions", { title: "Otra" })).status).toBe(409);
  });

  it("si Anthropic no crea la sesión, borra la rama y no guarda nada", async () => {
    const { api, agent, github, store } = await setup();
    agent.failCreate = new Anthropic.AuthenticationError(401, undefined, "invalid x-api-key", new Headers());
    const response = await api("POST", "/api/clients/acme-crm/ai/sessions", { title: "Prueba" });
    expect(response.status).toBe(503);
    expect(response.body.error).toContain("clave de la API");
    expect([...github.branches.keys()].filter((k) => k.includes("/ai/"))).toEqual([]);
    expect(await store.aiSessions.countDocuments()).toBe(0);
  });

  it("si Anthropic rechaza la petición, el panel muestra su motivo", async () => {
    const { api, agent } = await setup();
    const body = { type: "error", error: { type: "invalid_request_error", message: "model: claude-x is not available" } };
    agent.failCreate = new Anthropic.BadRequestError(400, body, "400", new Headers());
    const response = await api("POST", "/api/clients/acme-crm/ai/sessions", { title: "Prueba" });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("Anthropic rechazó la petición: model: claude-x is not available");
  });

  it("retransmite historial y eventos en vivo sin duplicados, y pide confirmación de herramientas", async () => {
    const { app, api, agent } = await setup();
    const session = await startSession(api, "Hola");
    const agentId = [...agent.sessions.keys()][0];

    const controller = new AbortController();
    const stream = app.aiDeveloper!.events((await app.store.aiSessions.findOne({ _id: session.id }))!, controller.signal);
    const firstThree = collect(stream, 4);
    // Mientras se lee el historial llega un evento nuevo que pide permiso.
    setTimeout(() => agent.emit(agentId, { type: "agent.tool_use", name: "bash", input: { command: "rm -rf node_modules" }, evaluated_permission: "ask" }), 10);
    const events = await firstThree;
    controller.abort();

    expect(events.map((e) => e.kind)).toEqual(["user", "assistant", "status", "tool"]);
    expect(events[3]).toMatchObject({ tool: "bash", summary: "$ rm -rf node_modules", needsConfirmation: true });

    const confirm = await api("POST", `/api/ai/sessions/${session.id}/confirm`, { toolUseId: events[3].id, allow: false });
    expect(confirm.status).toBe(200);
    expect(agent.confirmations[0]).toMatchObject({ toolUseId: events[3].id, allow: false });
    expect(agent.confirmations[0].denyMessage).toContain("no aprobó");
  });

  it("el stream HTTP envía NDJSON redactado", async () => {
    const { app, api, agent } = await setup();
    const session = await startSession(api);
    const agentId = [...agent.sessions.keys()][0];
    agent.emit(agentId, { type: "agent.message", content: [{ type: "text", text: "Usé el token ghs_abcdefghijklmnopqrstuvwxyz0123456789 por error" }] });

    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as { port: number };
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: ADMIN_PASSWORD } });
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/api/ai/sessions/${session.id}/events`, {
      headers: { cookie: `pp_session=${login.cookies.find((c) => c.name === "pp_session")!.value}` },
      signal: controller.signal
    });
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const reader = response.body!.getReader();
    let text = "";
    while (!text.includes("REDACTED")) text += new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    expect(text).not.toContain("ghs_abcdefghijklmnop");
    expect(JSON.parse(text.trim().split("\n")[0])).toMatchObject({ kind: "assistant" });
  });
});

describe("AI Developer: revisión, Pull Request y merge", () => {
  it("diff, PR, validaciones y merge con despliegue al hacer push a main", async () => {
    const { api, github, agent, store } = await setup();
    const session = await startSession(api);

    expect((await api("POST", `/api/ai/sessions/${session.id}/pull-request`)).status).toBe(409);

    github.pushCommit(REPO, session.branch, "feat: validaciones del registro");
    const diff = await api("GET", `/api/ai/sessions/${session.id}/diff`);
    expect(diff.body).toMatchObject({ aheadBy: 1, truncated: false });
    expect(diff.body.files[0].patch).toContain("validaciones");

    const pr = await api("POST", `/api/ai/sessions/${session.id}/pull-request`);
    expect(pr.status).toBe(200);
    expect(pr.body.pullRequest.number).toBe(1);
    const created = [...github.pulls.values()][0];
    expect(created).toMatchObject({ head: session.branch, base: "main", title: "Validaciones del registro" });
    expect(created.body).toContain("- feat: validaciones del registro");

    // Validaciones: sin checks, en curso o fallidas, no se fusiona.
    const head = created.headSha;
    for (const [checks, message] of [
      [{ total: 0, pending: 0, failed: 0, checks: [] }, "aún no han empezado"],
      [{ total: 1, pending: 1, failed: 0, checks: [] }, "ejecutando"],
      [{ total: 1, pending: 0, failed: 1, checks: [] }, "fallidas"]
    ] as const) {
      github.checks.set(head, checks);
      const blocked = await api("POST", `/api/ai/sessions/${session.id}/merge`, { confirm: true });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toContain(message);
    }
    github.checks.delete(head);
    github.mergeable = false;
    expect((await api("POST", `/api/ai/sessions/${session.id}/merge`, { confirm: true })).body.error).toContain("conflictos");
    github.mergeable = true;

    expect((await api("POST", `/api/ai/sessions/${session.id}/merge`, {})).status).toBe(400);
    const merged = await api("POST", `/api/ai/sessions/${session.id}/merge`, { confirm: true });
    expect(merged.status, merged.raw).toBe(200);
    expect(merged.body).toMatchObject({ deploying: true, actionsUrl: `https://github.com/acme-org/${REPO}/actions` });

    expect(github.branches.get(`${REPO}/main`)!.at(-1)!.message).toBe("Validaciones del registro (#1)");
    expect(github.branches.has(`${REPO}/${session.branch}`)).toBe(false);
    expect(agent.interrupts).toHaveLength(1);
    expect(await store.aiSessions.findOne({ _id: session.id })).toMatchObject({ status: "merged" });
    expect(await store.auditLog.countDocuments({ action: "ai.merged" })).toBe(1);
    // Cerrada: ya no acepta mensajes y se puede abrir otra.
    expect((await api("POST", `/api/ai/sessions/${session.id}/messages`, { text: "otra cosa" })).status).toBe(409);
    await startSession(api);
  });

  it("avisa si el agente hizo push directamente a main", async () => {
    const { api, github } = await setup();
    const session = await startSession(api);
    expect((await api("GET", `/api/ai/sessions/${session.id}/review`)).body).toMatchObject({ mainTouched: false, pullRequest: null });
    github.pushCommit(REPO, "main", "cambio directo");
    expect((await api("GET", `/api/ai/sessions/${session.id}/review`)).body.mainTouched).toBe(true);
  });

  it("cerrar sin cambios borra la rama; ampliar presupuesto suma otro tramo", async () => {
    const { api, github, agent, store } = await setup();
    const session = await startSession(api);
    const agentId = [...agent.sessions.keys()][0];
    agent.sessions.get(agentId)!.costCents = 1004;
    expect((await api("POST", `/api/ai/sessions/${session.id}/budget`)).body).toEqual({ budgetCents: 2004 });

    expect((await api("POST", `/api/ai/sessions/${session.id}/close`)).status).toBe(200);
    expect(github.branches.has(`${REPO}/${session.branch}`)).toBe(false);
    expect(await store.aiSessions.findOne({ _id: session.id })).toMatchObject({ status: "closed", closedBy: "admin" });
  });

  it("no se puede borrar el proyecto con una sesión activa", async () => {
    const { api } = await setup();
    await startSession(api);
    const response = await api("POST", "/api/clients/acme-crm/delete", { confirm: "acme-crm" });
    expect(response.status).toBe(409);
    expect(response.body.error).toContain("AI Developer");
  });
});
