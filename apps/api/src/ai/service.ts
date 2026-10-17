import { randomUUID } from "node:crypto";
import type { BranchComparison, GithubAdapter } from "../adapters/github.js";
import type { ServerAdapter } from "../adapters/server.js";
import { deriveNames, parseSlug } from "../domain/naming.js";
import type { Logger, ProvisioningConfig } from "../jobs/types.js";
import { redactString, registerSecret } from "../lib/redact.js";
import type { AdminStore } from "../store/admin-store.js";
import type { AiPreviewState, AiSessionDoc } from "../store/models.js";
import { AGENT_GIT_EMAIL, REPO_MOUNT_PATH } from "./agent-definition.js";
import { type ChatEvent, toChatEvent } from "./events.js";
import type { PreviewPasses } from "./preview-pass.js";
import type { AiAgentAdapter, AiConfig } from "./types.js";

/** Error con el código HTTP y un mensaje para el panel. */
export class AiDeveloperError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const MAX_PATCH_CHARS = 60_000;
const MAX_DIFF_FILES = 150;
export const PREVIEW_WORKFLOW = "preview.yml";
/** Una vista previa sin visitas se apaga a la hora. */
const PREVIEW_IDLE_MS = 60 * 60_000;
/** Si GitHub no muestra el run en este tiempo, se da por fallido. */
const PREVIEW_RUN_APPEAR_MS = 3 * 60_000;
const CLOCK_SKEW_MS = 60_000;

export interface AiDeveloperDeps {
  store: AdminStore;
  github: GithubAdapter;
  agent: AiAgentAdapter;
  server: ServerAdapter;
  passes: PreviewPasses;
  config: AiConfig;
  provisioning: ProvisioningConfig;
  log: Logger;
  now?: () => Date;
}

/**
 * AI Developer: Claude trabaja en una rama del repo del cliente dentro de un
 * sandbox de Anthropic; la plataforma crea la rama, renueva el token del repo,
 * retransmite el chat, abre el Pull Request y lo fusiona cuando pasa las
 * validaciones (el push a main dispara el despliegue del template).
 */
export class AiDeveloper {
  private readonly now: () => Date;
  /** Caché corta de auth_request (nginx consulta en cada petición de la vista previa). */
  private readonly authCache = new Map<string, { ok: boolean; until: number }>();

  constructor(private readonly deps: AiDeveloperDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private names(clientId: string) {
    return deriveNames(parseSlug(clientId), { targetOwner: this.deps.github.owner, appsDomain: this.deps.provisioning.appsDomain });
  }

  consoleUrl(session: AiSessionDoc) {
    return `https://platform.claude.com/workspaces/${encodeURIComponent(this.deps.config.workspace)}/sessions/${session.agentSessionId}`;
  }

  private async audit(actor: string, action: string, session: AiSessionDoc, details?: Record<string, string | number | boolean>) {
    await this.deps.store.audit({ actor, action, clientId: session.clientId, target: session.branch, details: { session: session._id, ...details } });
  }

  private requireActive(session: AiSessionDoc) {
    if (session.status !== "active") throw new AiDeveloperError(409, "La sesión está cerrada.");
  }

  /** Token nuevo del repo (caducan en 1 h), solo con Contents sobre ese repo. */
  private async freshRepoToken(repository: string) {
    const token = await this.deps.github.createRepoToken(repository);
    registerSecret(token);
    return token;
  }

  async start(input: { clientId: string; title: string; message?: string; actor: string }) {
    const { store, github, agent, config } = this.deps;
    const client = await store.getClient(input.clientId);
    if (!client) throw new AiDeveloperError(404, "Cliente no encontrado.");
    if (client.status !== "ready") throw new AiDeveloperError(409, "El proyecto debe estar listo (aprovisionado) para usar el AI Developer.");
    if (await store.aiSessions.findOne({ clientId: client._id, status: "active" })) {
      throw new AiDeveloperError(409, "Ya hay una sesión activa para este proyecto. Ciérrala o fusiónala antes de abrir otra.");
    }

    const names = this.names(client._id);
    const baseSha = await github.getBranchSha(names.repository, "main");
    if (!baseSha) throw new AiDeveloperError(409, `${names.repositoryFullName} no tiene rama main.`);

    const id = randomUUID();
    const now = this.now();
    const branch = `ai/${now.toISOString().slice(0, 10).replace(/-/g, "")}-${id.slice(0, 8)}`;
    await github.createBranch(names.repository, branch, baseSha);

    let agentSession: { id: string; repoResourceId: string };
    try {
      agentSession = await agent.createSession({
        title: `${client.name}: ${input.title}`.slice(0, 200),
        repoUrl: `https://github.com/${names.repositoryFullName}`,
        branch,
        mountPath: REPO_MOUNT_PATH,
        repoToken: await this.freshRepoToken(names.repository),
        budgetCents: config.sessionBudgetCents,
        metadata: { clientId: client._id, platformSessionId: id, branch }
      });
    } catch (error) {
      // Sin sesión no se usa la rama recién creada.
      await github.deleteBranch(names.repository, branch).catch(() => undefined);
      throw error;
    }

    const doc: AiSessionDoc = {
      _id: id,
      clientId: client._id,
      title: input.title,
      status: "active",
      agentSessionId: agentSession.id,
      repoResourceId: agentSession.repoResourceId,
      repository: names.repository,
      branch,
      baseBranch: "main",
      baseSha,
      createdBy: input.actor,
      createdAt: now,
      updatedAt: now
    };
    await store.aiSessions.insertOne(doc);
    await this.audit(input.actor, "ai.session_started", doc, { agentSession: agentSession.id });

    await agent.sendSystemMessage(
      agentSession.id,
      [
        "Contexto de esta sesión:",
        `- Cliente: ${client.name} (${client._id}). App en producción: ${names.baseUrl}`,
        `- Repositorio: ${names.repositoryFullName}, montado en ${REPO_MOUNT_PATH}.`,
        `- Rama de trabajo: ${branch} (creada desde main en ${baseSha.slice(0, 7)}). Haz commit y push solo a esta rama.`,
        `- Te escribe ${input.actor}, administrador de la plataforma. Los cambios se revisan en una vista previa y como Pull Request antes de desplegarse.`
      ].join("\n")
    );
    if (input.message) await this.send(doc, input.message, input.actor);
    return doc;
  }

  async send(session: AiSessionDoc, text: string, actor: string) {
    this.requireActive(session);
    const { agent, store } = this.deps;
    await agent.rotateRepoToken(session.agentSessionId, session.repoResourceId, await this.freshRepoToken(session.repository));
    await agent.sendMessage(session.agentSessionId, text);
    const now = this.now();
    await store.aiSessions.updateOne({ _id: session._id }, { $set: { lastMessageAt: now, updatedAt: now } });
    await this.audit(actor, "ai.message_sent", session, { length: text.length });
  }

  async confirm(session: AiSessionDoc, toolUseId: string, allow: boolean, actor: string) {
    this.requireActive(session);
    await this.deps.agent.confirmTool(
      session.agentSessionId,
      toolUseId,
      allow,
      allow ? undefined : `${actor} no aprobó este paso desde el panel. Busca otra forma o pregunta.`
    );
    await this.audit(actor, allow ? "ai.tool_allowed" : "ai.tool_denied", session, { toolUse: toolUseId });
  }

  async interrupt(session: AiSessionDoc, actor: string) {
    this.requireActive(session);
    await this.deps.agent.interrupt(session.agentSessionId);
    await this.audit(actor, "ai.interrupted", session);
  }

  /** Estado del agente y gasto (precio de lista) de la sesión. */
  async usage(session: AiSessionDoc) {
    return this.deps.agent.getSession(session.agentSessionId);
  }

  /** Amplía el tope de gasto en un tramo más (reanuda una sesión pausada por presupuesto). */
  async raiseBudget(session: AiSessionDoc, actor: string) {
    this.requireActive(session);
    const current = await this.deps.agent.getSession(session.agentSessionId);
    const budgetCents = Math.max(current.budgetCents ?? 0, current.costCents) + this.deps.config.sessionBudgetCents;
    await this.deps.agent.setBudget(session.agentSessionId, budgetCents);
    await this.audit(actor, "ai.budget_raised", session, { budgetCents });
    return { budgetCents };
  }

  /** Historial + eventos en vivo, sin duplicados (el stream no repite lo emitido antes de abrirse). */
  async *events(session: AiSessionDoc, signal: AbortSignal): AsyncGenerator<ChatEvent> {
    const { agent } = this.deps;
    const live = agent.streamEvents(session.agentSessionId, signal)[Symbol.asyncIterator]();
    // Se abre el stream antes de leer el historial para no perder nada entre medias.
    let pending = live.next();
    const seen = new Set<string>();
    for await (const event of agent.listEvents(session.agentSessionId)) {
      if (signal.aborted) return;
      seen.add(event.id);
      const chat = toChatEvent(event);
      if (chat) yield chat;
    }
    while (!signal.aborted) {
      const result = await pending;
      if (result.done) return;
      pending = live.next();
      if (seen.has(result.value.id)) continue;
      seen.add(result.value.id);
      const chat = toChatEvent(result.value);
      if (chat) yield chat;
    }
  }

  /** Cambios de la rama respecto a main, con los parches redactados y recortados. */
  async diff(session: AiSessionDoc): Promise<BranchComparison & { truncated: boolean }> {
    const comparison = await this.deps.github.compareBranches(session.repository, session.baseBranch, session.branch);
    let budget = MAX_PATCH_CHARS * 4;
    const files = comparison.files.slice(0, MAX_DIFF_FILES).map((file) => {
      let patch = file.patch === null ? null : redactString(file.patch);
      if (patch && (patch.length > MAX_PATCH_CHARS || patch.length > budget)) patch = null;
      if (patch) budget -= patch.length;
      return { ...file, patch };
    });
    return {
      ...comparison,
      commits: comparison.commits.map((c) => ({ ...c, message: redactString(c.message) })),
      files,
      truncated: comparison.files.length > MAX_DIFF_FILES || files.some((f, i) => f.patch === null && comparison.files[i].patch !== null)
    };
  }

  async createPullRequest(session: AiSessionDoc, actor: string) {
    this.requireActive(session);
    if (session.pullRequest) return session.pullRequest;
    const { github, store } = this.deps;
    const comparison = await github.compareBranches(session.repository, session.baseBranch, session.branch);
    if (comparison.aheadBy === 0) throw new AiDeveloperError(409, "Claude aún no ha subido cambios a la rama.");

    const commits = comparison.commits.map((c) => `- ${redactString(c.message.split("\n")[0])}`).join("\n");
    const pr = await github.createPullRequest(session.repository, {
      head: session.branch,
      base: session.baseBranch,
      title: session.title.slice(0, 200),
      body: `${commits}\n\n---\nCambios hechos con el AI Developer de Launchpad a petición de ${session.createdBy}; PR abierto por ${actor}. Al fusionarlo se despliega a producción.`
    });
    const pullRequest = { number: pr.number, url: pr.url, createdAt: this.now(), createdBy: actor };
    await store.aiSessions.updateOne({ _id: session._id }, { $set: { pullRequest, updatedAt: this.now() } });
    await this.audit(actor, "ai.pull_request_created", session, { number: pr.number });
    return pullRequest;
  }

  /** Estado del PR y de sus validaciones; avisa si el agente tocó main. */
  async review(session: AiSessionDoc) {
    const { github } = this.deps;
    const mainTouched = (await github.countCommitsByAuthor(session.repository, session.baseBranch, AGENT_GIT_EMAIL, session.createdAt)) > 0;
    if (!session.pullRequest) return { pullRequest: null, checks: null, mainTouched };
    const pr = await github.getPullRequest(session.repository, session.pullRequest.number);
    const checks = await github.getChecks(session.repository, pr.headSha);
    return { pullRequest: pr, checks, mainTouched };
  }

  /** Fusiona el PR si está abierto, sin conflictos y con todas las validaciones en verde. */
  async merge(session: AiSessionDoc, actor: string) {
    this.requireActive(session);
    if (!session.pullRequest) throw new AiDeveloperError(409, "Primero crea el Pull Request.");
    const { github, store, agent, provisioning } = this.deps;
    const pr = await github.getPullRequest(session.repository, session.pullRequest.number);
    if (pr.merged || pr.state !== "open") throw new AiDeveloperError(409, "El Pull Request ya no está abierto.");
    if (pr.mergeable === false) throw new AiDeveloperError(409, "El Pull Request tiene conflictos con main. Pide a Claude que los resuelva.");

    const checks = await github.getChecks(session.repository, pr.headSha);
    if (checks.total === 0) throw new AiDeveloperError(409, "Las validaciones (CI) aún no han empezado. Espera unos segundos.");
    if (checks.pending > 0) throw new AiDeveloperError(409, "Las validaciones aún se están ejecutando.");
    if (checks.failed > 0) throw new AiDeveloperError(409, "Hay validaciones fallidas: no se puede fusionar. Pide a Claude que las corrija.");

    const sha = await github.mergePullRequest(session.repository, pr.number, { sha: pr.headSha, title: `${session.title} (#${pr.number})` });
    await this.stopPreview(session, actor, "merged").catch(() => undefined);
    const merge = { sha, at: this.now(), by: actor };
    await store.aiSessions.updateOne({ _id: session._id }, { $set: { status: "merged", merge, updatedAt: this.now() } });
    await this.audit(actor, "ai.merged", session, { number: pr.number, sha });
    // La sesión del agente ya no hace falta (best effort: se queda en idle).
    await agent.interrupt(session.agentSessionId).catch(() => undefined);
    await github.deleteBranch(session.repository, session.branch).catch(() => undefined);
    const names = this.names(session.clientId);
    return {
      sha,
      deploying: provisioning.deployEnabled,
      actionsUrl: `https://github.com/${names.repositoryFullName}/actions`
    };
  }

  /** Cierra sin fusionar. La rama se borra solo si no tiene PR ni commits. */
  async close(session: AiSessionDoc, actor: string) {
    this.requireActive(session);
    const { agent, github, store } = this.deps;
    await agent.interrupt(session.agentSessionId).catch(() => undefined);
    await this.stopPreview(session, actor, "closed").catch(() => undefined);
    if (!session.pullRequest) {
      const comparison = await github.compareBranches(session.repository, session.baseBranch, session.branch).catch(() => null);
      if (comparison?.aheadBy === 0) await github.deleteBranch(session.repository, session.branch).catch(() => undefined);
    }
    await store.aiSessions.updateOne({ _id: session._id }, { $set: { status: "closed", closedAt: this.now(), closedBy: actor, updatedAt: this.now() } });
    await this.audit(actor, "ai.session_closed", session);
  }

  // ---- vista previa -------------------------------------------------------------

  private async setPreview(session: AiSessionDoc, preview: AiPreviewState) {
    session.preview = preview;
    await this.deps.store.aiSessions.updateOne({ _id: session._id }, { $set: { preview, updatedAt: this.now() } });
  }

  /**
   * Construye la rama en GitHub Actions (workflow preview.yml del repo) y la
   * levanta en preview-<slug>.<dominio> con una base vacía propia.
   */
  async startPreview(session: AiSessionDoc, actor: string) {
    this.requireActive(session);
    const { github, server, provisioning } = this.deps;
    if (!provisioning.deployEnabled || !provisioning.server) {
      throw new AiDeveloperError(409, "La vista previa necesita el despliegue en el VPS habilitado (DEPLOY_ENABLED).");
    }
    if (session.preview && ["installing", "building"].includes(session.preview.status)) return this.previewView(session);
    if (!(await github.getWorkflow(session.repository, PREVIEW_WORKFLOW))) {
      throw new AiDeveloperError(
        409,
        `El repositorio no tiene el workflow de vista previa (.github/workflows/${PREVIEW_WORKFLOW}). Llega con la plantilla 1.5.0; en repos anteriores hay que añadirlo.`
      );
    }

    const names = this.names(session.clientId);
    const base = { host: `preview-${names.slug}.${provisioning.appsDomain}`, sha: null, requestedAt: this.now(), requestedBy: actor };
    await this.setPreview(session, { ...base, status: "installing" });
    try {
      const installed = await server.installPreview(names.slug);
      const sha = await github.getBranchSha(session.repository, session.branch);
      await github.dispatchWorkflow(session.repository, PREVIEW_WORKFLOW, session.branch);
      await this.setPreview(session, { ...base, host: installed.host, sha, status: "building" });
    } catch (error) {
      await this.setPreview(session, { ...base, status: "failed", error: redactString(error instanceof Error ? error.message : "No se pudo iniciar la vista previa.") });
      throw error;
    }
    await this.audit(actor, "ai.preview_started", session, { sha: session.preview?.sha ?? "" });
    return this.previewView(session);
  }

  /** Avanza el estado (run de GitHub, caducidad) y devuelve la vista pública. */
  async previewState(session: AiSessionDoc) {
    const preview = session.preview;
    if (!preview) return null;
    const { github } = this.deps;

    if (preview.status === "building") {
      const runs = await github.listDispatchRuns(session.repository, PREVIEW_WORKFLOW, session.branch);
      const run = runs.find((r) => new Date(r.createdAt).getTime() >= preview.requestedAt.getTime() - CLOCK_SKEW_MS);
      if (!run) {
        if (this.now().getTime() - preview.requestedAt.getTime() > PREVIEW_RUN_APPEAR_MS) {
          await this.setPreview(session, { ...preview, status: "failed", error: "GitHub no inició el workflow de vista previa." });
        }
      } else if (run.status !== "completed") {
        if (preview.runId !== run.id) await this.setPreview(session, { ...preview, runId: run.id, runUrl: run.url });
      } else if (run.conclusion === "success") {
        const now = this.now();
        await this.setPreview(session, { ...preview, runId: run.id, runUrl: run.url, status: "ready", readyAt: now, expiresAt: new Date(now.getTime() + PREVIEW_IDLE_MS) });
        await this.audit(preview.requestedBy, "ai.preview_ready", session, { sha: preview.sha ?? "" });
      } else {
        const step = await github.getRunFailure(session.repository, run.id).catch(() => null);
        await this.setPreview(session, {
          ...preview,
          runId: run.id,
          runUrl: run.url,
          status: "failed",
          error: step ? `Falló «${step}» en GitHub Actions.` : `El workflow terminó con «${run.conclusion ?? "error"}».`
        });
      }
    } else if (preview.status === "ready" && preview.expiresAt && preview.expiresAt <= this.now()) {
      await this.stopPreview(session, "sistema", "expired");
    }
    return this.previewView(session);
  }

  private async previewView(session: AiSessionDoc) {
    const preview = session.preview!;
    const ready = preview.status === "ready";
    // ¿La rama avanzó desde que se construyó? Entonces la vista previa está desactualizada.
    const head = ready ? await this.deps.github.getBranchSha(session.repository, session.branch).catch(() => null) : null;
    return {
      status: preview.status,
      url: `https://${preview.host}`,
      frameUrl: ready ? `https://${preview.host}/__launchpad/auth?t=${encodeURIComponent(this.deps.passes.issuePass(preview.host, session._id))}` : null,
      sha: preview.sha,
      outdated: Boolean(ready && head && preview.sha && head !== preview.sha),
      runUrl: preview.runUrl ?? null,
      requestedAt: preview.requestedAt,
      readyAt: preview.readyAt ?? null,
      expiresAt: preview.expiresAt ?? null,
      error: preview.error ?? null
    };
  }

  async stopPreview(session: AiSessionDoc, actor: string, reason: "manual" | "expired" | "merged" | "closed") {
    const preview = session.preview;
    if (!preview || preview.status === "stopped") return;
    if (preview.status !== "failed") {
      await this.deps.server.stopPreview(this.names(session.clientId).slug).catch((error) => {
        this.deps.log.warn({ err: error, session: session._id }, "preview-stop failed");
      });
    }
    await this.setPreview(session, { ...preview, status: "stopped", stoppedAt: this.now() });
    this.authCache.clear();
    await this.audit(actor, "ai.preview_stopped", session, { reason });
  }

  /** Apaga las vistas previas que nadie ha abierto en la última hora. */
  async sweepPreviews() {
    const expired = await this.deps.store.aiSessions.find({ "preview.status": "ready", "preview.expiresAt": { $lte: this.now() } }).toArray();
    for (const session of expired) await this.stopPreview(session, "sistema", "expired").catch(() => undefined);
    return expired.length;
  }

  private async sessionForPreview(sessionId: string, host: string) {
    const session = await this.deps.store.aiSessions.findOne({ _id: sessionId });
    return session?.status === "active" && session.preview?.status === "ready" && session.preview.host === host ? session : null;
  }

  /** Canjea el pase de la URL por la cookie de acceso (solo si la vista previa está activa). */
  async redeemPreviewPass(host: string, pass: string | undefined) {
    const redeemed = this.deps.passes.redeem(pass, host);
    if (!redeemed || !(await this.sessionForPreview(redeemed.sessionId, host))) return null;
    return redeemed;
  }

  /** auth_request de nginx: ¿la cookie da acceso a esta vista previa? Cada visita la mantiene encendida. */
  async authorizePreview(host: string, cookie: string | undefined) {
    const sessionId = this.deps.passes.check(cookie, host);
    if (!sessionId) return false;
    const key = `${host}|${sessionId}`;
    const cached = this.authCache.get(key);
    const t = this.now().getTime();
    if (cached && cached.until > t) return cached.ok;
    const session = await this.sessionForPreview(sessionId, host);
    this.authCache.set(key, { ok: Boolean(session), until: t + 30_000 });
    if (session?.preview) {
      const expiresAt = new Date(t + PREVIEW_IDLE_MS);
      await this.deps.store.aiSessions.updateOne({ _id: session._id }, { $set: { "preview.expiresAt": expiresAt } });
    }
    return Boolean(session);
  }
}
