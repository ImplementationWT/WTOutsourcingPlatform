import { Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";
import { FatalError } from "../src/lib/errors.js";
import { clearRegisteredSecrets } from "../src/lib/redact.js";
import { freshStore, startDb, stopDb } from "./helpers/db.js";
import { createFakes } from "./helpers/fakes.js";

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
  const provision = async (slug = "acme-crm") => {
    await app.inject({ method: "POST", url: "/api/clients", headers, payload: { name: "Acme CRM", slug, description: "CRM interno de Acme" } });
    await app.engine.idle();
  };
  const remove = async (slug = "acme-crm", confirm = slug) => {
    const response = await app.inject({ method: "POST", url: `/api/clients/${slug}/delete`, headers, payload: { confirm } });
    await app.teardown.idle();
    return response;
  };
  const deletion = async (slug = "acme-crm") => (await app.inject({ method: "GET", url: `/api/clients/${slug}/deletion`, headers })).json();
  return { app, store, logs, headers, provision, remove, deletion, ...fakes };
}

describe("borrar un proyecto", () => {
  it("exige sesión y escribir el identificador exacto", async () => {
    const ctx = await setup();
    await ctx.provision();
    expect((await ctx.app.inject({ method: "POST", url: "/api/clients/acme-crm/delete", payload: { confirm: "acme-crm" } })).statusCode).toBe(401);
    expect((await ctx.remove("acme-crm", "acme")).statusCode).toBe(400);
    expect((await ctx.remove("acme-crm", "")).statusCode).toBe(400);
    expect(await ctx.store.getClient("acme-crm")).not.toBeNull();
    expect((await ctx.remove("no-existe")).statusCode).toBe(404);
  });

  it("borra servidor, repositorio, imagen, datos y usuario de MongoDB y los registros; conserva la auditoría", async () => {
    const ctx = await setup();
    await ctx.provision();
    expect(ctx.server.clients.has("acme-crm")).toBe(true);
    expect(ctx.mongo.databases.has("client_acme_crm")).toBe(true);

    const response = await ctx.remove();
    expect(response.statusCode).toBe(202);
    const result = await ctx.deletion();
    expect(result.status).toBe("succeeded");
    expect(result.steps.map((s: { id: string; status: string }) => [s.id, s.status])).toEqual([
      ["preflight", "done"],
      ["server", "done"],
      ["github_repository", "done"],
      ["container_image", "done"],
      ["mongodb_data", "done"],
      ["mongodb_user", "done"],
      ["dns", "skipped"],
      ["records", "done"]
    ]);

    expect(ctx.server.clients.has("acme-crm")).toBe(false);
    expect(ctx.github.repos.has("acme-crm-app")).toBe(false);
    expect(ctx.github.count("deleteContainerPackage")).toBe(1);
    expect(ctx.mongo.databases.has("client_acme_crm")).toBe(false);
    expect(ctx.atlas.users.has("app_acme_crm")).toBe(false);
    expect(await ctx.store.getClient("acme-crm")).toBeNull();
    expect(await ctx.store.jobs.countDocuments({ clientId: "acme-crm" })).toBe(0);
    expect(await ctx.store.resources.countDocuments({ clientId: "acme-crm" })).toBe(0);
    expect(await ctx.store.initialPasswords.countDocuments({ _id: "acme-crm" })).toBe(0);
    const actions = (await ctx.store.auditLog.find({ clientId: "acme-crm" }).toArray()).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["client.created", "client.deletion_requested", "client.deleted"]));
  });

  it("el slug queda libre: se puede volver a crear un proyecto con el mismo identificador", async () => {
    const ctx = await setup();
    await ctx.provision();
    await ctx.remove();
    await ctx.provision();
    const detail = (await ctx.app.inject({ method: "GET", url: "/api/clients/acme-crm", headers: ctx.headers })).json();
    expect(detail.client.status).toBe("ready");
  });

  it("si GitHub no permite borrar la imagen, lo avisa con el enlace y termina igual", async () => {
    const ctx = await setup();
    ctx.github.packageDeletion = "forbidden";
    await ctx.provision();
    await ctx.remove();
    const result = await ctx.deletion();
    expect(result.status).toBe("succeeded");
    const step = result.steps.find((s: { id: string }) => s.id === "container_image");
    expect(step.status).toBe("warning");
    expect(step.detail).toContain("https://github.com/acme-org?tab=packages");
  });

  it("si GitHub no encuentra la imagen de un proyecto que sí se desplegó, avisa en vez de darlo por borrado", async () => {
    const ctx = await setup();
    ctx.github.packageDeletion = "not_found";
    await ctx.provision();
    await ctx.remove();
    const step = (await ctx.deletion()).steps.find((s: { id: string }) => s.id === "container_image");
    expect(step.status).toBe("warning");
    expect(step.detail).toContain("No se pudo confirmar");
  });

  it("si el usuario de Atlas no es de este cliente, no borra nada", async () => {
    const ctx = await setup();
    await ctx.provision();
    ctx.atlas.users.get("app_acme_crm")!.user.labels = [{ key: "managed-by", value: "otra-cosa" }];
    await ctx.remove();
    const result = await ctx.deletion();
    expect(result.status).toBe("failed");
    expect(result.error.code).toBe("ownership_conflict");
    expect(ctx.server.clients.has("acme-crm")).toBe(true);
    expect(ctx.github.repos.has("acme-crm-app")).toBe(true);
    expect(await ctx.store.getClient("acme-crm")).not.toBeNull();
  });

  it("no toca un repositorio que la plataforma no registró como de este cliente", async () => {
    const ctx = await setup();
    await ctx.provision();
    await ctx.store.resources.deleteOne({ kind: "github_repository" });
    await ctx.remove();
    const result = await ctx.deletion();
    expect(result.steps.find((s: { id: string }) => s.id === "github_repository").status).toBe("skipped");
    expect(ctx.github.repos.has("acme-crm-app")).toBe(true);
  });

  it("si un paso falla, reintentar continúa sin romper lo ya borrado", async () => {
    const ctx = await setup();
    await ctx.provision();
    let failOnce = true;
    ctx.github.faults.set("deleteRepository", () => {
      if (!failOnce) return undefined;
      failOnce = false;
      return new FatalError("github_forbidden", "La GitHub App no tiene permisos para borrar el repositorio.");
    });
    await ctx.remove();
    const failed = await ctx.deletion();
    expect(failed.status).toBe("failed");
    expect(failed.steps.find((s: { id: string }) => s.id === "github_repository").status).toBe("failed");
    expect(ctx.server.clients.has("acme-crm")).toBe(false);

    expect((await ctx.remove()).statusCode).toBe(202);
    expect((await ctx.deletion()).status).toBe("succeeded");
    expect(ctx.github.repos.has("acme-crm-app")).toBe(false);
  });

  it("no se puede borrar mientras se aprovisiona", async () => {
    const ctx = await setup();
    await ctx.store.createClientWithJob({ slug: "acme-crm", name: "Acme CRM", description: "CRM interno de Acme", actor: "admin" });
    expect((await ctx.remove()).statusCode).toBe(409);
  });

  it("ni el progreso ni los logs contienen secretos", async () => {
    const ctx = await setup();
    await ctx.provision();
    const env = ctx.github.env("acme-crm-app");
    const secrets = ["SESSION_SECRET", "MONGODB_URI", "INITIAL_ADMIN_PASSWORD"].map((n) => env.secrets.get(n)!);
    await ctx.remove();
    const outputs = [JSON.stringify(await ctx.deletion()), ...ctx.logs].join("\n");
    for (const value of [...secrets, ...ctx.atlas.seenPasswords]) expect(outputs).not.toContain(value);
    expect(outputs).not.toMatch(/mongodb(\+srv)?:\/\/(?!\[REDACTED\])/);
  });
});

describe("dashboard con datos reales", () => {
  it("totales, salud en vivo, atención y actividad", async () => {
    const ctx = await setup();
    await ctx.provision("acme-crm");
    ctx.github.nextRunConclusion = "failure";
    await ctx.provision("beta-shop");

    const data = (await ctx.app.inject({ method: "GET", url: "/api/dashboard", headers: ctx.headers })).json();
    expect(data.totals).toMatchObject({ projects: 2, ready: 1, failed: 1, online: 1 });
    const acme = data.projects.find((p: { id: string }) => p.id === "acme-crm");
    expect(acme).toMatchObject({ live: "online", templateVersion: "1.4.0", appUrl: "https://acme-crm.apps.example.test" });
    expect(acme.image.digest).toMatch(/^sha256:[a-f0-9]{12}$/);
    expect(data.attention).toEqual(
      expect.arrayContaining([expect.objectContaining({ clientId: "beta-shop", kind: "job_failed" })])
    );
    expect(data.activity.length).toBeGreaterThan(0);
    expect(Object.keys(data.activity[0]).sort()).toEqual(["action", "actor", "at", "clientId"]);
    expect(data.lastDeployAt).not.toBeNull();
  });

  it("exige sesión", async () => {
    const ctx = await setup();
    expect((await ctx.app.inject({ method: "GET", url: "/api/dashboard" })).statusCode).toBe(401);
  });

  it("la configuración de la plataforma expone owner de GitHub y la consola de Atlas, sin secretos", async () => {
    const ctx = await setup();
    const platform = (await ctx.app.inject({ method: "GET", url: "/api/platform", headers: ctx.headers })).json();
    expect(platform).toMatchObject({ deployEnabled: true, appBaseDomain: "apps.example.test", githubOwner: "acme-org", atlas: { clusterName: "shared-cluster" } });
  });
});
