import type { FastifyInstance } from "fastify";
import { clientScope, teamFilterOf } from "../auth/access.js";
import { requireAuth } from "../auth/session.js";
import { deriveNames, parseSlug } from "../domain/naming.js";
import type { Deps } from "../jobs/types.js";
import type { AdminStore } from "../store/admin-store.js";
import type { ClientDoc, JobDoc } from "../store/models.js";
import { initialAdminStatus, shortDigest } from "./clients.js";
import { appsDomainOf } from "../servers/resolve.js";

const PROBE_TIMEOUT_MS = 4_000;
/** Acciones de auditoría que se muestran (sin detalles: solo qué, quién, cuándo y sobre qué cliente). */
const ACTIVITY_LIMIT = 12;

type Live = "online" | "offline" | "not_deployed";

/** GET <app>/health/ready por HTTPS, con tope de tiempo: el dashboard no espera a una app caída. */
async function probeLive(deps: Deps, baseUrl: string): Promise<{ live: Live; responseMs: number | null }> {
  const started = Date.now();
  const timeout = new Promise<number>((resolve) => setTimeout(() => resolve(0), PROBE_TIMEOUT_MS).unref());
  const status = await Promise.race([deps.probe.status(`${baseUrl}/health/ready`).catch(() => 0), timeout]);
  return status === 200 ? { live: "online", responseMs: Date.now() - started } : { live: "offline", responseMs: null };
}

function latestJobView(job: JobDoc | null) {
  if (!job) return null;
  const failed = job.stages.find((s) => s.status === "failed");
  return {
    status: job.status,
    failedStage: failed ? { name: failed.name, label: failed.label, message: failed.error?.message ?? null } : null,
    finishedAt: job.finishedAt ?? null
  };
}

/** Datos reales del panel principal: estado de los proyectos, salud en vivo y actividad. */
export async function registerDashboardRoutes(app: FastifyInstance, { store, deps }: { store: AdminStore; deps: Deps }) {
  app.get("/api/dashboard", { preHandler: requireAuth }, async (request) => {
    const { config, github } = deps;
    const user = request.user!;
    const teamFilter = teamFilterOf(request);
    // Solo los proyectos (y su actividad) que ve el usuario.
    const clients = await store.clients.find(clientScope(user, teamFilter)).sort({ createdAt: -1 }).toArray();
    const jobs = await store.jobs.find({ _id: { $in: clients.map((c) => c.latestJobId) } }).toArray();
    const jobById = new Map(jobs.map((j) => [j._id, j]));

    const projects = await Promise.all(
      clients.map(async (client: ClientDoc) => {
        const names = deriveNames(parseSlug(client._id), { targetOwner: github.owner, appsDomain: appsDomainOf(client, config) });
        const deployed = config.deployEnabled && !!client.deployment?.preparedAt;
        const health = deployed ? await probeLive(deps, names.baseUrl) : { live: "not_deployed" as const, responseMs: null };
        return {
          id: client._id,
          name: client.name,
          status: client.status,
          appUrl: names.baseUrl,
          live: health.live,
          responseMs: health.responseMs,
          templateVersion: client.template?.version ?? null,
          schemaVersion: client.template?.schemaVersion ?? null,
          httpsVerifiedAt: client.deployment?.httpsVerifiedAt ?? null,
          image: client.deployment?.image ? { digest: shortDigest(client.deployment.image), deployedAt: client.deployment.deployedAt ?? null } : null,
          latestJob: latestJobView(jobById.get(client.latestJobId) ?? null),
          initialAdmin: initialAdminStatus(client, await deps.vault.pendingUntil(client._id), deps.vault.now()).state,
          createdAt: client.createdAt
        };
      })
    );

    const attention = projects.flatMap((p) => {
      const items: { clientId: string; name: string; kind: string; message: string }[] = [];
      if (p.status === "failed" && p.latestJob?.failedStage) {
        items.push({
          clientId: p.id,
          name: p.name,
          kind: "job_failed",
          message: `Falló en "${p.latestJob.failedStage.label}"${p.latestJob.failedStage.message ? `: ${p.latestJob.failedStage.message}` : ""}`
        });
      }
      if (p.live === "offline") {
        items.push({ clientId: p.id, name: p.name, kind: "offline", message: `${p.appUrl}/health/ready no responde 200.` });
      }
      if (p.initialAdmin === "available") {
        items.push({ clientId: p.id, name: p.name, kind: "password_pending", message: "La contraseña inicial aún no se ha mostrado (caduca a los 30 min)." });
      }
      return items;
    });

    const allActivity = user.role === "boss" && !teamFilter;
    const activity = await store.auditLog
      .find(allActivity ? {} : { clientId: { $in: clients.map((c) => c._id) } }, { projection: { _id: 0, at: 1, actor: 1, actorName: 1, action: 1, clientId: 1 } })
      .sort({ at: -1 })
      .limit(ACTIVITY_LIMIT)
      .toArray();

    const lastDeploy = projects
      .map((p) => p.image?.deployedAt)
      .filter((d): d is Date => d instanceof Date)
      .sort((a, b) => b.getTime() - a.getTime())[0];

    return {
      generatedAt: new Date(),
      deployEnabled: config.deployEnabled,
      totals: {
        projects: projects.length,
        ready: projects.filter((p) => p.status === "ready").length,
        provisioning: projects.filter((p) => p.status === "provisioning").length,
        failed: projects.filter((p) => p.status === "failed").length,
        online: projects.filter((p) => p.live === "online").length,
        offline: projects.filter((p) => p.live === "offline").length,
        deployed: projects.filter((p) => p.live !== "not_deployed").length
      },
      lastDeployAt: lastDeploy ?? null,
      projects,
      attention,
      activity
    };
  });
}
