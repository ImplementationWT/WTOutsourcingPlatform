import { FatalError } from "../../lib/errors.js";
import { pollUntil } from "../../lib/retry.js";
import type { Stage, StageContext } from "../types.js";

const CLOCK_SKEW_MS = 30_000;

async function findDispatchedRun(ctx: StageContext, since: Date, { adopting }: { adopting: boolean }) {
  const { github, config, timing, sleep } = ctx.deps;
  return pollUntil(
    async () => {
      const runs = await github.listDispatchRuns(ctx.names.repository, config.template.deployWorkflow, config.template.ref);
      return runs.find(
        (run) =>
          new Date(run.createdAt).getTime() >= since.getTime() - CLOCK_SKEW_MS &&
          // Al adoptar un run de un intento anterior, uno ya fallido no sirve: se lanza otro.
          !(adopting && run.status === "completed" && run.conclusion !== "success")
      );
    },
    { timeoutMs: timing.runAppearTimeoutMs, intervalMs: timing.pollIntervalMs, sleep }
  );
}

export const deployStage: Stage = {
  name: "deploy",
  async run(ctx) {
    const { names, store, deps, client } = ctx;
    const { github, config, timing, sleep } = deps;
    const workflow = config.template.deployWorkflow;

    if (!config.deploy) {
      throw new FatalError(
        "deploy_not_configured",
        "DEPLOY_ENABLED=true pero faltan DEPLOY_SSH_HOST, DEPLOY_SSH_USER, DEPLOY_SSH_PRIVATE_KEY_PATH o DEPLOY_SSH_KNOWN_HOSTS_PATH; el workflow Deploy fallaría sin ellos."
      );
    }

    // La generación desde template tarda: se espera a que el workflow exista y esté activo.
    await ctx.report(`Esperando el workflow ${workflow}…`);
    const available = await pollUntil(
      async () => ((await github.getWorkflow(names.repository, workflow))?.state === "active" ? true : undefined),
      { timeoutMs: timing.workflowAvailableTimeoutMs, intervalMs: timing.pollIntervalMs, sleep }
    );
    if (!available) {
      throw new FatalError("workflow_unavailable", `El workflow ${workflow} no está disponible en ${names.repositoryFullName}.`);
    }

    const { resource } = await store.claimResource("deploy", names.repositoryFullName, client._id);
    let runId = typeof resource.ref.runId === "number" ? resource.ref.runId : undefined;
    let discardedFailedRun = false;

    // Un run anterior que terminó mal no se "sigue": el reintento lanza un despliegue nuevo.
    if (runId) {
      const previous = await github.getRun(names.repository, runId);
      if (previous.status === "completed" && previous.conclusion === "success") {
        await ctx.report(`Despliegue ya completado (${previous.url}).`);
        return;
      }
      if (previous.status === "completed") {
        runId = undefined;
        discardedFailedRun = true;
      }
    }

    if (!runId && !discardedFailedRun && typeof resource.ref.dispatchRequestedAt === "string") {
      // Se pidió el dispatch pero no se registró el run (timeout o reinicio): se busca antes de repetir.
      const adopted = await findDispatchedRun(ctx, new Date(resource.ref.dispatchRequestedAt), { adopting: true });
      if (adopted) runId = adopted.id;
    }

    if (!runId) {
      const requestedAt = new Date();
      await store.updateResourceRef("deploy", names.repositoryFullName, client._id, {
        workflow,
        ref: config.template.ref,
        dispatchRequestedAt: requestedAt.toISOString(),
        runId: null,
        runUrl: null
      });
      await ctx.report(`Lanzando ${workflow} sobre ${config.template.ref}…`);
      await github.dispatchWorkflow(names.repository, workflow, config.template.ref);
      await ctx.audit("github.workflow.dispatched", names.repositoryFullName, { workflow, ref: config.template.ref });

      const run = await findDispatchedRun(ctx, requestedAt, { adopting: false });
      if (!run) throw new FatalError("run_not_found", `GitHub no registró la ejecución de ${workflow} tras lanzarla.`);
      runId = run.id;
    }

    const started = await github.getRun(names.repository, runId);
    await store.updateResourceRef("deploy", names.repositoryFullName, client._id, { runId, runUrl: started.url });
    await ctx.report(`Despliegue en curso: ${started.url}`);

    const finished = await pollUntil(
      async () => {
        const run = await github.getRun(names.repository, runId);
        return run.status === "completed" ? run : undefined;
      },
      { timeoutMs: timing.runCompleteTimeoutMs, intervalMs: timing.pollIntervalMs, sleep }
    );
    if (!finished) throw new FatalError("deploy_timeout", `El despliegue no terminó a tiempo. Revisa ${started.url}.`);
    if (finished.conclusion !== "success") {
      throw new FatalError("deploy_failed", `El despliegue terminó con "${finished.conclusion}". Revisa ${finished.url}.`);
    }
    await ctx.report(`Despliegue completado (${finished.url}).`);
  }
};
