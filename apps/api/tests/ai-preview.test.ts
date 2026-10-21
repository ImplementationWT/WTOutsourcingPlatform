import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";
import { JobEngine } from "../src/jobs/engine.js";
import { clearRegisteredSecrets } from "../src/lib/redact.js";
import { freshStore, startDb, stopDb } from "./helpers/db.js";
import { FakeAgent } from "./helpers/fake-agent.js";
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

const REPO = "acme-crm-app";
const HOST = "preview-acme-crm.apps.example.test";

async function setup() {
  const store = await freshStore();
  const fakes = createFakes(store);
  const agent = new FakeAgent();
  const job = await store.createClientWithJob({ teamId: TEST_TEAM_ID, slug: "acme-crm", name: "Acme CRM", description: "CRM interno de Acme", actor: "admin" });
  expect((await new JobEngine(store, fakes.deps, silent).run(job._id, "admin"))?.status).toBe("succeeded");
  const time = { t: Date.now() };
  const app = await buildApp({
    store,
    deps: fakes.deps,
    logLevel: "silent",
    auth: { adminUsername: "jefe", adminPasswordHash: passwordHash, sessionSecret: "x".repeat(40), secureCookies: true },
    ai: { agent, config: { sessionBudgetCents: 1000, workspace: "default" }, now: () => new Date(time.t) }
  });
  apps.push(app);
  await seedUser(store, passwordHash);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: ADMIN_PASSWORD } });
  const headers = { cookie: `pp_session=${login.cookies.find((c) => c.name === "pp_session")!.value}` };
  const api = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const response = await app.inject({ method, url, headers, payload: payload as never });
    return { status: response.statusCode, body: response.json(), raw: response.body };
  };
  const created = await api("POST", "/api/clients/acme-crm/ai/sessions", { title: "Validaciones del registro" });
  expect(created.status, created.raw).toBe(201);
  return { ...fakes, app, store, agent, api, time, session: created.body.session as { id: string; branch: string } };
}

/** Simula a nginx: canjea el pase del iframe y valida la cookie. */
async function viaNginx(app: Awaited<ReturnType<typeof buildApp>>, frameUrl: string, host = HOST) {
  const url = new URL(frameUrl);
  const auth = await app.inject({ method: "GET", url: `/api/ai/preview/auth${url.search}`, headers: { "x-preview-host": host } });
  const cookie = auth.headers["set-cookie"] as string | undefined;
  const value = cookie?.match(/lp_preview=([^;]+)/)?.[1];
  /** null: sin cookie. */
  const check = async (pass: string | null | undefined = value) =>
    (await app.inject({ method: "GET", url: "/api/ai/preview/check", headers: { "x-preview-host": host, ...(pass ? { "x-preview-pass": pass } : {}) } })).statusCode;
  return { auth, cookie, value, check };
}

describe("AI Developer: vista previa", () => {
  it("arranca la rama en vivo en el servidor (sin GitHub Actions) y queda lista con un pase de acceso", async () => {
    const { api, app, session, server, github, store } = await setup();
    const started = await api("POST", `/api/ai/sessions/${session.id}/preview`);
    expect(started.status, started.raw).toBe(200);
    expect(started.body.preview).toMatchObject({ status: "installing", url: `https://${HOST}`, frameUrl: null });
    await app.aiDeveloper!.previewIdle();
    expect(server.calls.filter((c) => c.method === "installPreview").map((c) => c.args[0])).toEqual(["acme-crm"]);
    const live = server.calls.find((c) => c.method === "startLivePreview")!;
    expect(live.args[0]).toBe("acme-crm");
    expect(live.args[1]).toMatchObject({ repository: `acme-org/${REPO}`, branch: session.branch, token: expect.stringMatching(/^ghs_/) });
    // El servidor clona con un token de solo lectura; nada pasa por GitHub Actions.
    expect(github.calls.filter((c) => c.method === "createRepoToken" && c.args[1] === "read")).toHaveLength(1);
    expect(github.calls.some((c) => c.method === "dispatchWorkflow" && c.args[1] === "preview.yml")).toBe(false);

    const state = await api("GET", `/api/ai/sessions/${session.id}/preview`);
    expect(state.body.preview).toMatchObject({ status: "ready", outdated: false, updating: false, sha: await github.getBranchSha(REPO, session.branch) });
    expect(state.body.preview.frameUrl).toMatch(new RegExp(`^https://${HOST.replace(/\./g, "\\.")}/__launchpad/auth\\?t=`));
    expect(await store.auditLog.countDocuments({ action: "ai.preview_ready" })).toBe(1);

    // El pase sirve una vez, solo para ese host, y deja una cookie segura de ese host.
    const nginx = await viaNginx(app, state.body.preview.frameUrl);
    expect(nginx.auth.statusCode).toBe(302);
    expect(nginx.auth.headers.location).toBe("/");
    expect(nginx.cookie).toMatch(/HttpOnly/);
    expect(nginx.cookie).toMatch(/Secure/);
    expect(await nginx.check()).toBe(204);
    expect(await nginx.check("manipulada")).toBe(401);
    expect(await nginx.check(null)).toBe(401);
    expect((await viaNginx(app, state.body.preview.frameUrl)).auth.statusCode).toBe(401);
    expect((await viaNginx(app, (await api("GET", `/api/ai/sessions/${session.id}/preview`)).body.preview.frameUrl, "preview-otro.apps.example.test")).auth.statusCode).toBe(401);
    // La cookie de un host no vale en otro.
    expect(
      (await app.inject({ method: "GET", url: "/api/ai/preview/check", headers: { "x-preview-host": "preview-otro.apps.example.test", "x-preview-pass": nginx.value! } })).statusCode
    ).toBe(401);

  });

  it("cada commit nuevo de Claude se trae solo a la vista en vivo, sin reconstruir", async () => {
    const { api, app, session, server, github } = await setup();
    await api("POST", `/api/ai/sessions/${session.id}/preview`);
    await app.aiDeveloper!.previewIdle();
    const sha = github.pushCommit(REPO, session.branch, "otro cambio");

    // La consulta del panel detecta el commit y lo trae en segundo plano.
    const seen = (await api("GET", `/api/ai/sessions/${session.id}/preview`)).body.preview;
    expect(seen).toMatchObject({ status: "ready", outdated: true });
    await app.aiDeveloper!.previewIdle();
    expect(server.count("updateLivePreview")).toBe(1);
    expect(server.count("startLivePreview")).toBe(1);
    expect((await api("GET", `/api/ai/sessions/${session.id}/preview`)).body.preview).toMatchObject({ sha, outdated: false, updating: false });
    // Sin commits nuevos no se vuelve a pedir.
    await api("GET", `/api/ai/sessions/${session.id}/preview`);
    await app.aiDeveloper!.previewIdle();
    expect(server.count("updateLivePreview")).toBe(1);
  });

  it("arranca sola al abrir la conversación, aunque Claude aún no haya cambiado nada", async () => {
    const { api, app, session, server, github } = await setup();
    expect(server.count("installPreview")).toBe(0);
    expect((await api("GET", `/api/ai/sessions/${session.id}/preview`)).body.preview.status).toBe("installing");
    await app.aiDeveloper!.previewIdle();
    const ready = (await api("GET", `/api/ai/sessions/${session.id}/preview`)).body.preview;
    expect(ready).toMatchObject({ status: "ready", sha: await github.getBranchSha(REPO, "main") });
    expect(server.count("startLivePreview")).toBe(1);
  });

  it("solo redirige a rutas del mismo host tras canjear el pase", async () => {
    const { api, app, session } = await setup();
    await api("POST", `/api/ai/sessions/${session.id}/preview`);
    await app.aiDeveloper!.previewIdle();
    for (const [next, expected] of [
      ["/registro?x=1", "/registro?x=1"],
      ["//evil.example", "/"],
      ["/\\evil.example", "/"],
      ["https://evil.example", "/"]
    ]) {
      const frameUrl = (await api("GET", `/api/ai/sessions/${session.id}/preview`)).body.preview.frameUrl as string;
      const { auth } = await viaNginx(app, `${frameUrl}&next=${encodeURIComponent(next)}`);
      expect(auth.headers.location, next).toBe(expected);
    }
  });

  it("si no arranca (p. ej. repo sin pnpm dev:preview) queda como fallida con el motivo, y no se relanza sola", async () => {
    const { api, app, session, server, github } = await setup();
    server.liveFailure = "el repo no tiene pnpm dev:preview (plantilla anterior a 1.6.0)";
    github.pushCommit(REPO, session.branch, "cambio");
    await api("POST", `/api/ai/sessions/${session.id}/preview`);
    await app.aiDeveloper!.previewIdle();
    const failed = (await api("GET", `/api/ai/sessions/${session.id}/preview`)).body.preview;
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("pnpm dev:preview");
    await api("GET", `/api/ai/sessions/${session.id}/preview`);
    await app.aiDeveloper!.previewIdle();
    expect(server.count("startLivePreview")).toBe(1);

    // Corregido el repo, reintentar la arranca.
    server.liveFailure = null;
    await api("POST", `/api/ai/sessions/${session.id}/preview`);
    await app.aiDeveloper!.previewIdle();
    expect((await api("GET", `/api/ai/sessions/${session.id}/preview`)).body.preview.status).toBe("ready");
  });

  it("se apaga sola tras una hora sin visitas; cada visita la mantiene encendida; al volver arranca otra vez", async () => {
    const { api, app, session, server, time, store } = await setup();
    await api("POST", `/api/ai/sessions/${session.id}/preview`);
    await app.aiDeveloper!.previewIdle();
    const frameUrl = (await api("GET", `/api/ai/sessions/${session.id}/preview`)).body.preview.frameUrl;
    const nginx = await viaNginx(app, frameUrl);

    time.t += 50 * 60_000;
    expect(await nginx.check()).toBe(204); // visita: alarga la caducidad
    time.t += 50 * 60_000;
    expect(await app.aiDeveloper!.sweepPreviews()).toBe(0);

    time.t += 61 * 60_000;
    expect(await app.aiDeveloper!.sweepPreviews()).toBe(1);
    expect(server.count("stopPreview")).toBe(1);
    expect((await store.aiSessions.findOne({ _id: session.id }))?.preview?.status).toBe("stopped");
    expect(await nginx.check()).toBe(401);

    // Al volver al panel se levanta de nuevo sola.
    expect((await api("GET", `/api/ai/sessions/${session.id}/preview`)).body.preview.status).toBe("installing");
    await app.aiDeveloper!.previewIdle();
    expect(server.count("startLivePreview")).toBe(2);
  });

  it("parada a mano no se relanza sola", async () => {
    const { api, app, session, server, github } = await setup();
    github.pushCommit(REPO, session.branch, "cambio");
    await api("POST", `/api/ai/sessions/${session.id}/preview`);
    await app.aiDeveloper!.previewIdle();
    await api("POST", `/api/ai/sessions/${session.id}/preview/stop`);
    expect((await api("GET", `/api/ai/sessions/${session.id}/preview`)).body.preview.status).toBe("stopped");
    await app.aiDeveloper!.previewIdle();
    expect(server.count("startLivePreview")).toBe(1);
  });

  it("fusionar o cerrar la sesión para la vista previa", async () => {
    const { api, app, session, github, server } = await setup();
    await api("POST", `/api/ai/sessions/${session.id}/preview`);
    await app.aiDeveloper!.previewIdle();
    github.pushCommit(REPO, session.branch, "feat: cambio");
    await api("POST", `/api/ai/sessions/${session.id}/pull-request`);
    const merged = await api("POST", `/api/ai/sessions/${session.id}/merge`, { confirm: true });
    expect(merged.status, merged.raw).toBe(200);
    expect(server.count("stopPreview")).toBe(1);
    expect((await api("GET", `/api/ai/sessions/${session.id}/preview`)).body.preview.status).toBe("stopped");
  });

  it("las rutas de nginx rechazan hosts que no son de vista previa", async () => {
    const { app } = await setup();
    for (const host of ["acme-crm.apps.example.test", "preview-acme-crm.evil.test", "preview-acme-crm.apps.example.test.evil.test"]) {
      expect((await app.inject({ method: "GET", url: "/api/ai/preview/check", headers: { "x-preview-host": host, "x-preview-pass": "x" } })).statusCode).toBe(401);
    }
  });
});
