import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JobEngine } from "../src/jobs/engine.js";
import { FatalError } from "../src/lib/errors.js";
import { clearRegisteredSecrets } from "../src/lib/redact.js";
import type { AdminStore } from "../src/store/admin-store.js";
import { freshStore, startDb, stopDb } from "./helpers/db.js";
import { createFakes, TEST_CONFIG, silent } from "./helpers/fakes.js";


beforeAll(startDb);
afterAll(stopDb);
beforeEach(() => clearRegisteredSecrets());

async function setup(configPatch: Partial<ReturnType<typeof createFakes>["deps"]["config"]> = {}) {
  const store = await freshStore();
  const fakes = createFakes(store);
  const deps = { ...fakes.deps, config: { ...fakes.deps.config, ...configPatch } };
  const engine = new JobEngine(store, deps, silent);
  return { store, engine, deps, ...fakes };
}

async function createClient(store: AdminStore, slug = "acme-crm", name = "Acme CRM") {
  return store.createClientWithJob({ slug, name, description: "CRM interno de Acme", actor: "admin" });
}

/** Cuántas veces se escribió un secret concreto. */
function writes(github: ReturnType<typeof createFakes>["github"], name: string) {
  return github.calls.filter((c) => c.method === "putEnvironmentSecret" && c.args[1] === name).length;
}

describe("SESSION_SECRET", () => {
  it("se genera por cliente (≥ 32 caracteres, base64url) y no se sobrescribe en un reintento", async () => {
    const { store, engine, github } = await setup();
    const first = await createClient(store, "acme-crm");
    const second = await createClient(store, "beta-shop", "Beta Shop");

    // La primera ejecución falla después de escribir los secrets (al escribir las variables).
    let failOnce = true;
    github.faults.set("setEnvironmentVariable", () => {
      if (!failOnce) return undefined;
      failOnce = false;
      return new FatalError("github_rejected", "GitHub rechazó la petición.");
    });
    expect((await engine.run(first._id, "admin"))?.status).toBe("failed");
    const original = github.env("acme-crm-app").secrets.get("SESSION_SECRET")!;
    expect(original).toMatch(/^[A-Za-z0-9_-]{64}$/);

    await store.prepareRetry(first._id);
    expect((await engine.run(first._id, "admin"))?.status).toBe("succeeded");
    expect(github.env("acme-crm-app").secrets.get("SESSION_SECRET")).toBe(original);
    expect(writes(github, "SESSION_SECRET")).toBe(1);

    expect((await engine.run(second._id, "admin"))?.status).toBe("succeeded");
    expect(github.env("beta-shop-app").secrets.get("SESSION_SECRET")).not.toBe(original);
  });
});

describe("INITIAL_ADMIN_PASSWORD", () => {
  it("modo random: la escribe (≥ 16 caracteres) y queda pendiente de revelar, cifrada en la base", async () => {
    const { store, engine, github, vault } = await setup();
    const job = await createClient(store);
    expect((await engine.run(job._id, "admin"))?.status).toBe("succeeded");

    const password = github.env("acme-crm-app").secrets.get("INITIAL_ADMIN_PASSWORD")!;
    expect(password.length).toBeGreaterThanOrEqual(16);
    expect(password).not.toMatch(/\s/);

    const client = await store.getClient("acme-crm");
    expect(client?.initialAdmin).toMatchObject({ mode: "random" });
    expect(client?.initialAdmin?.generatedAt).toBeInstanceOf(Date);
    expect(await vault.pendingUntil("acme-crm")).toBeInstanceOf(Date);
    // En la base solo hay texto cifrado.
    const stored = JSON.stringify(await store.initialPasswords.find().toArray());
    expect(stored).not.toContain(password);
  });

  it("modo default: no la escribe y el panel lo indica", async () => {
    const { store, engine, github, vault } = await setup({ initialAdmin: { mode: "default", revealTtlMs: 60_000 } });
    const job = await createClient(store);
    expect((await engine.run(job._id, "admin"))?.status).toBe("succeeded");

    expect(github.env("acme-crm-app").secrets.has("INITIAL_ADMIN_PASSWORD")).toBe(false);
    expect((await store.getClient("acme-crm"))?.initialAdmin).toEqual({ mode: "default" });
    expect(await vault.pendingUntil("acme-crm")).toBeNull();
  });

  it("un reintento no la sobrescribe", async () => {
    const { store, engine, github } = await setup();
    const job = await createClient(store);
    github.nextRunConclusion = "failure";
    expect((await engine.run(job._id, "admin"))?.status).toBe("failed");
    const original = github.env("acme-crm-app").secrets.get("INITIAL_ADMIN_PASSWORD");

    github.nextRunConclusion = "success";
    await store.prepareRetry(job._id);
    expect((await engine.run(job._id, "admin"))?.status).toBe("succeeded");
    expect(github.env("acme-crm-app").secrets.get("INITIAL_ADMIN_PASSWORD")).toBe(original);
    expect(writes(github, "INITIAL_ADMIN_PASSWORD")).toBe(1);
  });

  it("si la escritura del secret falla, el reintento genera otra y el almacén guarda la nueva", async () => {
    const { store, engine, github, vault } = await setup();
    const job = await createClient(store);
    let failOnce = true;
    github.faults.set("putEnvironmentSecret", () => {
      const last = github.calls.at(-1);
      if (!failOnce || last?.args[1] !== "INITIAL_ADMIN_PASSWORD") return undefined;
      failOnce = false;
      return new FatalError("github_rejected", "GitHub rechazó la petición.");
    });
    expect((await engine.run(job._id, "admin"))?.status).toBe("failed");
    // El secret no llegó a escribirse: el panel no la ofrece.
    expect((await store.getClient("acme-crm"))?.initialAdmin?.generatedAt).toBeUndefined();

    await store.prepareRetry(job._id);
    expect((await engine.run(job._id, "admin"))?.status).toBe("succeeded");
    const written = github.env("acme-crm-app").secrets.get("INITIAL_ADMIN_PASSWORD")!;
    expect(await vault.take("acme-crm")).toBe(written);
  });
});

describe("verificación de la versión del template", () => {
  it("con la versión esperada (TEMPLATE_VERSION) queda verificada en clients.template.version", async () => {
    const { store, engine } = await setup();
    const job = await createClient(store);
    const result = await engine.run(job._id, "admin");
    expect(result?.stages[0].steps?.find((s) => s.id === "version")).toMatchObject({ status: "done" });
    expect(result?.stages[0].steps?.find((s) => s.id === "version")?.label).toContain("node-typescript@1.5.0");
    expect((await store.getClient("acme-crm"))?.template).toMatchObject({ name: "node-typescript", version: "1.5.0", schemaVersion: 1 });
  });

  it("otra versión detiene el trabajo indicando la esperada, la encontrada y dónde cambiar la configuración", async () => {
    const { store, engine, github, atlas } = await setup();
    github.templateVersion = "1.6.0";
    const job = await createClient(store);

    const result = await engine.run(job._id, "admin");
    expect(result?.status).toBe("failed");
    const error = result?.stages[0].error;
    expect(error).toMatchObject({ code: "template_version_mismatch", retryable: false });
    expect(error?.message).toContain("node-typescript@1.6.0");
    expect(error?.message).toContain("espera 1.5.0");
    expect(error?.message).toContain("TEMPLATE_VERSION");
    expect(error?.message).toContain("Environments → production");
    expect((await store.getClient("acme-crm"))?.template?.version).toBe("1.6.0");
    expect(atlas.count("createDatabaseUser")).toBe(0);
  });

  it("TEMPLATE_VERSION es configurable", async () => {
    // Aceptar repos de una versión anterior (1.4.0) cambiando solo la configuración.
    const { store, engine, github } = await setup({ template: { ...TEST_CONFIG.template, expectedVersion: "1.4.0" } });
    github.templateVersion = "1.4.0";
    const job = await createClient(store);
    expect((await engine.run(job._id, "admin"))?.status).toBe("succeeded");
  });

  it("rechaza plantillas anteriores al protocolo de despliegue soportado (1.3.0)", async () => {
    const { store, engine, github } = await setup({ template: { ...TEST_CONFIG.template, expectedVersion: "1.2.0" } });
    github.templateVersion = "1.2.0";
    const job = await createClient(store);
    const result = await engine.run(job._id, "admin");
    expect(result?.stages[0].error).toMatchObject({ code: "template_version_unsupported", retryable: false });
  });
});

describe("health check", () => {
  it("falla si schemaVersion es menor que MIN_SCHEMA_VERSION", async () => {
    const { store, engine } = await setup({ template: { ...TEST_CONFIG.template, minSchemaVersion: 2 } });
    const job = await createClient(store);
    const result = await engine.run(job._id, "admin");
    expect(result?.stages.at(-1)).toMatchObject({ name: "health_check", status: "failed", error: { code: "schema_version_too_old" } });
    expect((await store.getClient("acme-crm"))?.readiness.ready).toBe(false);
  });

  it("falla si appName no coincide con el displayName", async () => {
    const { store, engine, probe } = await setup();
    probe.appNameOverride = "Aplicación"; // p. ej. la app no recibió APP_DISPLAY_NAME
    const job = await createClient(store);
    const result = await engine.run(job._id, "admin");
    expect(result?.stages.at(-1)).toMatchObject({ status: "failed", error: { code: "app_name_mismatch" } });
  });

  it("falla si GET / no sirve HTML", async () => {
    const { store, engine, probe } = await setup();
    probe.frontendContentType = "application/json";
    const job = await createClient(store);
    const result = await engine.run(job._id, "admin");
    expect(result?.stages.at(-1)).toMatchObject({ status: "failed", error: { code: "frontend_unavailable" } });
  });

  it("solo marca el cliente listo con las tres comprobaciones", async () => {
    const { store, engine } = await setup();
    const job = await createClient(store);
    const result = await engine.run(job._id, "admin");
    expect(result?.stages.at(-1)?.steps?.map((s) => [s.id, s.status])).toEqual([
      ["ready", "done"],
      ["meta", "done"],
      ["frontend", "done"]
    ]);
    const client = await store.getClient("acme-crm");
    expect(client).toMatchObject({ status: "ready", readiness: { ready: true } });
  });
});

describe("reintentos sin duplicar", () => {
  const failures: [string, (f: ReturnType<typeof createFakes>) => void][] = [
    ["github_repository", (f) => f.github.faults.set("readFile", once(() => new FatalError("github_rejected", "x")))],
    ["mongodb_database", (f) => f.mongo.faults.set("bootstrap", once(() => new FatalError("mongodb_error", "x")))],
    ["github_secrets", (f) => f.github.faults.set("setEnvironmentVariable", once(() => new FatalError("github_rejected", "x")))],
    ["dns_https", (f) => f.resolver.faults.set("resolve4", once(() => Object.assign(new Error("x"), { code: "ENOTFOUND" })))],
    ["server_prepare", (f) => f.server.faults.set("installClient", once(() => new FatalError("server_command_failed", "x")))],
    ["deploy", (f) => f.github.faults.set("getWorkflow", once(() => new FatalError("github_rejected", "x")))],
    ["health_check", (f) => f.probe.faults.set("json", once(() => new FatalError("meta_mismatch", "x")))]
  ];

  for (const [stage, inject] of failures) {
    it(`tras fallar en ${stage}, el reintento termina sin duplicar recursos ni secrets`, async () => {
      const fakes = await setup();
      const { store, engine, github, atlas } = fakes;
      inject(fakes);
      const job = await createClient(store);

      const failed = await engine.run(job._id, "admin");
      const failedStage = failed?.stages.find((s) => s.status === "failed");
      expect([failedStage?.name, failedStage?.name === stage ? null : failedStage?.error]).toEqual([stage, null]);

      await store.prepareRetry(job._id);
      expect((await engine.run(job._id, "admin"))?.status).toBe("succeeded");

      expect(github.count("createRepositoryFromTemplate")).toBe(1);
      expect(atlas.count("createDatabaseUser")).toBe(1);
      expect(writes(github, "SESSION_SECRET")).toBe(1);
      expect(writes(github, "INITIAL_ADMIN_PASSWORD")).toBe(1);
      expect(writes(github, "DEPLOY_SSH_KEY")).toBe(1);
      expect(fakes.server.clients.size).toBe(1);
      expect(github.count("dispatchWorkflow")).toBe(1);
      expect(await store.resources.countDocuments({ clientId: "acme-crm" })).toBe(6);
    });
  }
});

describe("permisos de la base del cliente", () => {
  it("el usuario de la app solo tiene readWrite sobre su base (basta para createCollection/createIndex)", async () => {
    const { store, engine, atlas } = await setup();
    const job = await createClient(store);
    await engine.run(job._id, "admin");
    expect(atlas.users.get("app_acme_crm")?.user.roles).toEqual([{ roleName: "readWrite", databaseName: "client_acme_crm" }]);
  });
});

function once(make: () => Error) {
  let fired = false;
  return () => {
    if (fired) return undefined;
    fired = true;
    return make();
  };
}
