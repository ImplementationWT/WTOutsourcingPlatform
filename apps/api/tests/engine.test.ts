import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JobEngine, type PublicJob } from "../src/jobs/engine.js";
import { FatalError } from "../src/lib/errors.js";
import { clearRegisteredSecrets } from "../src/lib/redact.js";
import type { AdminStore } from "../src/store/admin-store.js";
import { STAGES } from "../src/store/models.js";
import { freshStore, startDb, stopDb } from "./helpers/db.js";
import { createFakes } from "./helpers/fakes.js";

const silent = { info() {}, warn() {}, error() {} };

beforeAll(startDb);
afterAll(stopDb);
beforeEach(() => clearRegisteredSecrets());

async function setup() {
  const store = await freshStore();
  const fakes = createFakes();
  const engine = new JobEngine(store, fakes.deps, silent);
  const events: PublicJob[] = [];
  return { store, engine, events, ...fakes };
}

async function createClient(store: AdminStore, slug = "acme-crm") {
  return store.createClientWithJob({ slug, name: "Acme CRM", description: "CRM interno de Acme", actor: "admin" });
}

describe("motor de etapas", () => {
  it("ejecuta las etapas en orden y deja el cliente listo", async () => {
    const { store, engine, events, atlas, github, mongo } = await setup();
    const job = await createClient(store);
    engine.subscribe(job._id, (j) => events.push(j));

    const result = await engine.run(job._id, "admin");

    expect(result?.status).toBe("succeeded");
    expect(result?.stages.map((s) => [s.name, s.status])).toEqual(STAGES.map((s) => [s.name, "succeeded"]));

    // Transiciones: cada etapa pasa por running antes de succeeded, en orden.
    const transitions = events.flatMap((e) => e.stages.map((s) => `${s.name}:${s.status}`));
    const firstRunning = STAGES.map((s) => transitions.indexOf(`${s.name}:running`));
    expect(firstRunning.every((i) => i >= 0)).toBe(true);
    expect([...firstRunning].sort((a, b) => a - b)).toEqual(firstRunning);
    for (const s of result!.stages) expect(s.durationMs).toBeGreaterThanOrEqual(0);

    // Estado final en los servicios.
    expect(github.repos.has("acme-crm-app")).toBe(true);
    expect(atlas.users.get("app_acme_crm")?.user.roles).toEqual([{ roleName: "readWrite", databaseName: "client_acme_crm" }]);
    expect(mongo.databases.get("client_acme_crm")).toEqual({ clientId: "acme-crm", templateVersion: "1.0.0", schemaVersion: 1 });
    const env = github.env("acme-crm-app");
    expect([...env.secrets.keys()].sort()).toEqual(
      ["DEPLOY_SSH_HOST", "DEPLOY_SSH_KNOWN_HOSTS", "DEPLOY_SSH_PRIVATE_KEY", "DEPLOY_SSH_USER", "MONGODB_DB", "MONGODB_URI"]
    );
    expect(env.secrets.get("MONGODB_DB")).toBe("client_acme_crm");
    expect(env.variables.get("APP_BASE_URL")).toBe("https://acme-crm.apps.example.test");
    expect(github.count("dispatchWorkflow")).toBe(1);

    const client = await store.getClient("acme-crm");
    expect(client?.status).toBe("ready");
    expect(client?.readiness.ready).toBe(true);

    const actions = (await store.auditLog.find({ clientId: "acme-crm" }).toArray()).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "github.repository.created",
        "atlas.database_user.created",
        "mongodb.database.created",
        "github.environment.created",
        "github.environment_secrets.written",
        "github.workflow.dispatched"
      ])
    );
  });

  it("reintento tras fallo después de crear el usuario: rota la contraseña y reescribe el secret sin duplicar", async () => {
    const { store, engine, atlas, github, mongo, deps } = await setup();
    const job = await createClient(store);

    // Falla la escritura del secret (el trabajo "se interrumpe" tras crear el usuario).
    let failWrites = true;
    github.faults.set("putEnvironmentSecret", () =>
      failWrites ? new FatalError("github_forbidden", "sin permiso de secrets") : undefined
    );
    const failed = await engine.run(job._id, "admin");
    expect(failed?.status).toBe("failed");
    expect(failed?.stages.find((s) => s.name === "github_secrets")?.status).toBe("failed");
    expect(atlas.count("createDatabaseUser")).toBe(1);
    const firstPassword = atlas.users.get("app_acme_crm")!.password;

    // Reintento en un motor nuevo: la contraseña ya no está en memoria.
    failWrites = false;
    await store.prepareRetry(job._id);
    const retried = await new JobEngine(store, deps, silent).run(job._id, "admin");

    expect(retried?.status).toBe("succeeded");
    // Las etapas completadas no se repiten.
    expect(github.count("createRepositoryFromTemplate")).toBe(1);
    expect(atlas.count("createDatabaseUser")).toBe(1);
    // La contraseña se rotó una vez y el secret contiene la nueva.
    expect(atlas.count("updateDatabaseUser")).toBe(1);
    const current = atlas.users.get("app_acme_crm")!.password;
    expect(current).not.toBe(firstPassword);
    expect(mongo.credentialsValid(github.env("acme-crm-app").secrets.get("MONGODB_URI")!)).toBe(true);
    // Sin duplicados.
    expect(atlas.users.size).toBe(1);
    expect(await store.resources.countDocuments({ clientId: "acme-crm" })).toBe(5);

    const actions = (await store.auditLog.find({ clientId: "acme-crm" }).toArray()).map((a) => a.action);
    expect(actions).toContain("atlas.database_user.password_rotated");
  });

  it("si el usuario se creó pero el trabajo murió antes de registrarlo, el reintento rota en vez de duplicar", async () => {
    const { store, engine, atlas, deps } = await setup();
    const job = await createClient(store);

    // El primer bootstrap falla de forma fatal justo después de crear el usuario.
    let failBootstrap = true;
    const { mongo } = { mongo: deps.mongo as unknown as { faults: Map<string, () => Error | undefined> } };
    mongo.faults.set("bootstrap", () => (failBootstrap ? new FatalError("mongodb_unauthorized", "x") : undefined));
    expect((await engine.run(job._id, "admin"))?.status).toBe("failed");
    expect(atlas.count("createDatabaseUser")).toBe(1);

    failBootstrap = false;
    await store.prepareRetry(job._id);
    expect((await engine.run(job._id, "admin"))?.status).toBe("succeeded");
    expect(atlas.count("createDatabaseUser")).toBe(1);
    expect(atlas.count("updateDatabaseUser")).toBe(1);
  });

  it("dos ejecuciones simultáneas del mismo trabajo no duplican usuario ni secrets", async () => {
    const { store, deps, atlas, github } = await setup();
    const job = await createClient(store);
    const [a, b] = await Promise.all([
      new JobEngine(store, deps, silent).run(job._id, "admin"),
      new JobEngine(store, deps, silent).run(job._id, "admin")
    ]);

    expect([a, b].filter((r) => r === null)).toHaveLength(1);
    expect(atlas.count("createDatabaseUser")).toBe(1);
    expect(github.count("createRepositoryFromTemplate")).toBe(1);
    expect(github.calls.filter((c) => c.method === "putEnvironmentSecret" && c.args[1] === "MONGODB_URI")).toHaveLength(1);
    expect(github.count("dispatchWorkflow")).toBe(1);
  });

  it("dos clientes con el mismo slug: solo se crea uno", async () => {
    const { store } = await setup();
    const results = await Promise.allSettled([createClient(store), createClient(store)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await store.jobs.countDocuments({ clientId: "acme-crm" })).toBe(1);
  });

  it("credenciales inválidas de Atlas detienen el trabajo con un error seguro", async () => {
    const { store, engine, atlas } = await setup();
    const job = await createClient(store);
    atlas.faults.set("getDatabaseUser", () => new FatalError("atlas_invalid_credentials", "Atlas rechazó las credenciales de la Service Account (ATLAS_CLIENT_ID / ATLAS_CLIENT_SECRET)."));

    const result = await engine.run(job._id, "admin");
    const stage = result!.stages.find((s) => s.name === "mongodb_database")!;
    expect(result?.status).toBe("failed");
    expect(stage.status).toBe("failed");
    expect(stage.attempts).toBe(1); // fatal: sin reintentos
    expect(stage.error).toMatchObject({ code: "atlas_invalid_credentials", retryable: false });
    expect(result!.stages.slice(2).every((s) => s.status === "pending")).toBe(true);
    expect((await store.getClient("acme-crm"))?.status).toBe("failed");
  });

  it("credenciales inválidas de GitHub detienen el trabajo en la primera etapa", async () => {
    const { store, engine, github, atlas } = await setup();
    const job = await createClient(store);
    github.faults.set("getRepository", () => new FatalError("github_invalid_credentials", "GitHub rechazó las credenciales de la GitHub App."));

    const result = await engine.run(job._id, "admin");
    expect(result?.stages[0]).toMatchObject({ name: "github_repository", status: "failed", attempts: 1 });
    expect(result?.stages[0].error?.code).toBe("github_invalid_credentials");
    expect(atlas.calls).toHaveLength(0);
  });

  it("errores temporales se reintentan con backoff y luego se recupera", async () => {
    const { store, engine, atlas } = await setup();
    const job = await createClient(store);
    let failures = 2;
    const { TransientError } = await import("../src/lib/errors.js");
    atlas.faults.set("getDatabaseUser", () => (failures-- > 0 ? new TransientError("atlas_unavailable", "HTTP 503") : undefined));

    const result = await engine.run(job._id, "admin");
    expect(result?.status).toBe("succeeded");
    expect(result?.stages.find((s) => s.name === "mongodb_database")?.attempts).toBe(3);
  });

  it("no reutiliza un usuario de Atlas que no es de este cliente", async () => {
    const { store, engine, atlas } = await setup();
    const job = await createClient(store);
    atlas.users.set("app_acme_crm", {
      password: "ajena",
      user: { username: "app_acme_crm", databaseName: "admin", labels: [], roles: [], scopes: [] }
    });

    const result = await engine.run(job._id, "admin");
    expect(result?.stages[1]).toMatchObject({ status: "failed", error: { code: "ownership_conflict" } });
    expect(atlas.count("updateDatabaseUser")).toBe(0);
    expect(atlas.users.get("app_acme_crm")?.password).toBe("ajena");
  });

  it("MongoDB muestra sus pasos en orden y todos terminan", async () => {
    const { store, engine, events } = await setup();
    const job = await createClient(store);
    engine.subscribe(job._id, (j) => events.push(j));

    const result = await engine.run(job._id, "admin");
    const mongoStage = result!.stages.find((s) => s.name === "mongodb_database")!;
    expect(mongoStage.steps?.map((s) => [s.id, s.status])).toEqual([
      ["ownership", "done"],
      ["atlas_user", "done"],
      ["propagation", "done"],
      ["collection", "done"],
      ["document", "done"],
      ["verify", "done"]
    ]);

    // En tiempo real cada paso pasa a "running" después de que el anterior termine.
    const order = ["ownership", "atlas_user", "propagation", "collection", "document", "verify"];
    const firstRunning = order.map((id) =>
      events.findIndex((e) => e.stages[1].steps.some((s) => s.id === id && s.status === "running"))
    );
    expect(firstRunning.every((i) => i >= 0)).toBe(true);
    expect([...firstRunning].sort((a, b) => a - b)).toEqual(firstRunning);
    expect(JSON.stringify(events)).not.toMatch(/[a-f0-9]{64}/); // la contraseña nunca aparece
  });

  it("mientras Atlas propaga el usuario, el paso lo explica con el número de intento", async () => {
    const { store, engine, events, mongo, atlas } = await setup();
    const job = await createClient(store);
    engine.subscribe(job._id, (j) => events.push(j));
    mongo.pendingAuthFailures = 2;

    const result = await engine.run(job._id, "admin");
    expect(result?.status).toBe("succeeded");
    const details = events.flatMap((e) => e.stages[1].steps.filter((s) => s.id === "propagation").map((s) => s.detail));
    expect(details).toContain("El clúster todavía no acepta las credenciales · intento 2, reintentando…");
    expect(result!.stages[1].steps?.find((s) => s.id === "propagation")?.detail).toMatch(/intento 3/);
    expect(atlas.count("createDatabaseUser")).toBe(1);
    expect(atlas.count("updateDatabaseUser")).toBe(0); // esperar la propagación no rota la contraseña
  });

  it("si la propagación supera la espera, el reintento de la etapa sí inicializa la base", async () => {
    const { store, engine, mongo, atlas } = await setup();
    const job = await createClient(store);
    // Más fallos de autenticación de los que caben en una espera (timeout de test: 20 ms a 1 ms).
    let until: number | undefined;
    const original = mongo.bootstrap.bind(mongo);
    mongo.bootstrap = async (input, onPhase) => {
      until ??= Date.now() + 60;
      if (Date.now() < until) {
        const { TransientError } = await import("../src/lib/errors.js");
        throw new TransientError("mongodb_auth_pending", "auth failed");
      }
      return original(input, onPhase);
    };

    const result = await engine.run(job._id, "admin");
    expect(result?.status).toBe("succeeded");
    expect(result?.stages[1].attempts).toBeGreaterThan(1);
    expect(mongo.databases.get("client_acme_crm")).toMatchObject({ clientId: "acme-crm" });
    expect(atlas.count("createDatabaseUser")).toBe(1);
    expect(atlas.count("updateDatabaseUser")).toBe(0); // reutiliza la credencial de este intento
  });

  it("si un paso de MongoDB falla, queda marcado como fallido y los siguientes pendientes", async () => {
    const { store, engine, mongo } = await setup();
    const job = await createClient(store);
    mongo.faults.set("bootstrap", () => new FatalError("mongodb_unauthorized", "El usuario del cliente no tiene permisos sobre su base."));

    const result = await engine.run(job._id, "admin");
    expect(result!.stages[1].steps?.map((s) => s.status)).toEqual(["done", "done", "failed", "pending", "pending", "pending"]);
  });

  it("fase 1 (DEPLOY_ENABLED=false): termina tras repo, MongoDB y secrets, sin desplegar", async () => {
    const { store, deps, github, mongo } = await setup();
    const phase1 = { ...deps, config: { ...deps.config, deployEnabled: false } };
    const engine = new JobEngine(store, phase1, silent);
    expect(engine.stageNames).toEqual(["github_repository", "mongodb_database", "github_secrets"]);

    const job = await store.createClientWithJob({ slug: "acme-crm", name: "Acme CRM", description: "CRM interno de Acme", actor: "admin", stages: engine.stageNames });
    const result = await engine.run(job._id, "admin");

    expect(result?.status).toBe("succeeded");
    expect(result?.stages.map((s) => s.name)).toEqual(["github_repository", "mongodb_database", "github_secrets"]);
    expect(github.count("dispatchWorkflow")).toBe(0);
    expect(mongo.credentialsValid(github.env("acme-crm-app").secrets.get("MONGODB_URI")!)).toBe(true);
    const client = await store.getClient("acme-crm");
    expect(client?.status).toBe("ready");
    expect(client?.readiness.ready).toBe(false); // la app aún no está desplegada
  });

  it("un trabajo que falló en deploy termina bien al reintentarlo con el despliegue deshabilitado", async () => {
    const { store, deps, github, atlas } = await setup();
    const job = await createClient(store); // 5 etapas, como el de acme-crm
    const withDeploy = new JobEngine(store, { ...deps, config: { ...deps.config, deploy: undefined } }, silent);
    const failed = await withDeploy.run(job._id, "admin");
    expect(failed?.stages[3]).toMatchObject({ name: "deploy", status: "failed", error: { code: "deploy_not_configured" } });

    const phase1 = new JobEngine(store, { ...deps, config: { ...deps.config, deployEnabled: false } }, silent);
    await store.prepareRetry(job._id, phase1.stageNames);
    const retried = await phase1.run(job._id, "admin");

    expect(retried?.status).toBe("succeeded");
    expect(retried?.stages.map((s) => s.name)).toEqual(["github_repository", "mongodb_database", "github_secrets"]);
    // No se repitió nada.
    expect(github.count("createRepositoryFromTemplate")).toBe(1);
    expect(atlas.count("createDatabaseUser")).toBe(1);
    expect(atlas.count("updateDatabaseUser")).toBe(0);
    expect(github.count("dispatchWorkflow")).toBe(0);
  });

  it("un despliegue fallido se reintenta con un run nuevo", async () => {
    const { store, engine, github } = await setup();
    const job = await createClient(store);
    github.nextRunConclusion = "failure";
    const failed = await engine.run(job._id, "admin");
    expect(failed?.stages.find((s) => s.name === "deploy")?.error?.code).toBe("deploy_failed");

    github.nextRunConclusion = "success";
    await store.prepareRetry(job._id);
    expect((await engine.run(job._id, "admin"))?.status).toBe("succeeded");
    expect(github.count("dispatchWorkflow")).toBe(2);
  });
});
