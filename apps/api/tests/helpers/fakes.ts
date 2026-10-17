import { AtlasUserExistsError, type AtlasAdapter, type AtlasDatabaseUser, type DatabaseUserSpec } from "../../src/adapters/atlas.js";
import {
  type CheckSummary,
  GithubRepoExistsError,
  type GithubAdapter,
  type PullRequestInfo,
  type RepoInfo,
  type WorkflowRun
} from "../../src/adapters/github.js";
import type { HttpProbe } from "../../src/adapters/http-probe.js";
import type { InstallResult, ServerAdapter, ServerClientStatus, UninstallResult } from "../../src/adapters/server.js";
import { randomBytes } from "node:crypto";
import type { BootstrapDocument, BootstrapPhase, MongoBootstrapAdapter } from "../../src/adapters/mongo-bootstrap.js";
import { FatalError, TransientError } from "../../src/lib/errors.js";
import type { Deps, DnsResolver, ProvisioningConfig, Timing } from "../../src/jobs/types.js";
import type { AdminStore } from "../../src/store/admin-store.js";
import type { ValidationResult } from "../../src/integrations/catalog.js";
import { InitialPasswordVault } from "../../src/store/initial-password-vault.js";
import { ProvisioningSecrets } from "../../src/store/provisioning-secrets.js";

type Fault = () => Error | undefined;

/** Permite inyectar fallos por método: `faults.set("createDatabaseUser", () => err)`. */
class Faulty {
  readonly faults = new Map<string, Fault>();
  readonly calls: { method: string; args: unknown[] }[] = [];
  protected hit(method: string, ...args: unknown[]) {
    this.calls.push({ method, args });
    const error = this.faults.get(method)?.();
    if (error) throw error;
  }
  count(method: string) {
    return this.calls.filter((c) => c.method === method).length;
  }
}

export class FakeAtlas extends Faulty implements AtlasAdapter {
  readonly users = new Map<string, { user: AtlasDatabaseUser; password: string }>();
  /** Contraseñas que han pasado por el adaptador (para comprobar que no se filtran). */
  readonly seenPasswords: string[] = [];

  private toUser(spec: DatabaseUserSpec): AtlasDatabaseUser {
    return {
      username: spec.username,
      databaseName: "admin",
      labels: spec.labels,
      roles: [{ roleName: "readWrite", databaseName: spec.database }],
      scopes: [{ name: "shared-cluster", type: "CLUSTER" }],
      description: spec.description
    };
  }

  async getDatabaseUser(username: string) {
    this.hit("getDatabaseUser", username);
    return this.users.get(username)?.user ?? null;
  }
  async createDatabaseUser(spec: DatabaseUserSpec) {
    this.hit("createDatabaseUser", spec.username);
    if (this.users.has(spec.username)) throw new AtlasUserExistsError();
    this.seenPasswords.push(spec.password);
    this.users.set(spec.username, { user: this.toUser(spec), password: spec.password });
  }
  async updateDatabaseUser(spec: DatabaseUserSpec) {
    this.hit("updateDatabaseUser", spec.username);
    this.seenPasswords.push(spec.password);
    this.users.set(spec.username, { user: this.toUser(spec), password: spec.password });
  }
  async deleteDatabaseUser(username: string) {
    this.hit("deleteDatabaseUser", username);
    return this.users.delete(username);
  }
}

/** Mongo simulado: valida la contraseña contra FakeAtlas como haría el clúster. */
export class FakeMongo extends Faulty implements MongoBootstrapAdapter {
  readonly databases = new Map<string, BootstrapDocument>();
  constructor(private readonly atlas: FakeAtlas) {
    super();
  }
  credentialsValid(uri: string) {
    const match = /^mongodb\+srv:\/\/([^:]+):([^@]+)@/.exec(uri);
    if (!match) return false;
    const entry = this.atlas.users.get(decodeURIComponent(match[1]));
    return !!entry && entry.password === decodeURIComponent(match[2]);
  }
  /** Simula la propagación de Atlas: las N primeras conexiones fallan por autenticación. */
  pendingAuthFailures = 0;
  async bootstrap(
    { uri, database, document }: { uri: string; database: string; document: BootstrapDocument },
    onPhase: (phase: BootstrapPhase, detail: string) => Promise<void> | void = () => {}
  ) {
    this.hit("bootstrap", database);
    if (this.pendingAuthFailures > 0) {
      this.pendingAuthFailures--;
      throw new TransientError("mongodb_auth_pending", "auth failed");
    }
    if (!this.credentialsValid(uri)) throw new TransientError("mongodb_auth_pending", "auth failed");
    await onPhase("connected", "conectado");
    await onPhase("collection", "colección");
    if (!this.databases.has(database)) this.databases.set(database, document);
    await onPhase("document", "documento");
    await onPhase("verified", "verificado");
  }
  async dropAllCollections({ uri, database }: { uri: string; database: string }) {
    this.hit("dropAllCollections", database);
    if (!this.credentialsValid(uri)) throw new TransientError("mongodb_auth_pending", "auth failed");
    return this.databases.delete(database) ? 1 : 0;
  }
}

interface FakeEnvironment {
  secrets: Map<string, string>;
  variables: Map<string, string>;
}

export class FakeGithub extends Faulty implements GithubAdapter {
  readonly owner = "acme-org";
  readonly repos = new Map<string, RepoInfo>();
  readonly files = new Map<string, string>();
  readonly environments = new Map<string, FakeEnvironment>();
  readonly runs = new Map<string, WorkflowRun[]>();
  readonly topics = new Map<string, string[]>();
  /** Conclusión del próximo run lanzado. */
  nextRunConclusion: "success" | "failure" = "success";
  templateVersion = "1.5.0";

  async getRepository(name: string) {
    this.hit("getRepository", name);
    return this.repos.get(name) ?? null;
  }
  async createRepositoryFromTemplate(name: string) {
    this.hit("createRepositoryFromTemplate", name);
    if (this.repos.has(name)) throw new GithubRepoExistsError(name);
    const repo = { name, fullName: `${this.owner}/${name}`, url: `https://github.com/${this.owner}/${name}`, private: true, defaultBranch: "main" };
    this.repos.set(name, repo);
    this.files.set(`${name}/package.json`, JSON.stringify({ name, template: { name: "node-typescript", version: this.templateVersion } }));
    return repo;
  }
  async readFile(repo: string, path: string) {
    this.hit("readFile", repo, path);
    return this.files.get(`${repo}/${path}`) ?? null;
  }
  async environmentExists(repo: string, environment: string) {
    this.hit("environmentExists", repo);
    return this.environments.has(`${repo}/${environment}`);
  }
  async createEnvironment(repo: string, environment: string) {
    this.hit("createEnvironment", repo);
    if (!this.environments.has(`${repo}/${environment}`)) {
      this.environments.set(`${repo}/${environment}`, { secrets: new Map(), variables: new Map() });
    }
  }
  env(repo: string, environment = "production") {
    const env = this.environments.get(`${repo}/${environment}`);
    if (!env) throw new Error(`no environment ${repo}/${environment}`);
    return env;
  }
  async listEnvironmentSecretNames(repo: string, environment: string) {
    this.hit("listEnvironmentSecretNames", repo);
    return [...this.env(repo, environment).secrets.keys()];
  }
  async putEnvironmentSecret(repo: string, environment: string, name: string, value: string) {
    this.hit("putEnvironmentSecret", repo, name);
    this.env(repo, environment).secrets.set(name, value);
  }
  async deleteEnvironmentSecret(repo: string, environment: string, name: string) {
    this.hit("deleteEnvironmentSecret", repo, name);
    return this.env(repo, environment).secrets.delete(name);
  }
  async getEnvironmentVariable(repo: string, environment: string, name: string) {
    this.hit("getEnvironmentVariable", repo, name);
    return this.env(repo, environment).variables.get(name) ?? null;
  }
  async setEnvironmentVariable(repo: string, environment: string, name: string, value: string) {
    this.hit("setEnvironmentVariable", repo, name);
    this.env(repo, environment).variables.set(name, value);
  }
  /** Workflows que no existen en el repo ("repo/archivo"), p. ej. preview.yml en repos 1.4.0. */
  readonly missingWorkflows = new Set<string>();
  /** Conclusión de los runs de vista previa (null: siguen en curso). */
  nextPreviewConclusion: "success" | "failure" | null = "success";
  /** deploy.yml usa la clave del repo (compatibilidad con los tests de despliegue); el resto, "repo:archivo". */
  private runKey(repo: string, file = "deploy.yml") {
    return file === "deploy.yml" ? repo : `${repo}:${file}`;
  }
  async getWorkflow(repo: string, file = "deploy.yml") {
    this.hit("getWorkflow", repo);
    return this.repos.has(repo) && !this.missingWorkflows.has(`${repo}/${file}`) ? { id: 1, state: "active" } : null;
  }
  async dispatchWorkflow(repo: string, file = "deploy.yml", ref = "main") {
    this.hit("dispatchWorkflow", repo, file, ref);
    if (file !== "deploy.yml") {
      const key = this.runKey(repo, file);
      const list = this.runs.get(key) ?? [];
      const id = 5000 + list.length;
      const conclusion = this.nextPreviewConclusion;
      list.unshift({ id, status: conclusion ? "completed" : "in_progress", conclusion, url: `https://github.com/${this.owner}/${repo}/actions/runs/${id}`, createdAt: new Date().toISOString() });
      this.runs.set(key, list);
      return;
    }
    const list = this.runs.get(repo) ?? [];
    const id = 1000 + list.length;
    list.unshift({
      id,
      status: "completed",
      conclusion: this.nextRunConclusion,
      url: `https://github.com/${this.owner}/${repo}/actions/runs/${id}`,
      createdAt: new Date().toISOString()
    });
    this.runs.set(repo, list);
  }
  async listDispatchRuns(repo: string, file = "deploy.yml") {
    this.hit("listDispatchRuns", repo, file);
    return this.runs.get(this.runKey(repo, file)) ?? [];
  }
  async getRun(repo: string, runId: number) {
    this.hit("getRun", repo, runId);
    const run = [...this.runs.entries()].filter(([k]) => k === repo || k.startsWith(`${repo}:`)).flatMap(([, list]) => list).find((r) => r.id === runId);
    if (!run) throw new Error("run not found");
    return run;
  }
  /** Resultado de borrar la imagen en GHCR (en cuentas personales la App no puede). */
  packageDeletion: "deleted" | "not_found" | "forbidden" = "deleted";
  async deleteRepository(name: string) {
    this.hit("deleteRepository", name);
    this.environments.delete(`${name}/production`);
    return this.repos.delete(name);
  }
  async deleteContainerPackage(name: string) {
    this.hit("deleteContainerPackage", name);
    return this.packageDeletion;
  }
  async getRunFailure(repo: string, runId: number) {
    this.hit("getRunFailure", repo, runId);
    return "deploy › Deploy over SSH";
  }
  async listProjectRepos() {
    return [...this.repos.values()].map((r, i) => ({
      ...r,
      id: i + 1,
      description: null,
      archived: false,
      language: "TypeScript",
      createdAt: null,
      pushedAt: null,
      topics: this.topics.get(r.name) ?? []
    }));
  }
  // ---- ramas, PR y validaciones (AI Developer) ----
  /** "repo/rama" → commits (el último es la cabeza). main empieza con un commit. */
  readonly branches = new Map<string, { sha: string; message: string; email: string }[]>();
  readonly pulls = new Map<string, PullRequestInfo & { head: string; base: string; title: string; body: string }>();
  /** Validaciones por sha (por defecto, un check de CI en verde). */
  readonly checks = new Map<string, CheckSummary>();
  readonly issuedTokens: string[] = [];
  mergeable: boolean | null = true;

  private commitsOf(repo: string, branch: string) {
    if (branch === "main" && !this.branches.has(`${repo}/main`) && this.repos.has(repo)) {
      this.branches.set(`${repo}/main`, [{ sha: `main-${repo}-0`, message: "Initial commit", email: "template@example.com" }]);
    }
    return this.branches.get(`${repo}/${branch}`);
  }
  /** Simula un push del agente a la rama. */
  pushCommit(repo: string, branch: string, message: string, email = "ai-developer@launchpad.invalid") {
    const commits = this.commitsOf(repo, branch);
    if (!commits) throw new Error(`no existe ${repo}/${branch}`);
    const sha = `sha-${randomBytes(4).toString("hex")}`;
    commits.push({ sha, message, email });
    return sha;
  }
  /** Permisos de la instalación (por defecto, todo lo que necesita el AI Developer). */
  installationPermissions: Record<string, string> = { administration: "write", contents: "write", pull_requests: "write", checks: "read", actions: "write" };
  async getInstallationPermissions() {
    this.hit("getInstallationPermissions");
    return this.installationPermissions;
  }
  async createRepoToken(repo: string) {
    this.hit("createRepoToken", repo);
    const token = `ghs_${randomBytes(18).toString("hex")}`;
    this.issuedTokens.push(token);
    return token;
  }
  async getBranchSha(repo: string, branch: string) {
    this.hit("getBranchSha", repo, branch);
    return this.commitsOf(repo, branch)?.at(-1)?.sha ?? null;
  }
  async createBranch(repo: string, branch: string, sha: string) {
    this.hit("createBranch", repo, branch);
    const base = this.commitsOf(repo, "main") ?? [];
    const upTo = base.findIndex((c) => c.sha === sha);
    this.branches.set(`${repo}/${branch}`, base.slice(0, upTo + 1));
  }
  async deleteBranch(repo: string, branch: string) {
    this.hit("deleteBranch", repo, branch);
    return this.branches.delete(`${repo}/${branch}`);
  }
  async compareBranches(repo: string, base: string, head: string) {
    this.hit("compareBranches", repo, base, head);
    const baseCommits = this.commitsOf(repo, base) ?? [];
    const headCommits = this.commitsOf(repo, head) ?? [];
    const ahead = headCommits.filter((c) => !baseCommits.some((b) => b.sha === c.sha));
    return {
      aheadBy: ahead.length,
      behindBy: 0,
      url: `https://github.com/${this.owner}/${repo}/compare/${base}...${head}`,
      commits: ahead.map((c) => ({ sha: c.sha, message: c.message, author: "Launchpad AI Developer", date: null })),
      files: ahead.map((c, i) => ({ filename: `web/src/file-${i}.tsx`, status: "modified", additions: 3, deletions: 1, patch: `@@ -1 +1 @@\n-old\n+${c.message}` }))
    };
  }
  async createPullRequest(repo: string, input: { head: string; base: string; title: string; body: string }) {
    this.hit("createPullRequest", repo, input.head);
    const number = this.pulls.size + 1;
    const pr = { number, url: `https://github.com/${this.owner}/${repo}/pull/${number}`, state: "open" as const, merged: false, mergeable: this.mergeable, headSha: this.commitsOf(repo, input.head)!.at(-1)!.sha, ...input };
    this.pulls.set(`${repo}#${number}`, pr);
    return pr;
  }
  async getPullRequest(repo: string, number: number) {
    this.hit("getPullRequest", repo, number);
    const pr = this.pulls.get(`${repo}#${number}`)!;
    return { ...pr, mergeable: pr.merged ? null : this.mergeable, headSha: this.commitsOf(repo, pr.head)?.at(-1)?.sha ?? pr.headSha };
  }
  async getChecks(repo: string, sha: string) {
    this.hit("getChecks", repo, sha);
    return this.checks.get(sha) ?? { total: 1, pending: 0, failed: 0, checks: [{ name: "validate", status: "completed", conclusion: "success", url: null }] };
  }
  async mergePullRequest(repo: string, number: number, input: { sha: string; title: string }) {
    this.hit("mergePullRequest", repo, number, input.sha);
    const pr = this.pulls.get(`${repo}#${number}`)!;
    const head = this.commitsOf(repo, pr.head)!;
    if (head.at(-1)!.sha !== input.sha) throw new FatalError("github_rejected", "head cambió");
    pr.merged = true;
    pr.state = "closed";
    const sha = this.pushCommit(repo, "main", input.title, "platform@example.com");
    return sha;
  }
  async countCommitsByAuthor(repo: string, branch: string, email: string, since: Date) {
    this.hit("countCommitsByAuthor", repo, branch, email, since.toISOString());
    return (this.commitsOf(repo, branch) ?? []).filter((c) => c.email === email).length;
  }
  async setRepositoryTopics(name: string, topics: string[]) {
    this.hit("setRepositoryTopics", name, topics.join(","));
    this.topics.set(name, topics);
  }
}

/**
 * VPS simulado: install-client (puerto, certificado, clave con comando forzado) y
 * client-status. Cuenta emisiones de certificado y guarda una clave por cliente.
 */
export class FakeServer extends Faulty implements ServerAdapter {
  readonly clients = new Map<string, { port: number; publicKey: string; certificates: number }>();
  private nextPort = 20000;
  constructor(private readonly github: FakeGithub, private readonly appsDomain: string) {
    super();
  }
  async installClient(slug: string, publicKey?: string): Promise<InstallResult> {
    this.hit("installClient", slug, publicKey);
    const existing = this.clients.get(slug);
    if (!publicKey && !existing) throw new FatalError("server_command_failed", `no hay ninguna clave instalada para ${slug}`);
    if (publicKey && !/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/]{48}( |$)/.test(publicKey)) throw new Error("clave inválida");
    const entry = existing ?? { port: this.nextPort++, publicKey: publicKey!, certificates: 1 };
    if (publicKey) entry.publicKey = publicKey; // una clave por cliente: se reemplaza
    this.clients.set(slug, entry);
    return {
      status: "ok",
      slug,
      host: `${slug}.${this.appsDomain}`,
      port: entry.port,
      certificate: existing ? "existing" : "issued",
      key: publicKey ? "installed" : "kept"
    };
  }
  async uninstallClient(slug: string): Promise<UninstallResult> {
    this.hit("uninstallClient", slug);
    const existed = this.clients.delete(slug);
    return {
      status: "ok",
      slug,
      removed: { container: existed, images: existed ? 1 : 0, network: existed, nginx: existed, certificate: existed, key: existed, port: existed, files: existed }
    };
  }
  readonly previews = new Map<string, { port: number; running: boolean; certificates: number }>();
  async installPreview(slug: string) {
    this.hit("installPreview", slug);
    if (!this.clients.has(slug)) throw new FatalError("server_command_failed", `${slug} no está instalado`);
    const existing = this.previews.get(slug);
    const entry = existing ?? { port: this.nextPort++, running: false, certificates: 1 };
    this.previews.set(slug, entry);
    return { status: "ok" as const, slug, host: `preview-${slug}.${this.appsDomain}`, port: entry.port, certificate: existing ? ("existing" as const) : ("issued" as const) };
  }
  async stopPreview(slug: string) {
    this.hit("stopPreview", slug);
    const entry = this.previews.get(slug);
    const stopped = Boolean(entry?.running);
    if (entry) entry.running = false;
    return { stopped };
  }
  async clientStatus(slug: string): Promise<ServerClientStatus> {
    this.hit("clientStatus", slug);
    const entry = this.clients.get(slug);
    const deployed = (this.github.runs.get(`${slug}-app`) ?? []).some((r) => r.conclusion === "success");
    return {
      slug,
      host: `${slug}.${this.appsDomain}`,
      port: entry?.port ?? null,
      nginx: !!entry,
      certificate: entry ? { notAfter: "2027-01-13T15:01:54Z" } : null,
      deployment: deployed ? { image: `ghcr.io/acme-org/${slug}-app@sha256:${"a".repeat(64)}`, deployedAt: "2026-10-15T20:00:00Z" } : null,
      container: deployed ? { state: "running", health: "healthy" } : null
    };
  }
}

/** DNS simulado: por defecto el comodín resuelve todo al VPS. */
export class FakeResolver extends Faulty implements DnsResolver {
  readonly records = new Map<string, string[]>();
  wildcard: string[] | null = ["203.0.113.10"];
  async resolve4(host: string) {
    this.hit("resolve4", host);
    const found = this.records.get(host) ?? this.wildcard;
    if (!found) throw Object.assign(new Error(`queryA ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return found;
  }
}

/**
 * La "app" desplegada (template 1.3.0): responde ready solo si el servidor la
 * instaló con la clave de DEPLOY_SSH_KEY, el secret MONGODB_URI autentica contra
 * Atlas, existe SESSION_SECRET y la base tiene bootstrap (valida la cadena entera).
 * /api/meta lee APP_DISPLAY_NAME del entorno.
 */
export class FakeProbe extends Faulty implements HttpProbe {
  /** schemaVersion que registran las migraciones de la app simulada. */
  schemaVersion = 1;
  /** Para simular un frontend que no se sirve. */
  frontendContentType = "text/html; charset=utf-8";
  /** Para simular una app que expone otro appName. */
  appNameOverride?: string;
  constructor(
    private readonly github: FakeGithub,
    private readonly mongo: FakeMongo,
    private readonly appsDomain: string,
    private readonly server?: FakeServer
  ) {
    super();
  }
  private app(url: string) {
    const host = new URL(url).host;
    const slug = host.replace(`.${this.appsDomain}`, "");
    const repo = `${slug}-app`;
    const env = this.github.environments.get(`${repo}/production`);
    const uri = env?.secrets.get("MONGODB_URI");
    const db = env?.secrets.get("MONGODB_DB");
    const sessionSecret = env?.secrets.get("SESSION_SECRET");
    const deployed = (this.github.runs.get(repo) ?? []).some((r) => r.conclusion === "success");
    const installed =
      !this.server ||
      (this.server.clients.has(slug) && !!env?.secrets.get("DEPLOY_SSH_KEY") && env?.variables.get("APP_HOSTNAME") === host);
    const ok = deployed && installed && !!uri && !!db && (sessionSecret?.length ?? 0) >= 32 && this.mongo.credentialsValid(uri);
    return { ok, doc: db ? this.mongo.databases.get(db) : undefined, appName: env?.variables.get("APP_DISPLAY_NAME") ?? "Aplicación" };
  }
  async status(url: string) {
    this.hit("status", url);
    return this.app(url).ok ? 200 : 503;
  }
  async json(url: string) {
    this.hit("json", url);
    const { ok, doc, appName } = this.app(url);
    if (!ok) return { status: 503, body: { error: "service_unavailable" } };
    return {
      status: 200,
      body: { appName: this.appNameOverride ?? appName, clientId: doc?.clientId ?? null, templateVersion: doc?.templateVersion ?? null, schemaVersion: this.schemaVersion }
    };
  }
  async page(url: string) {
    this.hit("page", url);
    return this.app(url).ok ? { status: 200, contentType: this.frontendContentType } : { status: 503, contentType: "application/json" };
  }
}

export const TEST_TIMING: Timing = {
  stageAttempts: 3,
  backoffBaseMs: 1,
  backoffMaxMs: 2,
  leaseTtlMs: 5_000,
  repoContentTimeoutMs: 20,
  mongoAuthTimeoutMs: 20,
  workflowAvailableTimeoutMs: 20,
  runAppearTimeoutMs: 20,
  runCompleteTimeoutMs: 20,
  healthTimeoutMs: 20,
  pollIntervalMs: 1
};

export const TEST_CONFIG: ProvisioningConfig = {
  appsDomain: "apps.example.test",
  atlas: { clusterName: "shared-cluster", srvHost: "shared-cluster.abcde.mongodb.net" },
  template: {
    name: "node-typescript",
    environment: "production",
    deployWorkflow: "deploy.yml",
    ref: "main",
    schemaVersion: 1,
    expectedVersion: "1.5.0",
    minSchemaVersion: 1
  },
  initialAdmin: { mode: "random", revealTtlMs: 30 * 60_000 },
  deployEnabled: true,
  server: {
    host: "vps.example.test",
    knownHosts: "vps.example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyForTests",
    publicIp: "203.0.113.10",
    ghcrOrg: "acme-org"
  }
};

/** Reloj controlable del almacén de contraseñas (para probar el TTL). */
export class FakeClock {
  ms = Date.now();
  now = () => new Date(this.ms);
  advance(ms: number) {
    this.ms += ms;
  }
}

export function createFakes(store: AdminStore) {
  const atlas = new FakeAtlas();
  const mongo = new FakeMongo(atlas);
  const github = new FakeGithub();
  const server = new FakeServer(github, TEST_CONFIG.appsDomain);
  const resolver = new FakeResolver();
  const probe = new FakeProbe(github, mongo, TEST_CONFIG.appsDomain, server);
  const clock = new FakeClock();
  const vault = new InitialPasswordVault(store.initialPasswords, randomBytes(32), clock.now);
  const secrets = new ProvisioningSecrets(store.provisioningSecrets, randomBytes(32), 24 * 3_600_000, clock.now);
  /** Validación simulada: "token-valido…" es correcto; el resto, el código configurado. */
  const integrationCheck = {
    calls: [] as { provider: string; credentials: Record<string, string> }[],
    failWith: null as ValidationResult | null
  };
  const validateIntegration = async (provider: string, credentials: Record<string, string>): Promise<ValidationResult> => {
    integrationCheck.calls.push({ provider, credentials });
    if (integrationCheck.failWith) return integrationCheck.failWith;
    return Object.values(credentials).every((v) => v.startsWith("token-valido")) ? { ok: true } : { ok: false, code: "auth_failed" };
  };
  const deps: Deps = {
    atlas,
    github,
    mongo,
    probe,
    server,
    resolver,
    vault,
    secrets,
    validateIntegration,
    config: TEST_CONFIG,
    timing: TEST_TIMING,
    sleep: async () => {}
  };
  return { atlas, mongo, github, probe, server, resolver, vault, secrets, integrationCheck, clock, deps };
}

/** Logger de los tests: silencioso salvo con DEBUG_STAGES=1 (muestra fallos de etapa, sin valores). */
const debug = (level: string) => (obj: object, msg?: string) => {
  if (process.env.DEBUG_STAGES) process.stderr.write(`[${level}] ${msg ?? ""} ${JSON.stringify(obj, (k, v) => (k === "err" ? String(v?.stack ?? v) : v))}\n`);
};
export const silent = { info() {}, warn: debug("warn"), error: debug("error") };
