import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JobEngine, type PublicJob } from "../src/jobs/engine.js";
import { FatalError } from "../src/lib/errors.js";
import { clearRegisteredSecrets } from "../src/lib/redact.js";
import type { AdminStore } from "../src/store/admin-store.js";
import { STAGES } from "../src/store/models.js";
import { freshStore, startDb, stopDb } from "./helpers/db.js";
import { createFakes, silent } from "./helpers/fakes.js";
import { TEST_TEAM_ID } from "./helpers/users.js";


beforeAll(startDb);
afterAll(stopDb);
beforeEach(() => clearRegisteredSecrets());

async function setup() {
  const store = await freshStore();
  const fakes = createFakes(store);
  const engine = new JobEngine(store, fakes.deps, silent);
  return { store, engine, ...fakes };
}

async function createClient(store: AdminStore, slug = "acme-crm") {
  return store.createClientWithJob({ teamId: TEST_TEAM_ID, slug, name: "Acme CRM", description: "CRM interno de Acme", actor: "admin" });
}

const writes = (github: ReturnType<typeof createFakes>["github"], name: string) =>
  github.calls.filter((c) => c.method === "putEnvironmentSecret" && c.args[1] === name).length;

function once(make: () => Error) {
  let fired = false;
  return () => {
    if (fired) return undefined;
    fired = true;
    return make();
  };
}

describe("orden de etapas", () => {
  it("dns_https y server_prepare van entre github_secrets y deploy, y se ven en el progreso", async () => {
    const { store, engine } = await setup();
    expect(STAGES.map((s) => s.name)).toEqual([
      "github_repository",
      "mongodb_database",
      "github_secrets",
      "dns_https",
      "server_prepare",
      "deploy",
      "health_check"
    ]);
    const job = await createClient(store);
    const events: PublicJob[] = [];
    engine.subscribe(job._id, (j) => events.push(j));
    expect((await engine.run(job._id, "admin"))?.status).toBe("succeeded");
    // La pantalla de carga recibe los pasos de las etapas nuevas.
    const steps = (name: string) => events.at(-1)!.stages.find((s) => s.name === name)!.steps.map((s) => [s.id, s.status]);
    expect(steps("dns_https")).toEqual([["resolve", "done"], ["match", "done"]]);
    expect(steps("server_prepare")).toEqual([["key", "done"], ["install", "done"], ["secret", "done"], ["variables", "done"]]);
  });
});

describe("dns_https", () => {
  it("si el subdominio no resuelve, se detiene con un error accionable", async () => {
    const { store, engine, resolver, server } = await setup();
    resolver.wildcard = null;
    const job = await createClient(store);
    const result = await engine.run(job._id, "admin");
    const stage = result!.stages.find((s) => s.name === "dns_https")!;
    expect(stage.error?.code).toBe("dns_not_resolving");
    expect(stage.error?.message).toContain("*.apps.example.test");
    expect(stage.error?.message).toContain("203.0.113.10");
    // No se tocó el servidor.
    expect(server.count("installClient")).toBe(0);
  });

  it("si resuelve a otra IP, también se detiene", async () => {
    const { store, engine, resolver } = await setup();
    resolver.records.set("acme-crm.apps.example.test", ["198.51.100.7"]);
    const job = await createClient(store);
    const result = await engine.run(job._id, "admin");
    expect(result!.stages.find((s) => s.name === "dns_https")!.error?.code).toBe("dns_wrong_ip");
  });

  it("tras crear el registro, el reintento continúa", async () => {
    const { store, engine, resolver } = await setup();
    resolver.wildcard = null;
    const job = await createClient(store);
    await engine.run(job._id, "admin");
    resolver.wildcard = ["203.0.113.10"];
    await store.prepareRetry(job._id);
    expect((await engine.run(job._id, "admin"))?.status).toBe("succeeded");
  });
});

describe("server_prepare", () => {
  it("instala con una clave ed25519 propia del cliente y escribe DEPLOY_SSH_KEY con su privada", async () => {
    const { store, engine, github, server } = await setup();
    const job = await createClient(store);
    await engine.run(job._id, "admin");
    const installed = server.clients.get("acme-crm")!;
    const privateKey = github.env("acme-crm-app").secrets.get("DEPLOY_SSH_KEY")!;
    expect(privateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----/);
    expect(installed.publicKey).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5/);
    const client = await store.getClient("acme-crm");
    expect(client?.deployment).toMatchObject({ host: "acme-crm.apps.example.test", port: installed.port, certificate: "issued" });
    // La clave pública se guarda como referencia; la privada, nunca.
    const resource = await store.getResource("server_client", "acme-crm.apps.example.test");
    expect(resource?.ref.publicKey).toBe(installed.publicKey);
    expect(JSON.stringify(await store.resources.find().toArray())).not.toContain("PRIVATE KEY");
  });

  it("con DEPLOY_SSH_KEY ya escrito, el reintento no lo sobrescribe y el servidor conserva su clave", async () => {
    const { store, engine, github, server } = await setup();
    const job = await createClient(store);
    github.nextRunConclusion = "failure";
    await engine.run(job._id, "admin");
    const key = server.clients.get("acme-crm")!.publicKey;

    github.nextRunConclusion = "success";
    await store.prepareRetry(job._id);
    expect((await engine.run(job._id, "admin"))?.status).toBe("succeeded");
    expect(writes(github, "DEPLOY_SSH_KEY")).toBe(1);
    expect(server.clients.get("acme-crm")!.publicKey).toBe(key);
    // Tras una rotación manual en el servidor, un reintento no reinstala la clave antigua.
    server.clients.get("acme-crm")!.publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRotadaManualmente0000000000000000000000000";
    await store.jobs.updateOne({ _id: job._id }, { $set: { "stages.4.status": "failed", status: "failed", active: false } });
    await store.prepareRetry(job._id);
    await engine.run(job._id, "admin");
    expect(server.clients.get("acme-crm")!.publicKey).toContain("RotadaManualmente");
  });

  it("si install-client falla, el reintento no duplica claves, secretos ni rutas", async () => {
    const { store, engine, github, server } = await setup();
    server.faults.set("installClient", once(() => new FatalError("server_command_failed", "certbot no pudo emitir el certificado")));
    const job = await createClient(store);
    const failed = await engine.run(job._id, "admin");
    expect(failed!.stages.find((s) => s.name === "server_prepare")!.error?.message).toContain("certbot");
    // No se escribió una clave que el servidor no tiene.
    expect(writes(github, "DEPLOY_SSH_KEY")).toBe(0);

    await store.prepareRetry(job._id);
    expect((await engine.run(job._id, "admin"))?.status).toBe("succeeded");
    expect(writes(github, "DEPLOY_SSH_KEY")).toBe(1);
    expect(server.clients.size).toBe(1);
    // La clave instalada es la del secret escrito (un par generado en el reintento).
    const installs = server.calls.filter((c) => c.method === "installClient");
    expect(installs).toHaveLength(2);
    expect(server.clients.get("acme-crm")!.publicKey).toBe(installs.at(-1)!.args[1]);
    expect(await store.resources.countDocuments({ kind: "server_client" })).toBe(1);
  });

  it("si la clave quedó instalada pero el secret no se escribió (interrupción), genera un par nuevo y lo reescribe", async () => {
    const { store, engine, github, server } = await setup();
    github.faults.set(
      "putEnvironmentSecret",
      () => (github.calls.at(-1)?.args[1] === "DEPLOY_SSH_KEY" && writes(github, "DEPLOY_SSH_KEY") === 1 ? new FatalError("github_rejected", "x") : undefined)
    );
    const job = await createClient(store);
    await engine.run(job._id, "admin");
    const first = server.clients.get("acme-crm")!.publicKey;
    github.env("acme-crm-app").secrets.delete("DEPLOY_SSH_KEY");

    await store.prepareRetry(job._id);
    expect((await engine.run(job._id, "admin"))?.status).toBe("succeeded");
    const second = server.clients.get("acme-crm")!.publicKey;
    expect(second).not.toBe(first);
    expect(server.clients.size).toBe(1);
    expect(github.env("acme-crm-app").secrets.has("DEPLOY_SSH_KEY")).toBe(true);
  });

  it("DEPLOY_SSH_KEY existente pero sin clave en el servidor: error claro sin sobrescribir el secret", async () => {
    const { store, engine, github, server } = await setup();
    const job = await createClient(store);
    github.nextRunConclusion = "failure";
    await engine.run(job._id, "admin");
    // El servidor perdió la clave (p. ej. reinstalado) y se reintenta desde la preparación.
    server.clients.clear();
    await store.jobs.updateOne({ _id: job._id }, { $set: { "stages.4.status": "failed" } });
    github.nextRunConclusion = "success";
    await store.prepareRetry(job._id);
    const result = await engine.run(job._id, "admin");
    expect(result!.stages.find((s) => s.name === "server_prepare")!.error?.message).toContain("no hay ninguna clave instalada");
    expect(writes(github, "DEPLOY_SSH_KEY")).toBe(1);
  });
});

describe("deploy y health_check", () => {
  it("un run fallido indica el job y el paso", async () => {
    const { store, engine, github } = await setup();
    github.nextRunConclusion = "failure";
    const job = await createClient(store);
    const result = await engine.run(job._id, "admin");
    expect(result!.stages.find((s) => s.name === "deploy")!.error?.message).toContain("deploy › Deploy over SSH");
  });

  it("registra la imagen desplegada (digest) y que HTTPS se verificó", async () => {
    const { store, engine } = await setup();
    const job = await createClient(store);
    const result = await engine.run(job._id, "admin");
    // Si el trabajo no terminó, el motivo (etapa y error) aparece en el fallo.
    expect(result?.stages.filter((s) => s.status !== "succeeded").map((s) => [s.name, s.error])).toEqual([]);
    const client = await store.getClient("acme-crm");
    expect(client?.deployment?.image).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(client?.deployment?.deployedAt).toBeInstanceOf(Date);
    expect(client?.deployment?.httpsVerifiedAt).toBeInstanceOf(Date);
    expect(client?.deployment?.httpsTrusted).toBe(true);
  });

  it("ninguna etapa borra recursos ante un fallo", async () => {
    const { store, engine, github, server } = await setup();
    github.nextRunConclusion = "failure";
    const job = await createClient(store);
    await engine.run(job._id, "admin");
    expect(server.clients.size).toBe(1);
    expect(github.repos.size).toBe(1);
    expect(github.env("acme-crm-app").secrets.has("DEPLOY_SSH_KEY")).toBe(true);
  });
});
