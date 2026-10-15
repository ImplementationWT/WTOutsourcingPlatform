import { AtlasUserExistsError, type AtlasAdapter, type AtlasDatabaseUser, type DatabaseUserSpec } from "../../src/adapters/atlas.js";
import { GithubRepoExistsError, type GithubAdapter, type RepoInfo, type WorkflowRun } from "../../src/adapters/github.js";
import type { HttpProbe } from "../../src/adapters/http-probe.js";
import type { BootstrapDocument, BootstrapPhase, MongoBootstrapAdapter } from "../../src/adapters/mongo-bootstrap.js";
import { TransientError } from "../../src/lib/errors.js";
import type { Deps, ProvisioningConfig, Timing } from "../../src/jobs/types.js";

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
  /** Conclusión del próximo run lanzado. */
  nextRunConclusion: "success" | "failure" = "success";
  templateVersion = "1.0.0";

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
  async getEnvironmentVariable(repo: string, environment: string, name: string) {
    this.hit("getEnvironmentVariable", repo, name);
    return this.env(repo, environment).variables.get(name) ?? null;
  }
  async setEnvironmentVariable(repo: string, environment: string, name: string, value: string) {
    this.hit("setEnvironmentVariable", repo, name);
    this.env(repo, environment).variables.set(name, value);
  }
  async getWorkflow(repo: string) {
    this.hit("getWorkflow", repo);
    return this.repos.has(repo) ? { id: 1, state: "active" } : null;
  }
  async dispatchWorkflow(repo: string) {
    this.hit("dispatchWorkflow", repo);
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
  async listDispatchRuns(repo: string) {
    this.hit("listDispatchRuns", repo);
    return this.runs.get(repo) ?? [];
  }
  async getRun(repo: string, runId: number) {
    this.hit("getRun", repo, runId);
    const run = (this.runs.get(repo) ?? []).find((r) => r.id === runId);
    if (!run) throw new Error("run not found");
    return run;
  }
  async listProjectRepos() {
    return [...this.repos.values()].map((r, i) => ({
      ...r,
      id: i + 1,
      description: null,
      archived: false,
      language: "TypeScript",
      createdAt: null,
      pushedAt: null
    }));
  }
}

/**
 * La "app" desplegada: responde ready solo si el secret MONGODB_URI del repo
 * autentica contra Atlas y la base tiene bootstrap (valida la cadena entera).
 */
export class FakeProbe extends Faulty implements HttpProbe {
  constructor(private readonly github: FakeGithub, private readonly mongo: FakeMongo, private readonly appsDomain: string) {
    super();
  }
  private app(url: string) {
    const host = new URL(url).host;
    const slug = host.replace(`.${this.appsDomain}`, "");
    const repo = `${slug}-app`;
    const env = this.github.environments.get(`${repo}/production`);
    const uri = env?.secrets.get("MONGODB_URI");
    const db = env?.secrets.get("MONGODB_DB");
    const deployed = (this.github.runs.get(repo) ?? []).some((r) => r.conclusion === "success");
    const ok = deployed && !!uri && !!db && this.mongo.credentialsValid(uri);
    return { ok, doc: db ? this.mongo.databases.get(db) : undefined };
  }
  async status(url: string) {
    this.hit("status", url);
    return this.app(url).ok ? 200 : 503;
  }
  async json(url: string) {
    this.hit("json", url);
    const { ok, doc } = this.app(url);
    if (!ok) return { status: 503, body: { error: "service_unavailable" } };
    return { status: 200, body: doc ? { clientId: doc.clientId, templateVersion: doc.templateVersion, schemaVersion: doc.schemaVersion } : null };
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
  template: { name: "node-typescript", environment: "production", deployWorkflow: "deploy.yml", ref: "main", schemaVersion: 1 },
  deployEnabled: true,
  deploy: {
    host: "deploy.example.test",
    user: "deployer",
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZS10ZXN0LWtleQ==\n-----END OPENSSH PRIVATE KEY-----",
    knownHosts: "deploy.example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyForTests"
  }
};

export function createFakes() {
  const atlas = new FakeAtlas();
  const mongo = new FakeMongo(atlas);
  const github = new FakeGithub();
  const probe = new FakeProbe(github, mongo, TEST_CONFIG.appsDomain);
  const deps: Deps = {
    atlas,
    github,
    mongo,
    probe,
    config: TEST_CONFIG,
    timing: TEST_TIMING,
    sleep: async () => {}
  };
  return { atlas, mongo, github, probe, deps };
}
