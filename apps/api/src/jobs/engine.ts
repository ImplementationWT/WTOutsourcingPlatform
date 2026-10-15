import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { deriveNames, parseSlug } from "../domain/naming.js";
import { FatalError, ProvisioningError, TransientError } from "../lib/errors.js";
import { redact, redactString } from "../lib/redact.js";
import { withRetry } from "../lib/retry.js";
import type { AdminStore } from "../store/admin-store.js";
import type { JobDoc, StageName } from "../store/models.js";
import { deployStage } from "./stages/deploy.js";
import { githubRepositoryStage } from "./stages/github-repository.js";
import { githubSecretsStage } from "./stages/github-secrets.js";
import { healthCheckStage } from "./stages/health-check.js";
import { mongodbDatabaseStage } from "./stages/mongodb-database.js";
import type { Deps, JobMemory, Logger, Stage, StageContext } from "./types.js";

/** Orden fijo de las etapas (coincide con STAGES en models.ts). */
export const PIPELINE: Stage[] = [
  githubRepositoryStage,
  mongodbDatabaseStage,
  githubSecretsStage,
  deployStage,
  healthCheckStage
];

const DEPLOY_STAGES: StageName[] = ["deploy", "health_check"];

/** Etapas activas según la configuración (sin despliegue mientras esté deshabilitado). */
export function activePipeline(config: { deployEnabled: boolean }) {
  return PIPELINE.filter((stage) => config.deployEnabled || !DEPLOY_STAGES.includes(stage.name));
}

/** Vista pública del trabajo: sin lease ni campos internos, y redactada. */
export function toPublicJob(job: JobDoc) {
  return redact({
    id: job._id,
    clientId: job.clientId,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt ?? null,
    stages: job.stages.map((s) => ({
      name: s.name,
      label: s.label,
      status: s.status,
      attempts: s.attempts,
      startedAt: s.startedAt ?? null,
      finishedAt: s.finishedAt ?? null,
      durationMs: s.durationMs ?? null,
      detail: s.detail ?? null,
      steps: s.steps ?? [],
      error: s.error ?? null
    }))
  });
}

export type PublicJob = ReturnType<typeof toPublicJob>;

function describe(error: unknown) {
  if (error instanceof ProvisioningError) {
    return {
      code: error.code,
      message: redactString(error.message),
      retryable: !(error instanceof FatalError) || error.code.endsWith("_timeout")
    };
  }
  return { code: "internal_error", message: "Error interno del aprovisionador. Revisa los logs del servidor.", retryable: true };
}

export class JobEngine {
  private readonly events = new EventEmitter();
  private readonly running = new Map<string, Promise<unknown>>();
  readonly instanceId = randomUUID();

  constructor(
    private readonly store: AdminStore,
    private readonly deps: Deps,
    private readonly log: Logger,
    private readonly stages: Stage[] = activePipeline(deps.config)
  ) {
    this.events.setMaxListeners(100);
  }

  /** Nombres de las etapas que ejecuta esta instancia, en orden. */
  get stageNames(): StageName[] {
    return this.stages.map((s) => s.name);
  }

  subscribe(jobId: string, listener: (job: PublicJob) => void) {
    this.events.on(jobId, listener);
    return () => this.events.off(jobId, listener);
  }

  /** Lanza el trabajo en segundo plano (no espera). */
  start(jobId: string, actor: string) {
    const existing = this.running.get(jobId);
    if (existing) return existing;
    const promise = this.run(jobId, actor)
      .catch((error) => this.log.error({ err: error, jobId }, "Job runner crashed"))
      .finally(() => this.running.delete(jobId));
    this.running.set(jobId, promise);
    return promise;
  }

  /** Espera a que terminen los trabajos en curso de esta instancia (tests/apagado). */
  async idle() {
    await Promise.all([...this.running.values()]);
  }

  private emit(job: JobDoc | null) {
    if (job) this.events.emit(job._id, toPublicJob(job));
  }

  async run(jobId: string, actor: string): Promise<JobDoc | null> {
    const { store, deps, log } = this;
    const owner = `${this.instanceId}:${randomUUID()}`;

    const acquired = await store.acquireLease(jobId, owner, deps.timing.leaseTtlMs);
    if (!acquired) {
      log.info({ jobId }, "Job already running elsewhere or not active; skipping");
      return null;
    }
    this.emit(acquired);

    const heartbeat = setInterval(() => {
      store.renewLease(jobId, owner, deps.timing.leaseTtlMs).catch(() => undefined);
    }, Math.max(1_000, Math.floor(deps.timing.leaseTtlMs / 3)));
    heartbeat.unref();

    const memory: JobMemory = {};
    let job: JobDoc = acquired;

    try {
      const client = await store.getClient(job.clientId);
      if (!client) throw new FatalError("client_not_found", "El cliente del trabajo no existe.");
      await store.updateClient(client._id, { status: "provisioning" });

      // Los nombres se derivan siempre del slug validado guardado en la base.
      const names = deriveNames(parseSlug(client._id), {
        targetOwner: deps.github.owner,
        appsDomain: deps.config.appsDomain
      });

      for (let index = 0; index < job.stages.length; index++) {
        const state = job.stages[index];
        if (state.status === "succeeded") continue;
        const stage = this.stages.find((s) => s.name === state.name);
        if (!stage) throw new FatalError("unknown_stage", `Etapa desconocida: ${state.name}`);

        const startedAt = new Date();
        job =
          (await store.updateStage(jobId, owner, index, {
            status: "running",
            startedAt,
            finishedAt: undefined,
            durationMs: undefined,
            error: undefined,
            detail: undefined,
            steps: undefined
          })) ?? job;
        this.emit(job);

        const ctx: StageContext = {
          client,
          names,
          deps,
          store,
          memory,
          actor,
          log,
          report: async (detail) => {
            job = (await store.updateStage(jobId, owner, index, { detail: redactString(detail) })) ?? job;
            this.emit(job);
          },
          plan: async (steps) => {
            job = (await store.updateStage(jobId, owner, index, { steps: steps.map((s) => ({ ...s, status: "pending" as const })) })) ?? job;
            this.emit(job);
          },
          step: async (id, status, detail) => {
            const current = job.stages[index].steps ?? [];
            if (!current.some((s) => s.id === id)) return;
            const steps = current.map((s) =>
              s.id === id ? { ...s, status, ...(detail === undefined ? {} : { detail: redactString(detail) }) } : s
            );
            job = (await store.updateStage(jobId, owner, index, { steps })) ?? job;
            this.emit(job);
          },
          audit: (action, target, details) => store.audit({ actor, action, clientId: client._id, target, details })
        };

        try {
          await withRetry(
            async (attempt) => {
              job = (await store.updateStage(jobId, owner, index, { attempts: state.attempts + attempt + 1 })) ?? job;
              // Cada intento vuelve a ejecutar reconcile: consulta el estado real antes de crear.
              await stage.run(ctx);
            },
            {
              attempts: deps.timing.stageAttempts,
              baseMs: deps.timing.backoffBaseMs,
              maxMs: deps.timing.backoffMaxMs,
              sleep: deps.sleep
            },
            (error, attempt, delayMs) => {
              log.warn({ jobId, stage: stage.name, attempt, delayMs, code: error.code }, "Transient error; retrying stage");
              void ctx.report(`${redactString(error.message)} Reintentando (${attempt}/${deps.timing.stageAttempts - 1})…`);
            }
          );
        } catch (error) {
          const finishedAt = new Date();
          const info = describe(error);
          if (!(error instanceof ProvisioningError)) log.error({ err: error, jobId, stage: stage.name }, "Unexpected stage error");
          else log.warn({ jobId, stage: stage.name, code: info.code }, "Stage failed");

          // El paso que estaba en curso queda marcado como fallido.
          const steps = job.stages[index].steps?.map((s) => (s.status === "running" ? { ...s, status: "failed" as const } : s));
          job =
            (await store.updateStage(jobId, owner, index, {
              status: "failed",
              ...(steps ? { steps } : {}),
              finishedAt,
              durationMs: finishedAt.getTime() - startedAt.getTime(),
              error: { ...info, retryable: info.retryable || error instanceof TransientError }
            })) ?? job;
          await store.updateClient(client._id, { status: "failed" });
          job = (await store.finishJob(jobId, owner, "failed")) ?? job;
          this.emit(job);
          return job;
        }

        const finishedAt = new Date();
        job =
          (await store.updateStage(jobId, owner, index, {
            status: "succeeded",
            finishedAt,
            durationMs: finishedAt.getTime() - startedAt.getTime()
          })) ?? job;
        this.emit(job);
        this.log.info({ jobId, stage: stage.name as StageName }, "Stage succeeded");
      }

      await store.updateClient(job.clientId, { status: "ready" });
      job = (await store.finishJob(jobId, owner, "succeeded")) ?? job;
      this.emit(job);
      return job;
    } catch (error) {
      // Errores fuera de una etapa (cliente inexistente, etc.).
      log.error({ err: error, jobId }, "Job failed outside a stage");
      job = (await store.finishJob(jobId, owner, "failed")) ?? job;
      this.emit(job);
      return job;
    } finally {
      clearInterval(heartbeat);
      memory.credential = undefined;
    }
  }
}
