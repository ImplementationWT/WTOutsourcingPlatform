import { buildMongoUri } from "../adapters/mongo-bootstrap.js";
import { deriveNames, parseSlug } from "../domain/naming.js";
import { FatalError, OwnershipError, ProvisioningError, TransientError } from "../lib/errors.js";
import { redactString, registerSecret } from "../lib/redact.js";
import { pollUntil } from "../lib/retry.js";
import type { AdminStore } from "../store/admin-store.js";
import type { DeletionDoc, DeletionStep, DeletionStepStatus } from "../store/models.js";
import { generatePassword, MANAGED_BY, ownershipLabels } from "./stages/credentials.js";
import type { Deps, Logger } from "./types.js";

const STEPS: { id: string; label: string }[] = [
  { id: "preflight", label: "Comprobar que los recursos son de este proyecto" },
  { id: "server", label: "Servidor: app, nginx, certificado HTTPS, clave SSH y puerto" },
  { id: "github_repository", label: "Repositorio en GitHub" },
  { id: "container_image", label: "Imagen del contenedor en GHCR" },
  { id: "mongodb_data", label: "Datos de la base en MongoDB" },
  { id: "mongodb_user", label: "Usuario de la base en Atlas" },
  { id: "dns", label: "DNS del subdominio" },
  { id: "records", label: "Registros del proyecto en la plataforma" }
];

export class ActiveWorkError extends Error {}

/** Vista pública del borrado (sin campos internos). */
export function toPublicDeletion(doc: DeletionDoc) {
  return {
    clientId: doc._id,
    status: doc.status,
    steps: doc.steps,
    requestedBy: doc.requestedBy,
    startedAt: doc.startedAt,
    finishedAt: doc.finishedAt ?? null,
    error: doc.error ?? null
  };
}

/**
 * Borra un proyecto y todo lo que la plataforma creó para él. Cada paso comprueba
 * el estado real y es idempotente: si algo falla, reintentar continúa sin romper
 * lo ya borrado. Solo se borra lo que es de este cliente (registros de la
 * plataforma y etiquetas de Atlas); la auditoría se conserva como historial.
 */
export class Teardown {
  private readonly running = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: AdminStore,
    private readonly deps: Deps,
    private readonly log: Logger
  ) {}

  async idle() {
    await Promise.all([...this.running.values()]);
  }

  /** Registra el borrado y lo lanza en segundo plano. */
  async start(slug: string, actor: string) {
    if (this.running.has(slug)) throw new ActiveWorkError("El borrado de este proyecto ya está en curso.");
    const active = await this.store.jobs.findOne({ clientId: slug, active: true });
    if (active) throw new ActiveWorkError("El proyecto tiene un aprovisionamiento en curso; espera a que termine.");
    if (await this.store.aiSessions.findOne({ clientId: slug, status: "active" })) {
      throw new ActiveWorkError("El proyecto tiene una sesión activa del AI Developer; ciérrala o fusiónala antes de borrarlo.");
    }

    const doc: DeletionDoc = {
      _id: slug,
      status: "running",
      steps: STEPS.map((s) => ({ ...s, status: "pending" as const })),
      requestedBy: actor,
      startedAt: new Date()
    };
    await this.store.deletions.replaceOne({ _id: slug }, doc, { upsert: true });
    await this.store.audit({ actor, action: "client.deletion_requested", clientId: slug, target: slug });

    const promise = this.run(slug, actor)
      .catch((error) => this.log.error({ err: error, slug }, "Teardown crashed"))
      .finally(() => this.running.delete(slug));
    this.running.set(slug, promise);
    return doc;
  }

  private async setStep(slug: string, id: string, status: DeletionStepStatus, detail?: string) {
    const steps = (await this.store.deletions.findOne({ _id: slug }))?.steps ?? [];
    const next: DeletionStep[] = steps.map((s) =>
      s.id === id ? { id: s.id, label: s.label, status, ...(detail ? { detail: redactString(detail) } : {}) } : s
    );
    await this.store.deletions.updateOne({ _id: slug }, { $set: { steps: next } });
  }

  async run(slug: string, actor: string) {
    const { store, deps } = this;
    const names = deriveNames(parseSlug(slug), { targetOwner: deps.github.owner, appsDomain: deps.config.appsDomain });
    let current = "";
    try {
      const client = await store.getClient(slug);

      // 0. Antes de borrar nada: lo que no sea de este cliente detiene el borrado entero.
      current = "preflight";
      await this.setStep(slug, current, "running");
      const user = await deps.atlas.getDatabaseUser(names.dbUser);
      if (user) {
        const label = (key: string) => user.labels.find((l) => l.key === key)?.value;
        if (label("managed-by") !== MANAGED_BY || label("client-id") !== slug) {
          throw new OwnershipError(`El usuario ${names.dbUser} de Atlas no está marcado como de este cliente: no se borra nada.`);
        }
      }
      const repo = await store.getResource("github_repository", names.repositoryFullName);
      const ownsRepo = repo?.clientId === slug;
      await this.setStep(slug, current, "done", "Solo se borrará lo que la plataforma creó para este proyecto.");

      // 1. Servidor: primero se apaga la app, que es quien usa la base.
      current = "server";
      await this.setStep(slug, current, "running");
      if (deps.config.server) {
        const result = await deps.server.uninstallClient(names.slug);
        const removed = Object.entries(result.removed)
          .filter(([, v]) => v === true || (typeof v === "number" && v > 0))
          .map(([k]) => k);
        await this.setStep(slug, current, "done", removed.length ? `Retirado: ${removed.join(", ")}.` : "No había nada instalado.");
      } else if (client?.deployment?.preparedAt) {
        throw new FatalError("server_not_configured", "El proyecto está desplegado pero el servidor no está configurado en la plataforma.");
      } else {
        await this.setStep(slug, current, "skipped", "El proyecto nunca se desplegó en el servidor.");
      }

      // 2 y 3. GitHub: solo si el repositorio lo creó la plataforma para este cliente.
      current = "github_repository";
      await this.setStep(slug, current, "running");
      if (!ownsRepo) {
        await this.setStep(slug, current, "skipped", "La plataforma no tiene registrado este repositorio como suyo: no se toca.");
      } else {
        const deleted = await deps.github.deleteRepository(names.repository);
        await this.setStep(slug, current, "done", deleted ? `${names.repositoryFullName} borrado.` : "Ya no existía.");
      }

      current = "container_image";
      await this.setStep(slug, current, "running");
      if (!ownsRepo) {
        await this.setStep(slug, current, "skipped", "Sin repositorio de la plataforma: no hay imagen que borrar.");
      } else {
        const result = await deps.github.deleteContainerPackage(names.repository);
        const packagesUrl = `https://github.com/${deps.github.owner}?tab=packages&q=${names.repository}`;
        if (result === "deleted") {
          await this.setStep(slug, current, "done", `${names.repository} borrada de GHCR.`);
        } else if (result === "forbidden") {
          await this.setStep(slug, current, "warning", `GitHub no permite a la App borrar paquetes de esta cuenta. Bórrala a mano: ${packagesUrl}`);
        } else if (client?.deployment?.image) {
          // Hubo despliegue, así que la imagen existió: un 404 suele ser que la App no ve los paquetes de la cuenta.
          await this.setStep(slug, current, "warning", `No se pudo confirmar el borrado (la App no ve el paquete). Revísala y bórrala a mano: ${packagesUrl}`);
        } else {
          await this.setStep(slug, current, "done", "No había imagen: el proyecto nunca se desplegó.");
        }
      }

      // 4 y 5. MongoDB: con el propio usuario del cliente (readWrite) se borran sus colecciones.
      current = "mongodb_data";
      await this.setStep(slug, current, "running");
      if (user) {
        // La contraseña no se guarda: se rota para poder entrar una última vez.
        const password = (deps.generatePassword ?? generatePassword)();
        registerSecret(password);
        await deps.atlas.updateDatabaseUser({
          username: names.dbUser,
          password,
          database: names.database,
          labels: ownershipLabels(slug),
          description: `${MANAGED_BY}: ${slug}`
        });
        const uri = buildMongoUri(deps.config.atlas.srvHost, names.dbUser, password, slug);
        // Atlas tarda unos segundos en aplicar la contraseña nueva.
        const dropped = await pollUntil(() => deps.mongo.dropAllCollections({ uri, database: names.database }), {
          timeoutMs: deps.timing.mongoAuthTimeoutMs,
          intervalMs: deps.timing.pollIntervalMs,
          sleep: deps.sleep
        });
        await this.setStep(slug, current, "done", `${names.database}: ${dropped ?? 0} colecciones borradas.`);
      } else {
        await this.setStep(slug, current, "skipped", `No existe el usuario ${names.dbUser}: no hay credencial para entrar en ${names.database}.`);
      }

      current = "mongodb_user";
      await this.setStep(slug, current, "running");
      if (user) {
        const deleted = await deps.atlas.deleteDatabaseUser(names.dbUser);
        await this.setStep(slug, current, "done", deleted ? `${names.dbUser} borrado.` : "Ya no existía.");
      } else {
        await this.setStep(slug, current, "skipped", "Ya no existía.");
      }

      // 6. DNS: un único registro comodín para todos los clientes.
      current = "dns";
      await this.setStep(slug, current, "skipped", `El registro *.${deps.config.appsDomain} es compartido: no hay nada propio de este proyecto.`);

      // 7. Registros de la plataforma (la auditoría se conserva).
      current = "records";
      await this.setStep(slug, current, "running");
      await Promise.all([
        store.clients.deleteOne({ _id: slug }),
        store.jobs.deleteMany({ clientId: slug }),
        store.resources.deleteMany({ clientId: slug }),
        store.initialPasswords.deleteOne({ _id: slug }),
        store.aiSessions.deleteMany({ clientId: slug }),
        deps.secrets.deleteAll(slug)
      ]);
      await store.audit({ actor, action: "client.deleted", clientId: slug, target: slug });
      await this.setStep(slug, current, "done", "Cliente, trabajos, recursos y sesiones del AI Developer borrados; la auditoría se conserva.");

      await store.deletions.updateOne({ _id: slug }, { $set: { status: "succeeded", finishedAt: new Date() }, $unset: { error: "" } });
    } catch (error) {
      const info =
        error instanceof ProvisioningError
          ? { code: error.code, message: redactString(error.message) }
          : { code: "internal_error", message: "Error interno al borrar. Revisa los logs del servidor." };
      if (!(error instanceof ProvisioningError)) this.log.error({ err: error, slug, step: current }, "Unexpected teardown error");
      if (current) await this.setStep(slug, current, "failed", info.message);
      await store.deletions.updateOne(
        { _id: slug },
        { $set: { status: "failed", finishedAt: new Date(), error: info } }
      );
      if (error instanceof TransientError) this.log.warn({ slug, code: error.code }, "Teardown failed (transient)");
    }
  }
}
