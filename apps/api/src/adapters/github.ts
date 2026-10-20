import { readFileSync } from "node:fs";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { FatalError, isNetworkError, isTransientStatus, ProvisioningError, TransientError } from "../lib/errors.js";
import { registerSecret } from "../lib/redact.js";
import { sealForGithub } from "../lib/sealed-box.js";

export interface GithubConfig {
  appId: number;
  installationId: number;
  privateKeyPath: string;
  templateOwner: string;
  templateRepo: string;
  targetOwner: string;
}

export interface RepoInfo {
  name: string;
  fullName: string;
  url: string;
  private: boolean;
  defaultBranch: string;
}

export interface ProjectRepo extends RepoInfo {
  id: number;
  description: string | null;
  archived: boolean;
  language: string | null;
  createdAt: string | null;
  pushedAt: string | null;
  /** Topics de GitHub: las etiquetas con las que se filtran los proyectos en el panel. */
  topics: string[];
}

export interface BranchComparison {
  aheadBy: number;
  behindBy: number;
  commits: { sha: string; message: string; author: string | null; date: string | null }[];
  files: { filename: string; status: string; additions: number; deletions: number; patch: string | null }[];
  url: string;
}

export interface PullRequestInfo {
  number: number;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  /** null mientras GitHub lo calcula. */
  mergeable: boolean | null;
  headSha: string;
}

export interface CheckSummary {
  total: number;
  pending: number;
  failed: number;
  checks: { name: string; status: string; conclusion: string | null; url: string | null }[];
}

/** Topic que la plataforma pone a los repos que crea (visible y buscable en GitHub). */
export const PLATFORM_TOPIC = "launchpad";

export interface WorkflowRun {
  id: number;
  status: string | null;
  conclusion: string | null;
  url: string;
  createdAt: string;
}

/** 422 al crear: el nombre ya está en uso (o la llamada anterior sí llegó). */
export class GithubRepoExistsError extends ProvisioningError {
  constructor(name: string) {
    super("github_repo_exists", `Ya existe un repositorio llamado ${name}.`);
  }
}

export interface GithubAdapter {
  readonly owner: string;
  getRepository(name: string): Promise<RepoInfo | null>;
  createRepositoryFromTemplate(name: string, description: string): Promise<RepoInfo>;
  /** Contenido de un archivo de la rama por defecto, o null si aún no existe. */
  readFile(repo: string, path: string): Promise<string | null>;
  environmentExists(repo: string, environment: string): Promise<boolean>;
  createEnvironment(repo: string, environment: string): Promise<void>;
  listEnvironmentSecretNames(repo: string, environment: string): Promise<string[]>;
  /** Cifra con la clave pública del entorno (sealed box) y escribe el secret. */
  putEnvironmentSecret(repo: string, environment: string, name: string, value: string): Promise<void>;
  /** Borra un secret del entorno. false si no existía. */
  deleteEnvironmentSecret(repo: string, environment: string, name: string): Promise<boolean>;
  getEnvironmentVariable(repo: string, environment: string, name: string): Promise<string | null>;
  setEnvironmentVariable(repo: string, environment: string, name: string, value: string): Promise<void>;
  getWorkflow(repo: string, file: string): Promise<{ id: number; state: string } | null>;
  dispatchWorkflow(repo: string, file: string, ref: string): Promise<void>;
  listDispatchRuns(repo: string, file: string, ref: string): Promise<WorkflowRun[]>;
  getRun(repo: string, runId: number): Promise<WorkflowRun>;
  /** "Job › paso" del primer paso fallido de un run, o null. */
  getRunFailure(repo: string, runId: number): Promise<string | null>;
  listProjectRepos(): Promise<ProjectRepo[]>;
  /**
   * Token de instalación limitado a un repo y a Contents (lectura/escritura): lo usa
   * el agente de IA para clonar y hacer push de su rama. Sin permiso de workflows.
   */
  /** Token de instalación solo para `repo` (caduca en 1 h): escritura para el agente, lectura para clonar la vista previa. */
  createRepoToken(repo: string, access?: "write" | "read"): Promise<string>;
  getBranchSha(repo: string, branch: string): Promise<string | null>;
  createBranch(repo: string, branch: string, sha: string): Promise<void>;
  /** Borra la rama. false si ya no existía. */
  deleteBranch(repo: string, branch: string): Promise<boolean>;
  compareBranches(repo: string, base: string, head: string): Promise<BranchComparison>;
  createPullRequest(repo: string, input: { head: string; base: string; title: string; body: string }): Promise<PullRequestInfo>;
  getPullRequest(repo: string, number: number): Promise<PullRequestInfo>;
  getChecks(repo: string, sha: string): Promise<CheckSummary>;
  /** Fusiona (squash) solo si la cabeza sigue siendo `sha`. Devuelve el commit resultante. */
  mergePullRequest(repo: string, number: number, input: { sha: string; title: string }): Promise<string>;
  /** Commits de `branch` con ese email de autor desde `since`. */
  countCommitsByAuthor(repo: string, branch: string, email: string, since: Date): Promise<number>;
  /** Permisos concedidos a la instalación de la App ({ contents: "write", … }). */
  getInstallationPermissions(): Promise<Record<string, string>>;
  /** Reemplaza los topics del repositorio (ya validados). */
  setRepositoryTopics(name: string, topics: string[]): Promise<void>;
  /** Borra el repositorio. false si ya no existía. */
  deleteRepository(name: string): Promise<boolean>;
  /**
   * Borra el paquete de contenedor <name> de GHCR. "forbidden" si la GitHub App no
   * puede (en cuentas personales GitHub no lo permite a las Apps).
   */
  deleteContainerPackage(name: string): Promise<"deleted" | "not_found" | "forbidden">;
}

// Repos internos de la empresa que no son proyectos de la plataforma.
const EXCLUDED_REPO_PREFIXES = ["ab", "wt"];

function statusOf(error: unknown) {
  return typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status: unknown }).status)
    : undefined;
}

function isRateLimited(error: unknown) {
  const headers = (error as { response?: { headers?: Record<string, string> } }).response?.headers ?? {};
  const message = String((error as { message?: unknown }).message ?? "");
  return headers["x-ratelimit-remaining"] === "0" || /rate limit/i.test(message);
}

/** Permisos de la GitHub App que usa el AI Developer (además de los del aprovisionamiento). */
export const AI_PERMISSIONS = {
  contents: "Contents: Read and write",
  pulls: "Pull requests: Read and write",
  checks: "Checks: Read-only"
} as const;

/**
 * Traduce errores de Octokit a Transient/Fatal con mensajes accionables. `permission`
 * nombra el permiso de la App que necesita esta operación (para el mensaje de 403).
 */
export function classifyGithubError(error: unknown, action: string, permission?: string): never {
  if (error instanceof ProvisioningError) throw error;
  const status = statusOf(error);

  if (isNetworkError(error) || status === undefined) {
    throw new TransientError("github_unreachable", `No se pudo conectar con GitHub al ${action} (timeout o red).`, { cause: error });
  }
  if (status === 403 && isRateLimited(error)) {
    throw new TransientError("github_rate_limited", `GitHub limitó las peticiones al ${action}.`);
  }
  if (isTransientStatus(status)) {
    throw new TransientError("github_unavailable", `GitHub respondió HTTP ${status} al ${action}.`);
  }
  if (status === 401) {
    throw new FatalError(
      "github_invalid_credentials",
      "GitHub rechazó las credenciales de la GitHub App. Revisa GITHUB_APP_ID, la clave privada y GITHUB_INSTALLATION_ID."
    );
  }
  if (status === 403) {
    throw new FatalError(
      "github_forbidden",
      permission
        ? `La GitHub App no tiene permiso para ${action}: necesita «${permission}». Añádelo en GitHub → Settings → Developer settings → GitHub Apps → la App → Permissions y acepta el cambio en la instalación.`
        : `La GitHub App no tiene permisos para ${action}. Necesita Administration, Contents (lectura), Environments, Secrets, Variables y Actions (escritura).`
    );
  }
  if (status === 404) {
    throw new FatalError("github_not_found", `GitHub no encontró el recurso al ${action}.`);
  }
  throw new FatalError("github_rejected", `GitHub rechazó la petición al ${action} (HTTP ${status}).`);
}

export function createOctokit(config: GithubConfig) {
  const privateKey = readFileSync(config.privateKeyPath, "utf8");
  registerSecret(privateKey);
  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: config.appId, privateKey, installationId: config.installationId },
    request: { timeout: 15_000 },
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  });
}

export function createGithubAdapter(config: GithubConfig, octokit: Octokit = createOctokit(config)): GithubAdapter {
  const owner = config.targetOwner;

  async function call<T>(action: string, fn: () => Promise<T>, permission?: string): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      return classifyGithubError(error, action, permission);
    }
  }

  /** Igual que `call`, pero un 404 se devuelve como null. */
  async function find<T>(action: string, fn: () => Promise<T>, permission?: string): Promise<T | null> {
    try {
      return await fn();
    } catch (error) {
      if (statusOf(error) === 404) return null;
      return classifyGithubError(error, action, permission);
    }
  }

  const readContent = (repoOwner: string, repo: string, path: string) =>
    find(`leer ${path} de ${repoOwner}/${repo}`, async () => {
      const { data } = await octokit.rest.repos.getContent({ owner: repoOwner, repo, path });
      if (Array.isArray(data) || data.type !== "file" || !("content" in data)) return null;
      return Buffer.from(data.content, "base64").toString("utf8");
    });

  const toRepo = (data: { name: string; full_name: string; html_url: string; private: boolean; default_branch?: string }): RepoInfo => ({
    name: data.name,
    fullName: data.full_name,
    url: data.html_url,
    private: data.private,
    defaultBranch: data.default_branch ?? "main"
  });

  const toPull = (pr: { number: number; html_url: string; state: string; merged?: boolean | null; merged_at?: string | null; mergeable?: boolean | null; head: { sha: string } }): PullRequestInfo => ({
    number: pr.number,
    url: pr.html_url,
    state: pr.state === "closed" ? "closed" : "open",
    merged: Boolean(pr.merged ?? pr.merged_at),
    mergeable: pr.mergeable ?? null,
    headSha: pr.head.sha
  });

  const toRun = (run: { id: number; status: string | null; conclusion: string | null; html_url: string; created_at: string }): WorkflowRun => ({
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    url: run.html_url,
    createdAt: run.created_at
  });

  return {
    owner,

    getRepository: (name) =>
      find("consultar el repositorio", async () => toRepo((await octokit.rest.repos.get({ owner, repo: name })).data)),

    async createRepositoryFromTemplate(name, description) {
      try {
        const { data } = await octokit.rest.repos.createUsingTemplate({
          template_owner: config.templateOwner,
          template_repo: config.templateRepo,
          owner,
          name,
          description,
          private: true,
          include_all_branches: false
        });
        return toRepo(data);
      } catch (error) {
        if (statusOf(error) === 422) throw new GithubRepoExistsError(`${owner}/${name}`);
        return classifyGithubError(error, "crear el repositorio desde la plantilla");
      }
    },

    readFile: (repo, path) => readContent(owner, repo, path),

    environmentExists: async (repo, environment) =>
      (await find("consultar el entorno", () => octokit.rest.repos.getEnvironment({ owner, repo, environment_name: environment }))) !== null,

    createEnvironment: (repo, environment) =>
      call("crear el entorno", async () => {
        await octokit.rest.repos.createOrUpdateEnvironment({ owner, repo, environment_name: environment });
      }),

    listEnvironmentSecretNames: (repo, environment) =>
      call("listar los secrets del entorno", async () => {
        const secrets = await octokit.paginate(octokit.rest.actions.listEnvironmentSecrets, {
          owner,
          repo,
          environment_name: environment,
          per_page: 100
        });
        return secrets.map((secret) => secret.name);
      }),

    putEnvironmentSecret: (repo, environment, name, value) =>
      call(`escribir el secret ${name}`, async () => {
        registerSecret(value);
        const { data: key } = await octokit.rest.actions.getEnvironmentPublicKey({ owner, repo, environment_name: environment });
        await octokit.rest.actions.createOrUpdateEnvironmentSecret({
          owner,
          repo,
          environment_name: environment,
          secret_name: name,
          key_id: key.key_id,
          encrypted_value: await sealForGithub(key.key, value)
        });
      }),

    async deleteEnvironmentSecret(repo, environment, name) {
      try {
        await octokit.rest.actions.deleteEnvironmentSecret({ owner, repo, environment_name: environment, secret_name: name });
        return true;
      } catch (error) {
        if (statusOf(error) === 404) return false;
        return classifyGithubError(error, `borrar el secret ${name}`);
      }
    },

    getEnvironmentVariable: (repo, environment, name) =>
      find(`leer la variable ${name}`, async () =>
        (await octokit.rest.actions.getEnvironmentVariable({ owner, repo, environment_name: environment, name })).data.value
      ),

    async setEnvironmentVariable(repo, environment, name, value) {
      const current = await this.getEnvironmentVariable(repo, environment, name);
      if (current === value) return;
      await call(`escribir la variable ${name}`, async () => {
        if (current === null) {
          await octokit.rest.actions.createEnvironmentVariable({ owner, repo, environment_name: environment, name, value });
        } else {
          await octokit.rest.actions.updateEnvironmentVariable({ owner, repo, environment_name: environment, name, value });
        }
      });
    },

    getWorkflow: (repo, file) =>
      find("consultar el workflow", async () => {
        const { data } = await octokit.rest.actions.getWorkflow({ owner, repo, workflow_id: file });
        return { id: data.id, state: data.state };
      }),

    dispatchWorkflow: (repo, file, ref) =>
      call("lanzar el workflow", async () => {
        await octokit.rest.actions.createWorkflowDispatch({ owner, repo, workflow_id: file, ref });
      }),

    listDispatchRuns: (repo, file, ref) =>
      call("listar las ejecuciones del workflow", async () => {
        const { data } = await octokit.rest.actions.listWorkflowRuns({
          owner,
          repo,
          workflow_id: file,
          branch: ref,
          event: "workflow_dispatch",
          per_page: 20
        });
        return data.workflow_runs.map(toRun);
      }),

    getRun: (repo, runId) =>
      call("consultar la ejecución del workflow", async () =>
        toRun((await octokit.rest.actions.getWorkflowRun({ owner, repo, run_id: runId })).data)
      ),

    async deleteRepository(name) {
      try {
        await octokit.rest.repos.delete({ owner, repo: name });
        return true;
      } catch (error) {
        if (statusOf(error) === 404) return false;
        return classifyGithubError(error, "borrar el repositorio");
      }
    },

    async deleteContainerPackage(name) {
      try {
        // El owner puede ser una organización o una cuenta personal: se prueba en ese orden.
        try {
          await octokit.rest.packages.deletePackageForOrg({ org: owner, package_type: "container", package_name: name });
        } catch (error) {
          if (statusOf(error) !== 404) throw error;
          await octokit.rest.packages.deletePackageForUser({ username: owner, package_type: "container", package_name: name });
        }
        return "deleted";
      } catch (error) {
        const status = statusOf(error);
        if (status === 404) return "not_found";
        if (status === 401 || status === 403) return "forbidden";
        return classifyGithubError(error, "borrar la imagen del contenedor");
      }
    },

    getRunFailure: (repo, runId) =>
      call("consultar los jobs del workflow", async () => {
        const { data } = await octokit.rest.actions.listJobsForWorkflowRun({ owner, repo, run_id: runId, filter: "latest" });
        const job = data.jobs.find((j) => j.conclusion === "failure");
        if (!job) return null;
        const step = job.steps?.find((st) => st.conclusion === "failure");
        return step ? `${job.name} › ${step.name}` : job.name;
      }),

    getInstallationPermissions: () =>
      call("consultar los permisos de la GitHub App", async () => {
        const { data } = await octokit.rest.apps.getInstallation({ installation_id: config.installationId });
        const permissions: Record<string, string> = {};
        for (const [name, level] of Object.entries(data.permissions ?? {})) if (typeof level === "string") permissions[name] = level;
        return permissions;
      }),

    async createRepoToken(repo, access = "write") {
      try {
        const auth = (await octokit.auth({
          type: "installation",
          repositoryNames: [repo],
          permissions: { contents: access, metadata: "read" },
          refresh: true
        })) as { token: string };
        registerSecret(auth.token);
        return auth.token;
      } catch (error) {
        // Si la App no tiene el permiso pedido, GitHub responde 422 al emitir el token.
        if (statusOf(error) === 422) return classifyGithubError(Object.assign(new Error(), { status: 403 }), "dar acceso al agente al repositorio", AI_PERMISSIONS.contents);
        return classifyGithubError(error, "dar acceso al agente al repositorio", AI_PERMISSIONS.contents);
      }
    },

    getBranchSha: (repo, branch) =>
      find("consultar la rama", async () => (await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` })).data.object.sha),

    createBranch: (repo, branch, sha) =>
      call(
        "crear la rama",
        async () => {
          await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha });
        },
        AI_PERMISSIONS.contents
      ),

    async deleteBranch(repo, branch) {
      try {
        await octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${branch}` });
        return true;
      } catch (error) {
        if (statusOf(error) === 404 || statusOf(error) === 422) return false;
        return classifyGithubError(error, "borrar la rama", AI_PERMISSIONS.contents);
      }
    },

    compareBranches: (repo, base, head) =>
      call("comparar la rama con main", async () => {
        const { data } = await octokit.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${base}...${head}`, per_page: 100 });
        return {
          aheadBy: data.ahead_by,
          behindBy: data.behind_by,
          url: data.html_url,
          commits: data.commits.map((c) => ({
            sha: c.sha,
            message: c.commit.message,
            author: c.commit.author?.name ?? null,
            date: c.commit.author?.date ?? null
          })),
          files: (data.files ?? []).map((f) => ({
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            patch: f.patch ?? null
          }))
        };
      }),

    createPullRequest: (repo, input) =>
      call("crear el Pull Request", async () => toPull((await octokit.rest.pulls.create({ owner, repo, ...input })).data), AI_PERMISSIONS.pulls),

    getPullRequest: (repo, number) =>
      call("consultar el Pull Request", async () => toPull((await octokit.rest.pulls.get({ owner, repo, pull_number: number })).data), AI_PERMISSIONS.pulls),

    getChecks: (repo, sha) =>
      call("consultar las validaciones del CI", async () => {
        const runs = await octokit.paginate(octokit.rest.checks.listForRef, { owner, repo, ref: sha, per_page: 100 });
        const checks = runs.map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, url: r.html_url }));
        const okConclusions = new Set(["success", "skipped", "neutral"]);
        return {
          total: checks.length,
          pending: checks.filter((c) => c.status !== "completed").length,
          failed: checks.filter((c) => c.status === "completed" && !okConclusions.has(c.conclusion ?? "")).length,
          checks
        };
      }, AI_PERMISSIONS.checks),

    mergePullRequest: (repo, number, input) =>
      call("fusionar el Pull Request", async () => {
        const { data } = await octokit.rest.pulls.merge({
          owner,
          repo,
          pull_number: number,
          sha: input.sha,
          merge_method: "squash",
          commit_title: input.title
        });
        return data.sha;
      }, AI_PERMISSIONS.contents),

    countCommitsByAuthor: (repo, branch, email, since) =>
      call("consultar los commits", async () => {
        const { data } = await octokit.rest.repos.listCommits({ owner, repo, sha: branch, author: email, since: since.toISOString(), per_page: 100 });
        return data.length;
      }),

    setRepositoryTopics: (name, topics) =>
      call("cambiar las etiquetas del repositorio", async () => {
        await octokit.rest.repos.replaceAllTopics({ owner, repo: name, names: topics });
      }),

    listProjectRepos: () =>
      call("listar los repositorios", async () => {
        const repos = await octokit.paginate(octokit.rest.apps.listReposAccessibleToInstallation, { per_page: 100 });
        const target = owner.toLowerCase();
        const template = `${config.templateOwner}/${config.templateRepo}`.toLowerCase();

        return repos
          .filter((repo) => repo.owner.login.toLowerCase() === target)
          .filter((repo) => repo.full_name.toLowerCase() !== template && !repo.is_template)
          .filter((repo) => !EXCLUDED_REPO_PREFIXES.some((prefix) => repo.name.toLowerCase().startsWith(prefix)))
          .map((repo) => ({
            ...toRepo(repo),
            id: repo.id,
            description: repo.description,
            archived: repo.archived,
            language: repo.language ?? null,
            createdAt: repo.created_at ?? null,
            pushedAt: repo.pushed_at ?? null,
            topics: repo.topics ?? []
          }))
          .sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
      })
  };
}
