import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createLoginGuard } from "../src/auth/login-guard.js";
import { hashPassword } from "../src/auth/password.js";
import type { SitesClient } from "../src/sales/sites-client.js";
import { freshStore, startDb, stopDb } from "./helpers/db.js";
import { createFakes } from "./helpers/fakes.js";
import { seedUser, TEST_TEAM_ID } from "./helpers/users.js";

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

const SITE_ID = "a".repeat(24);
const site = (name = "demo-manpersa") => ({ id: SITE_ID, name, url: `https://${name}.sites.whatever.tech`, status: "live", homepage: "index.html", files: [{ path: "index.html", size: 20 }], totalSize: 20, access: { mode: "public" }, domain: "ready", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", deletedAt: null });

/** WTProposalPlatform falsa: guarda cada llamada y responde como la real. */
function fakePlatform() {
  const calls: { method: string; path: string; body?: string; contentType?: string; auth?: string }[] = [];
  let current = site();
  const client: SitesClient = {
    async forward(method, path, init = {}) {
      const body = init.body instanceof ReadableStream ? await new Response(init.body).text() : (init.body as string | undefined);
      calls.push({ method, path, body, contentType: init.headers?.["content-type"] });
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      if (path.startsWith("/api/projects/name-availability")) return json(path.includes("taken") ? { available: false, reason: "Ese nombre ya está en uso" } : { available: true });
      if (method === "POST" && path === "/api/projects") return json(current, 201);
      if (method === "PATCH") {
        current = site(JSON.parse(body!).name ?? current.name);
        return json(current);
      }
      if (path.startsWith("/api/projects?")) return json({ items: [current], counts: { live: 1, archived: 0, deleted: 0 } });
      if (path.endsWith("/download")) return new Response("PK-zip", { headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="demo.zip"' } });
      if (path.includes("/stats")) return json({ series: [], period: { people: 3, visits: 4, views: 5 }, allTime: { people: 3, views: 5 }, log: [] });
      if (method === "DELETE") return path.endsWith(SITE_ID) ? new Response(null, { status: 204 }) : json({ error: "Proyecto no encontrado" }, 404);
      if (path === "/api/auth/session") return json({ username: "platform", teamToken: "123.abc" });
      return json({ error: "No encontrado" }, 404);
    }
  };
  return { client, calls };
}

async function world(sites?: SitesClient) {
  const store = await freshStore();
  const app = await buildApp({
    store,
    deps: createFakes(store).deps,
    logLevel: "silent",
    proposalSites: sites,
    auth: { adminUsername: "jefe", adminPasswordHash: passwordHash, sessionSecret: "x".repeat(40), secureCookies: false, loginGuard: createLoginGuard({ maxPerIp: 1000, maxPerUser: 1000 }) }
  });
  apps.push(app);
  await seedUser(store, passwordHash, { username: "marta", name: "Marta", role: "commercial", teamId: null });
  await seedUser(store, passwordHash, { username: "fede", name: "Fede", role: "finance", teamId: null });
  await seedUser(store, passwordHash, { username: "dev", name: "Diego", role: "developer", teamId: TEST_TEAM_ID });
  const as = async (username: string) => {
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: PASSWORD } });
    const cookie = `pp_session=${login.cookies.find((c) => c.name === "pp_session")!.value}`;
    return async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = {}) => {
      const r = await app.inject({ method, url, headers: { cookie, ...headers }, payload: payload as never });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- respuestas JSON variadas en los tests
      return { status: r.statusCode, headers: r.headers, raw: r.body, body: (r.headers["content-type"]?.toString().includes("json") ? r.json() : {}) as Record<string, any> };
    };
  };
  const leadId = "44444444-4444-4444-8444-444444444444";
  const at = new Date();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- lead mínimo para los tests
  await store.leads.insertOne({ _id: leadId, company: "Manpersa SAC", contactName: "Francisco", status: "demo", createdAt: at, updatedAt: at } as any);
  return { store, as, leadId };
}

const multipart = (fields: Record<string, string>) => {
  const boundary = "----test";
  const body = Object.entries(fields)
    .map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
    .join("")
    .concat(`--${boundary}--\r\n`);
  return { body, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
};

describe("propuestas en WTProposalPlatform", () => {
  it("publicar desde el lead reenvía el multipart tal cual y deja la propuesta ligada al lead", async () => {
    const platform = fakePlatform();
    const { as, store, leadId } = await world(platform.client);
    const marta = await as("marta");
    const upload = multipart({ name: "demo-manpersa", html: "<h1>Hola</h1>" });
    const res = await marta("POST", `/api/sites?leadId=${leadId}`, upload.body, upload.headers);
    expect(res.status).toBe(201);
    expect(res.body.site).toMatchObject({ name: "demo-manpersa", lead: { id: leadId, name: "Manpersa SAC" } });
    const sent = platform.calls.find((c) => c.method === "POST" && c.path === "/api/projects")!;
    expect(sent.contentType).toContain("multipart/form-data; boundary=----test");
    expect(sent.body).toContain("<h1>Hola</h1>");
    const proposal = await store.proposals.findOne({ siteId: SITE_ID });
    expect(proposal).toMatchObject({ leadId, url: "https://demo-manpersa.sites.whatever.tech", status: "draft" });
    expect(await store.leadUpdates.countDocuments({ leadId, body: /Propuesta publicada/ })).toBe(1);
    // La pestaña del lead lista solo sus sitios.
    const list = await marta("GET", `/api/sites?leadId=${leadId}`);
    expect(list.body.items).toHaveLength(1);
    expect((await marta("GET", "/api/sites?leadId=55555555-5555-4555-8555-555555555555")).body.items).toHaveLength(0);
  });

  it("renombrar actualiza el enlace de la propuesta; borrar la quita también de aquí", async () => {
    const platform = fakePlatform();
    const { as, store, leadId } = await world(platform.client);
    const marta = await as("marta");
    const upload = multipart({ name: "demo-manpersa", html: "<p>x</p>" });
    await marta("POST", `/api/sites?leadId=${leadId}`, upload.body, upload.headers);
    const renamed = await marta("PATCH", `/api/sites/${SITE_ID}`, { name: "manpersa-2026" });
    expect(renamed.status).toBe(200);
    expect((await store.proposals.findOne({ siteId: SITE_ID }))?.url).toBe("https://manpersa-2026.sites.whatever.tech");
    expect((await marta("DELETE", `/api/sites/${SITE_ID}`)).status).toBe(200);
    expect(await store.proposals.countDocuments({ siteId: SITE_ID })).toBe(0);
  });

  it("Financiera lee y ve estadísticas, pero no publica; developer no entra; descargar pasa el ZIP", async () => {
    const platform = fakePlatform();
    const { as } = await world(platform.client);
    const fede = await as("fede");
    expect((await fede("GET", "/api/sites")).body).toMatchObject({ canWrite: false });
    expect((await fede("GET", `/api/sites/${SITE_ID}/stats?days=7`)).body.period).toMatchObject({ visits: 4 });
    const upload = multipart({ name: "x", html: "<p>x</p>" });
    expect((await fede("POST", "/api/sites", upload.body, upload.headers)).status).toBe(403);
    expect((await (await as("dev"))("GET", "/api/sites")).status).toBe(403);
    const zip = await fede("GET", `/api/sites/${SITE_ID}/download`);
    expect(zip.headers["content-type"]).toBe("application/zip");
    expect(zip.raw).toBe("PK-zip");
    expect((await fede("GET", "/api/sites/team-mark")).body).toEqual({ mark: "123.abc" });
  });

  it("los errores de la plataforma llegan con su mensaje; sin configurar responde 503", async () => {
    const platform = fakePlatform();
    const { as } = await world(platform.client);
    const marta = await as("marta");
    expect((await marta("GET", "/api/sites/name-availability?name=taken")).body).toEqual({ available: false, reason: "Ese nombre ya está en uso" });
    expect((await marta("DELETE", `/api/sites/${"b".repeat(24)}`)).status).toBe(404);
    const off = await world();
    const res = await (await off.as("marta"))("GET", "/api/sites");
    expect(res.status).toBe(503);
    expect((await (await off.as("marta"))("GET", "/api/sites/config")).body).toEqual({ configured: false });
  });
});
