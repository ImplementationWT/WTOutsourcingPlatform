import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateClientKeyPair, hostKeyFingerprint, type ServerConnection } from "../src/adapters/server.js";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";
import { clearRegisteredSecrets } from "../src/lib/redact.js";
import { ServerDirectory } from "../src/servers/directory.js";
import { freshStore, startDb, stopDb } from "./helpers/db.js";
import { FakeAgent } from "./helpers/fake-agent.js";
import { createFakes, FakeServer, TEST_CONFIG } from "./helpers/fakes.js";

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

const SECOND = { name: "VPS Europa", host: "vps2.example.test", sshPort: 2222, appsDomain: "apps2.example.test", publicIp: "198.51.100.20" };
// Clave ed25519 del host simulado y la salida de ssh-keygen -lf que vería la persona en la consola.
const HOST_KEY = Buffer.from(generateClientKeyPair("host").publicKey.split(" ")[1], "base64");
const CONSOLE = `256 ${hostKeyFingerprint(HOST_KEY)} root@vps2 (ED25519)`;

async function setup({ withKey = true } = {}) {
  const store = await freshStore();
  const fakes = createFakes(store);
  const second = new FakeServer(fakes.github, SECOND.appsDomain);
  fakes.probe.extraServers.push(second);
  const connections: ServerConnection[] = [];
  // DNS: el comodín de cada dominio apunta a su servidor.
  const resolver = {
    resolve4: async (host: string) => (host.endsWith(`.${SECOND.appsDomain}`) ? [SECOND.publicIp] : fakes.resolver.resolve4(host))
  };
  fakes.deps.resolver = resolver;
  let liveHostKey = HOST_KEY;
  const servers = new ServerDirectory({
    servers: store.servers,
    clients: store.clients,
    key: withKey ? randomBytes(32) : undefined,
    primary: { ...TEST_CONFIG.server!, appsDomain: TEST_CONFIG.appsDomain, adapter: fakes.server },
    ghcrOrg: "acme-org",
    resolver,
    createAdapter: (connection) => {
      connections.push(connection);
      return second;
    },
    fetchHostKey: async () => ({ type: "ssh-ed25519", key: liveHostKey, fingerprint: hostKeyFingerprint(liveHostKey) })
  });
  const app = await buildApp({
    store,
    deps: fakes.deps,
    servers,
    logLevel: "silent",
    auth: { adminUsername: "admin", adminPasswordHash: passwordHash, sessionSecret: "x".repeat(40), secureCookies: false },
    ai: { agent: new FakeAgent(), config: { sessionBudgetCents: 1000, workspace: "default" } }
  });
  apps.push(app);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: ADMIN_PASSWORD } });
  const cookie = login.cookies.find((c) => c.name === "pp_session")!;
  const headers = { cookie: `pp_session=${cookie.value}` };
  const api = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const response = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
    return { status: response.statusCode, body: response.json(), raw: response.body };
  };
  return {
    app,
    store,
    api,
    second,
    connections,
    setLiveHostKey: (key: Buffer) => (liveHostKey = key),
    ...fakes
  };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function readyServer(ctx: Ctx) {
  const created = await ctx.api("POST", "/api/servers", SECOND);
  expect(created.status).toBe(201);
  const id = created.body.server.id as string;
  expect((await ctx.api("POST", `/api/servers/${id}/host-key`, { consoleOutput: CONSOLE })).status).toBe(200);
  const verified = await ctx.api("POST", `/api/servers/${id}/verify`);
  expect(verified.body.server.status).toBe("ready");
  return id;
}

describe("servidores: alta y seguridad de las claves", () => {
  it("Launchpad genera la clave del provisioner; solo sale la pública y la privada se guarda cifrada", async () => {
    const ctx = await setup();
    const created = await ctx.api("POST", "/api/servers", SECOND);
    expect(created.status).toBe(201);
    const server = created.body.server;
    expect(server).toMatchObject({ name: "VPS Europa", appsDomain: "apps2.example.test", status: "host_key", projects: 0, primary: false });
    expect(server.provisionerPublicKey).toMatch(/^ssh-ed25519 AAAA/);

    const list = await ctx.api("GET", "/api/servers");
    expect(list.body.available).toBe(true);
    expect(list.body.servers.map((s: { id: string }) => s.id)).toEqual(["principal", server.id]);

    const doc = await ctx.store.servers.findOne({ _id: server.id });
    expect(doc?.provisionerKey.ciphertext).toBeTruthy();
    // Ni la API ni la base contienen la clave privada en claro.
    for (const text of [created.raw, list.raw, JSON.stringify(doc)]) expect(text).not.toContain("PRIVATE KEY");
    expect(await ctx.store.auditLog.countDocuments({ action: "server.created" })).toBe(1);
  });

  it("sin clave de cifrado no se pueden dar de alta servidores (el principal sigue)", async () => {
    const ctx = await setup({ withKey: false });
    const list = await ctx.api("GET", "/api/servers");
    expect(list.body).toMatchObject({ available: false, servers: [{ id: "principal", status: "ready", appsDomain: "apps.example.test" }] });
    const created = await ctx.api("POST", "/api/servers", SECOND);
    expect(created.status).toBe(503);
    expect(created.body.error).toContain("SERVER_KEYS_ENCRYPTION_KEY_SECRET_REF");
  });

  it("valida los datos y no repite dominios (tampoco el del principal)", async () => {
    const ctx = await setup();
    expect((await ctx.api("POST", "/api/servers", { ...SECOND, host: "root@vps2" })).status).toBe(400);
    expect((await ctx.api("POST", "/api/servers", { ...SECOND, publicIp: "999.1.1.1" })).status).toBe(400);
    expect((await ctx.api("POST", "/api/servers", { ...SECOND, appsDomain: "https://apps2.example.test" })).status).toBe(400);
    expect((await ctx.api("POST", "/api/servers", { ...SECOND, extra: true })).status).toBe(400);
    expect((await ctx.api("POST", "/api/servers", { ...SECOND, appsDomain: "apps.example.test" })).status).toBe(409);
    expect((await ctx.api("POST", "/api/servers", SECOND)).status).toBe(201);
    expect((await ctx.api("POST", "/api/servers", { ...SECOND, name: "Otro" })).status).toBe(409);
  });

  it("la huella solo se fija si coincide con la de la consola del VPS", async () => {
    const ctx = await setup();
    const id = (await ctx.api("POST", "/api/servers", SECOND)).body.server.id;
    expect((await ctx.api("POST", `/api/servers/${id}/fingerprint`)).body.fingerprint).toBe(hostKeyFingerprint(HOST_KEY));

    expect((await ctx.api("POST", `/api/servers/${id}/host-key`, { consoleOutput: "no es una huella" })).status).toBe(400);
    const other = Buffer.from(generateClientKeyPair("otro").publicKey.split(" ")[1], "base64");
    const mismatch = await ctx.api("POST", `/api/servers/${id}/host-key`, { consoleOutput: `256 ${hostKeyFingerprint(other)} root@x (ED25519)` });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error).toContain("no coincide");
    expect((await ctx.store.servers.findOne({ _id: id }))?.knownHosts).toBeUndefined();

    const pinned = await ctx.api("POST", `/api/servers/${id}/host-key`, { consoleOutput: CONSOLE });
    expect(pinned.body.server).toMatchObject({ status: "verify", hostKeyFingerprint: hostKeyFingerprint(HOST_KEY) });
    expect((await ctx.store.servers.findOne({ _id: id }))?.knownHosts).toBe(`vps2.example.test ssh-ed25519 ${HOST_KEY.toString("base64")}`);
  });

  it("verificar: conecta con la huella fijada y la clave descifrada, y exige la configuración correcta", async () => {
    const ctx = await setup();
    const id = (await ctx.api("POST", "/api/servers", SECOND)).body.server.id;
    expect((await ctx.api("POST", `/api/servers/${id}/verify`)).status).toBe(409); // sin huella
    await ctx.api("POST", `/api/servers/${id}/host-key`, { consoleOutput: CONSOLE });

    ctx.second.info = { ...ctx.second.info, appBaseDomain: "otro.example.test", diskFreeMb: 500 };
    const bad = await ctx.api("POST", `/api/servers/${id}/verify`);
    expect(bad.body.server.status).toBe("verify");
    const checks = Object.fromEntries(bad.body.server.verification.checks.map((c: { id: string; ok: boolean }) => [c.id, c.ok]));
    expect(checks).toMatchObject({ domain: false, dns: true, scripts: true, disk: false });

    // El disco justo no bloquea (aviso); el dominio sí.
    ctx.second.info = { ...ctx.second.info, appBaseDomain: SECOND.appsDomain };
    const good = await ctx.api("POST", `/api/servers/${id}/verify`);
    expect(good.body.server.status).toBe("ready");
    expect(ctx.connections[0]).toMatchObject({ host: SECOND.host, port: 2222 });
    expect(ctx.connections[0].hostKeys[0].key.equals(HOST_KEY)).toBe(true);
    expect(ctx.connections[0].provisionerKey).toContain("OPENSSH PRIVATE KEY");
    expect(good.raw).not.toContain("PRIVATE KEY");
  });

  it("verificar falla si el comodín DNS no apunta a la IP del servidor", async () => {
    const ctx = await setup();
    const id = (await ctx.api("POST", "/api/servers", { ...SECOND, publicIp: "198.51.100.99" })).body.server.id;
    await ctx.api("POST", `/api/servers/${id}/host-key`, { consoleOutput: CONSOLE });
    const result = await ctx.api("POST", `/api/servers/${id}/verify`);
    expect(result.body.server.status).toBe("verify");
    const dns = result.body.server.verification.checks.find((c: { id: string }) => c.id === "dns");
    expect(dns).toMatchObject({ ok: false, required: true });
  });
});

describe("servidores: proyectos", () => {
  it("solo se elige un servidor verificado; el proyecto se despliega entero en él", async () => {
    const ctx = await setup();
    const pending = (await ctx.api("POST", "/api/servers", { ...SECOND, appsDomain: "apps3.example.test" })).body.server.id;
    const project = { name: "Acme CRM", slug: "acme-crm", description: "CRM interno de Acme" };
    expect((await ctx.api("POST", "/api/clients", { ...project, serverId: pending })).status).toBe(409);

    const id = await readyServer(ctx);
    const created = await ctx.api("POST", "/api/clients", { ...project, serverId: id });
    expect(created.status).toBe(202);
    await ctx.app.engine.idle();

    const detail = await ctx.api("GET", "/api/clients/acme-crm");
    expect(detail.body.client.server).toEqual({ id, name: "VPS Europa", appsDomain: SECOND.appsDomain });
    expect(detail.body.resources.baseUrl).toBe("https://acme-crm.apps2.example.test");
    expect(detail.body.job.stages.filter((st: { error?: unknown }) => st.error).map((st: { name: string; error: unknown }) => [st.name, st.error])).toEqual([]);
    expect(detail.body.job.status).toBe("succeeded");

    // Todo en el segundo servidor; nada en el principal.
    expect(ctx.second.clients.has("acme-crm")).toBe(true);
    expect(ctx.server.clients.size).toBe(0);
    const vars = ctx.github.env("acme-crm-app", "production").variables;
    expect(vars.get("DEPLOY_HOST")).toBe(SECOND.host);
    expect(vars.get("DEPLOY_KNOWN_HOSTS")).toBe(`vps2.example.test ssh-ed25519 ${HOST_KEY.toString("base64")}`);
    expect(vars.get("APP_HOSTNAME")).toBe("acme-crm.apps2.example.test");

    // Con proyectos: no se borra ni cambia la huella; el servidor del proyecto no se puede editar.
    expect((await ctx.api("POST", `/api/servers/${id}/delete`, { confirm: SECOND.appsDomain })).status).toBe(409);
    expect((await ctx.api("POST", `/api/servers/${id}/host-key`, { consoleOutput: CONSOLE })).status).toBe(409);
    expect((await ctx.api("GET", "/api/servers")).body.servers.find((s: { id: string }) => s.id === id).projects).toBe(1);

    // Estado en vivo y borrado del proyecto, también contra su servidor.
    expect((await ctx.api("GET", "/api/clients/acme-crm/server-status")).body.host).toBe("acme-crm.apps2.example.test");
    expect((await ctx.api("POST", "/api/clients/acme-crm/delete", { confirm: "acme-crm" })).status).toBe(202);
    await ctx.app.teardown.idle();
    expect(ctx.second.calls.some((c) => c.method === "uninstallClient")).toBe(true);
    expect(ctx.server.calls.some((c) => c.method === "uninstallClient")).toBe(false);
    expect((await ctx.api("POST", `/api/servers/${id}/delete`, { confirm: "mal" })).status).toBe(400);
    expect((await ctx.api("POST", `/api/servers/${id}/delete`, { confirm: SECOND.appsDomain })).status).toBe(200);
  });

  it("la vista previa del AI Developer se levanta en el servidor del proyecto, con su dominio", async () => {
    const ctx = await setup();
    const id = await readyServer(ctx);
    await ctx.api("POST", "/api/clients", { name: "Acme CRM", slug: "acme-crm", description: "CRM interno de Acme", serverId: id });
    await ctx.app.engine.idle();
    const session = (await ctx.api("POST", "/api/clients/acme-crm/ai/sessions", { title: "Cambio de prueba" })).body.session;

    const started = await ctx.api("POST", `/api/ai/sessions/${session.id}/preview`);
    expect(started.status, started.raw).toBe(200);
    const host = "preview-acme-crm.apps2.example.test";
    expect(started.body.preview.url).toBe(`https://${host}`);
    expect(ctx.second.calls.filter((c) => c.method === "installPreview").map((c) => c.args[0])).toEqual(["acme-crm"]);
    expect(ctx.server.calls.some((c) => c.method === "installPreview")).toBe(false);
    await ctx.app.aiDeveloper!.previewIdle();
    expect(ctx.second.calls.some((c) => c.method === "startLivePreview")).toBe(true);

    // nginx del segundo servidor valida contra Launchpad con su host.
    const ready = await ctx.api("GET", `/api/ai/sessions/${session.id}/preview`);
    const pass = new URL(ready.body.preview.frameUrl).search;
    const auth = await ctx.app.inject({ method: "GET", url: `/api/ai/preview/auth${pass}`, headers: { "x-preview-host": host } });
    expect(auth.statusCode).toBe(302);

    await ctx.api("POST", `/api/ai/sessions/${session.id}/preview/stop`);
    expect(ctx.second.calls.some((c) => c.method === "stopPreview")).toBe(true);
  });

  it("sin serverId, el proyecto va al principal como siempre", async () => {
    const ctx = await setup();
    await readyServer(ctx);
    const created = await ctx.api("POST", "/api/clients", { name: "Acme CRM", slug: "acme-crm", description: "CRM interno de Acme" });
    expect(created.status).toBe(202);
    await ctx.app.engine.idle();
    expect((await ctx.store.getClient("acme-crm"))?.server).toBeUndefined();
    expect(ctx.server.clients.has("acme-crm")).toBe(true);
    expect(ctx.second.clients.size).toBe(0);
  });

  it("rotar la clave cambia la pública y obliga a verificar de nuevo", async () => {
    const ctx = await setup();
    const id = await readyServer(ctx);
    const before = (await ctx.api("GET", `/api/servers/${id}`)).body.server.provisionerPublicKey;
    const rotated = await ctx.api("POST", `/api/servers/${id}/rotate-key`);
    expect(rotated.body.server.provisionerPublicKey).not.toBe(before);
    expect(rotated.body.server.status).toBe("verify");
    expect((await ctx.api("POST", "/api/clients", { name: "Acme CRM", slug: "acme-crm", description: "CRM interno de Acme", serverId: id })).status).toBe(409);
  });
});
