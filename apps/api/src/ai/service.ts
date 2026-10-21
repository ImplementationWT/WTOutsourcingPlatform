import { randomUUID } from "node:crypto";
import { AI_PERMISSIONS, type BranchComparison, type GithubAdapter } from "../adapters/github.js";
import type { ServerAdapter } from "../adapters/server.js";
import { deriveNames, parseSlug } from "../domain/naming.js";
import type { Logger, ProvisioningConfig } from "../jobs/types.js";
import { redactString, registerSecret } from "../lib/redact.js";
import type { AdminStore } from "../store/admin-store.js";
import type { AiPreviewState, AiSessionDoc, ClientDoc } from "../store/models.js";
import type { ServerTargets } from "../servers/directory.js";
import { appsDomainOf, serverFor } from "../servers/resolve.js";
import { AGENT_BRANCH, AGENT_GIT_EMAIL, REPO_MOUNT_PATH } from "./agent-definition.js";
import { type ChatEvent, toChatEvent } from "./events.js";
import type { PreviewPasses } from "./preview-pass.js";
import type { AiAgentAdapter, AiConfig, MessageAttachment } from "./types.js";

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
/** Una vista previa sin visitas se apaga a la hora. */
const PREVIEW_IDLE_MS = 60 * 60_000;
/** Arrancando sin tarea viva pasado este tiempo: la plataforma se reinició a mitad. */
const PREVIEW_STALE_MS = 20 * 60_000;
/** Tras un fallo al actualizar, no se reintenta el mismo commit hasta pasado este tiempo. */
const PREVIEW_UPDATE_RETRY_MS = 60_000;

export interface AiDeveloperDeps {
  store: AdminStore;
  github: GithubAdapter;
  agent: AiAgentAdapter;
  /** Servidor principal; los proyectos con servidor propio lo resuelven con `servers`. */
  server: ServerAdapter;
  servers?: ServerTargets;
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

  private permissionsCache?: { missing: string[]; until: number };

  /** Permisos de la GitHub App que le faltan al AI Developer (caché de 5 minutos). */
  async missingGithubPermissions() {
    const t = this.now().getTime();
    if (this.permissionsCache && this.permissionsCache.until > t) return this.permissionsCache.missing;
    const granted = await this.deps.github.getInstallationPermissions();
    const missing = [
      granted.contents !== "write" && AI_PERMISSIONS.contents,
      granted.pull_requests !== "write" && AI_PERMISSIONS.pulls,
      !granted.checks && AI_PERMISSIONS.checks
    ].filter((p): p is (typeof AI_PERMISSIONS)[keyof typeof AI_PERMISSIONS] => Boolean(p));
    // Se recuerda solo un rato: al conceder los permisos, el aviso desaparece sin reiniciar.
    this.permissionsCache = { missing, until: t + (missing.length ? 60_000 : 5 * 60_000) };
    return missing;
  }

  private names(client: Pick<ClientDoc, "_id" | "server"> | null, clientId: string) {
    return deriveNames(parseSlug(clientId), {
      targetOwner: this.deps.github.owner,
      appsDomain: appsDomainOf(client, this.deps.provisioning)
    });
  }

  /** Servidor del proyecto de la sesión (vistas previas). */
  private async serverOf(clientId: string) {
    const client = await this.deps.store.getClient(clientId);
    const target = await serverFor({ config: this.deps.provisioning, server: this.deps.server, servers: this.deps.servers }, client);
    return { client, target };
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

  async start(input: { clientId: string; title: string; message?: string; attachments?: readonly MessageAttachment[]; actor: string }) {
    const { store, github, agent, config } = this.deps;
    const client = await store.getClient(input.clientId);
    if (!client) throw new AiDeveloperError(404, "Cliente no encontrado.");
    if (client.status !== "ready") throw new AiDeveloperError(409, "El proyecto debe estar listo (aprovisionado) para usar el AI Developer.");
    if (await store.aiSessions.findOne({ clientId: client._id, status: "active" })) {
      throw new AiDeveloperError(409, "Ya hay una sesión activa para este proyecto. Ciérrala o fusiónala antes de abrir otra.");
    }

    const missing = await this.missingGithubPermissions().catch(() => []);
    if (missing.length) {
      throw new AiDeveloperError(409, `A la GitHub App le faltan permisos para el AI Developer: ${missing.join(", ")}. Ver docs/ai-developer.md.`);
    }

    const names = this.names(client, client._id);
    const baseSha = await github.getBranchSha(names.repository, "main");
    if (!baseSha) throw new AiDeveloperError(409, `${names.repositoryFullName} no tiene rama main.`);

    const id = randomUUID();
    const now = this.now();
    const branch = AGENT_BRANCH;
    // Restos de una sesión cerrada sin publicar: sin cambios se borra; con cambios se archiva
    // con otro nombre (no se pierde) y la sesión nueva empieza limpia desde main.
    if (await github.getBranchSha(names.repository, branch)) {
      const previous = await github.compareBranches(names.repository, "main", branch);
      if (previous.aheadBy > 0) {
        const archive = `${branch}-archivo-${now.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-")}`;
        await github.renameBranch(names.repository, branch, archive);
        await store.audit({ actor: input.actor, action: "ai.branch_archived", clientId: client._id, target: branch, details: { archive } });
      } else {
        await github.deleteBranch(names.repository, branch);
      }
    }
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

    if (input.message || input.attachments?.length) await this.send(doc, input.message ?? "", input.actor, input.attachments);
    return doc;
  }

  /** Contexto de la sesión para el agente; acompaña al primer mensaje. */
  private async sessionContext(session: AiSessionDoc) {
    const client = await this.deps.store.getClient(session.clientId);
    const names = this.names(client, session.clientId);
    return [
      "Contexto de esta sesión:",
      `- Cliente: ${client?.name ?? session.clientId} (${session.clientId}). App en producción: ${names.baseUrl}`,
      `- Repositorio: ${names.repositoryFullName}, montado en ${REPO_MOUNT_PATH}.`,
      `- Rama de trabajo: ${session.branch} (creada desde main en ${session.baseSha.slice(0, 7)}). Haz commit y push solo a esta rama.`,
      `- Te escribe ${session.createdBy}, administrador de la plataforma. Los cambios se revisan en una vista previa y como Pull Request antes de desplegarse.`
    ].join("\n");
  }

  async send(session: AiSessionDoc, text: string, actor: string, attachments: readonly MessageAttachment[] = []) {
    this.requireActive(session);
    const { agent, store } = this.deps;
    await agent.rotateRepoToken(session.agentSessionId, session.repoResourceId, await this.freshRepoToken(session.repository));
    const context = session.contextSent ? undefined : await this.sessionContext(session);
    // Solo adjuntos: el mensaje lo dice para que Claude sepa qué se espera.
    const message = text || "Te adjunto estos archivos Markdown.";
    await agent.sendMessage(session.agentSessionId, message, context, attachments);
    session.contextSent = true;
    const now = this.now();
    await store.aiSessions.updateOne({ _id: session._id }, { $set: { lastMessageAt: now, updatedAt: now, contextSent: true } });
    await this.audit(actor, "ai.message_sent", session, {
      length: text.length,
      ...(attachments.length ? { attachments: attachments.map((file) => file.name).join(", ").slice(0, 500) } : {})
    });
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
    const names = this.names(null, session.clientId);
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
   * Cambia campos de la vista previa solo si sigue siendo la misma (mismo requestedAt): una
   * tarea que termina tarde no resucita una vista previa parada o relanzada.
   */
  private async patchPreview(session: AiSessionDoc, requestedAt: Date, fields: Partial<AiPreviewState>) {
    const set: Record<string, unknown> = { updatedAt: this.now() };
    const unset: Record<string, ""> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) unset[`preview.${key}`] = "";
      else set[`preview.${key}`] = value;
    }
    const result = await this.deps.store.aiSessions.updateOne(
      { _id: session._id, "preview.requestedAt": requestedAt },
      { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) }
    );
    if (result.matchedCount && session.preview?.requestedAt.getTime() === requestedAt.getTime()) Object.assign(session.preview, fields);
    return result.matchedCount > 0;
  }

  /** Arranque y actualizaciones de la vista previa: en segundo plano, una a la vez por sesión. */
  private readonly previewTasks = new Map<string, Promise<void>>();

  private runPreviewTask(sessionId: string, task: () => Promise<void>) {
    if (this.previewTasks.has(sessionId)) return;
    const promise = task()
      .catch((error) => this.deps.log.warn({ err: error, session: sessionId }, "preview task failed"))
      .finally(() => this.previewTasks.delete(sessionId));
    this.previewTasks.set(sessionId, promise);
  }

  /** Espera a las tareas de vista previa en curso (tests). */
  async previewIdle() {
    while (this.previewTasks.size) await Promise.all([...this.previewTasks.values()]);
  }

  /** Token de solo lectura del repo (caduca en 1 h) para que el servidor clone o actualice la rama. */
  private async readToken(repository: string) {
    const token = await this.deps.github.createRepoToken(repository, "read");
    registerSecret(token);
    return token;
  }

  /**
   * Vista previa en vivo: el servidor del proyecto clona la rama y la arranca en modo
   * desarrollo (pnpm dev:preview) en preview-<slug>.<dominio>, con una base vacía propia.
   * Responde enseguida; el arranque sigue en segundo plano (installing → building → ready).
   */
  async startPreview(session: AiSessionDoc, actor: string) {
    this.requireActive(session);
    const { client, target } = this.deps.provisioning.deployEnabled ? await this.serverOf(session.clientId) : { client: null, target: undefined };
    if (!target) {
      throw new AiDeveloperError(409, "La vista previa necesita el despliegue en el VPS habilitado (DEPLOY_ENABLED) y el servidor del proyecto.");
    }
    if (session.preview && ["installing", "building"].includes(session.preview.status)) return this.previewView(session);

    const names = this.names(client, session.clientId);
    const requestedAt = this.now();
    await this.setPreview(session, {
      status: "installing",
      mode: "live",
      host: `preview-${names.slug}.${target.appsDomain}`,
      sha: null,
      requestedAt,
      requestedBy: actor
    });
    await this.audit(actor, "ai.preview_started", session);

    this.runPreviewTask(session._id, async () => {
      try {
        const installed = await target.adapter.installPreview(names.slug);
        if (!(await this.patchPreview(session, requestedAt, { host: installed.host, status: "building" }))) return;
        const token = await this.readToken(session.repository);
        const { sha } = await target.adapter.startLivePreview(names.slug, { repository: names.repositoryFullName, branch: session.branch, token });
        const now = this.now();
        if (await this.patchPreview(session, requestedAt, { status: "ready", sha, readyAt: now, expiresAt: new Date(now.getTime() + PREVIEW_IDLE_MS) })) {
          await this.audit(actor, "ai.preview_ready", session, { sha });
        }
      } catch (error) {
        await this.patchPreview(session, requestedAt, {
          status: "failed",
          error: redactString(error instanceof Error ? error.message : "No se pudo iniciar la vista previa.")
        });
      }
    });
    return this.previewView(session);
  }

  /** Trae el último commit de la rama a la vista en vivo (Vite y tsx lo aplican en caliente). */
  private updatePreview(session: AiSessionDoc, head: string) {
    const requestedAt = session.preview!.requestedAt;
    this.runPreviewTask(session._id, async () => {
      if (!(await this.patchPreview(session, requestedAt, { updating: true, updateError: undefined }))) return;
      try {
        const { target } = await this.serverOf(session.clientId);
        if (!target) throw new Error("El servidor del proyecto no está disponible.");
        const token = await this.readToken(session.repository);
        const { sha, reinstalled } = await target.adapter.updateLivePreview(parseSlug(session.clientId), { branch: session.branch, token });
        await this.patchPreview(session, requestedAt, { sha, updating: false, updatedAt: this.now() });
        await this.audit("sistema", "ai.preview_updated", session, { sha, reinstalled });
      } catch (error) {
        await this.patchPreview(session, requestedAt, {
          updating: false,
          updateError: redactString(error instanceof Error ? error.message : "No se pudieron traer los cambios."),
          updateFailedSha: head,
          updateFailedAt: this.now()
        });
      }
    });
  }

  /**
   * Estado de la vista previa (el panel lo consulta cada pocos segundos). Arranca sola al
   * abrir la conversación (o al volver tras apagarse por inactividad), con la rama tal como
   * esté, y se actualiza sola con cada commit nuevo.
   */
  async previewState(session: AiSessionDoc) {
    const preview = session.preview;
    const head = await this.deps.github.getBranchSha(session.repository, session.branch).catch(() => null);
    const now = this.now();

    if (!preview || (preview.status === "stopped" && preview.stopReason === "expired")) {
      if (session.status === "active" && this.deps.provisioning.deployEnabled) {
        try {
          return await this.startPreview(session, "sistema");
        } catch (error) {
          this.deps.log.warn({ err: error, session: session._id }, "preview auto-start failed");
        }
      }
      return preview ? this.previewView(session, head) : null;
    }

    const starting = preview.status === "installing" || preview.status === "building";
    if (starting && !this.previewTasks.has(session._id) && now.getTime() - preview.requestedAt.getTime() > PREVIEW_STALE_MS) {
      await this.patchPreview(session, preview.requestedAt, { status: "failed", error: "El arranque se interrumpió (la plataforma se reinició). Vuelve a intentarlo." });
    } else if (preview.status === "ready") {
      if (preview.expiresAt && preview.expiresAt <= now) {
        await this.stopPreview(session, "sistema", "expired");
      } else if (head && preview.sha && head !== preview.sha && !this.previewTasks.has(session._id)) {
        const recentFailure =
          preview.updateFailedSha === head && preview.updateFailedAt && now.getTime() - preview.updateFailedAt.getTime() < PREVIEW_UPDATE_RETRY_MS;
        if (!recentFailure) this.updatePreview(session, head);
      }
    }
    return this.previewView(session, head);
  }

  private async previewView(session: AiSessionDoc, head?: string | null) {
    const preview = session.preview!;
    const ready = preview.status === "ready";
    return {
      status: preview.status,
      url: `https://${preview.host}`,
      frameUrl: ready ? `https://${preview.host}/__launchpad/auth?t=${encodeURIComponent(this.deps.passes.issuePass(preview.host, session._id))}` : null,
      sha: preview.sha,
      /** Trayendo los últimos cambios de Claude (se aplican en caliente). */
      updating: Boolean(preview.updating),
      /** La rama tiene commits que la vista previa aún no muestra. */
      outdated: Boolean(ready && head && preview.sha && head !== preview.sha),
      updateError: preview.updateError ?? null,
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
      try {
        const { target } = await this.serverOf(session.clientId);
        await target?.adapter.stopPreview(parseSlug(session.clientId));
      } catch (error) {
        this.deps.log.warn({ err: error, session: session._id }, "preview-stop failed");
      }
    }
    await this.setPreview(session, { ...preview, status: "stopped", stoppedAt: this.now(), stopReason: reason, updating: false });
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
