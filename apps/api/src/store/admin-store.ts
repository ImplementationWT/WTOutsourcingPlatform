import { randomUUID } from "node:crypto";
import { type Db, MongoServerError } from "mongodb";
import { OwnershipError } from "../lib/errors.js";
import { redact } from "../lib/redact.js";
import type { InitialPasswordDoc } from "./initial-password-vault.js";
import type { DeletionDoc } from "./models.js";
import {
  type AuditDoc,
  type ClientDoc,
  type JobDoc,
  type ResourceDoc,
  type ResourceKind,
  STAGES,
  type StageState
} from "./models.js";

export class DuplicateClientError extends Error {}
export class ActiveJobExistsError extends Error {}

const isDuplicateKey = (error: unknown) => error instanceof MongoServerError && error.code === 11000;

/** Falla si un valor a persistir contiene algo que la redacción ocultaría. */
function assertNoSecrets(value: unknown, where: string) {
  if (JSON.stringify(redact(value)) !== JSON.stringify(value)) {
    throw new Error(`Se intentó guardar un valor secreto en ${where}.`);
  }
}

/** Base administrativa de la plataforma (clientes, trabajos, recursos, auditoría). */
export class AdminStore {
  readonly clients;
  readonly jobs;
  readonly resources;
  readonly auditLog;
  /** Contraseñas iniciales cifradas pendientes de revelar (las gestiona InitialPasswordVault). */
  readonly initialPasswords;
  /** Progreso del borrado de cada cliente (se conserva tras borrarlo, como constancia). */
  readonly deletions;

  constructor(db: Db, private readonly now: () => Date = () => new Date()) {
    this.clients = db.collection<ClientDoc>("clients");
    this.jobs = db.collection<JobDoc>("jobs");
    this.resources = db.collection<ResourceDoc>("resources");
    this.auditLog = db.collection<AuditDoc>("audit");
    this.initialPasswords = db.collection<InitialPasswordDoc>("initial_password_reveals");
    this.deletions = db.collection<DeletionDoc>("deletions");
  }

  async init() {
    await Promise.all([
      // Un solo trabajo activo por cliente: dos solicitudes simultáneas no crean dos.
      this.jobs.createIndex({ clientId: 1 }, { unique: true, partialFilterExpression: { active: true }, name: "one_active_job" }),
      this.jobs.createIndex({ clientId: 1, createdAt: -1 }),
      this.resources.createIndex({ clientId: 1 }),
      this.auditLog.createIndex({ clientId: 1, at: -1 })
    ]);
  }

  // ---- clientes y trabajos -------------------------------------------------

  /** Crea cliente y trabajo inicial. DuplicateClientError si el slug ya existe. */
  async createClientWithJob(input: {
    slug: string;
    name: string;
    description: string;
    actor: string;
    /** Etapas activas, en orden (por defecto todas). */
    stages?: readonly string[];
  }) {
    const at = this.now();
    const jobId = randomUUID();
    try {
      await this.clients.insertOne({
        _id: input.slug,
        name: input.name,
        description: input.description,
        status: "provisioning",
        readiness: { ready: false },
        latestJobId: jobId,
        createdBy: input.actor,
        createdAt: at,
        updatedAt: at
      });
    } catch (error) {
      if (isDuplicateKey(error)) throw new DuplicateClientError(input.slug);
      throw error;
    }

    const job: JobDoc = {
      _id: jobId,
      clientId: input.slug,
      status: "queued",
      active: true,
      stages: STAGES.filter((s) => !input.stages || input.stages.includes(s.name)).map((s) => ({
        name: s.name,
        label: s.label,
        status: "pending",
        attempts: 0
      })),
      lease: null,
      createdBy: input.actor,
      createdAt: at,
      updatedAt: at
    };
    try {
      await this.jobs.insertOne(job);
    } catch (error) {
      if (isDuplicateKey(error)) throw new ActiveJobExistsError(input.slug);
      throw error;
    }
    return job;
  }

  getClient(slug: string) {
    return this.clients.findOne({ _id: slug });
  }

  updateClient(slug: string, patch: Partial<Omit<ClientDoc, "_id">>) {
    assertNoSecrets(patch, "el cliente");
    return this.clients.updateOne({ _id: slug }, { $set: { ...patch, updatedAt: this.now() } });
  }

  /** Actualiza campos anidados ("template.schemaVersion", …) sin reemplazar el objeto completo. */
  setClientFields(slug: string, fields: Record<string, unknown>) {
    assertNoSecrets(fields, "el cliente");
    return this.clients.updateOne({ _id: slug }, { $set: { ...fields, updatedAt: this.now() } });
  }

  getJob(id: string) {
    return this.jobs.findOne({ _id: id });
  }

  /**
   * Toma el trabajo para ejecutarlo. Solo un ejecutor puede tenerlo a la vez:
   * devuelve null si otro tiene el lease vigente o si el trabajo no está activo.
   */
  async acquireLease(jobId: string, owner: string, ttlMs: number) {
    const now = this.now();
    return this.jobs.findOneAndUpdate(
      { _id: jobId, active: true, $or: [{ lease: null }, { "lease.expiresAt": { $lt: now } }] },
      { $set: { lease: { owner, expiresAt: new Date(now.getTime() + ttlMs) }, status: "running", updatedAt: now } },
      { returnDocument: "after" }
    );
  }

  async renewLease(jobId: string, owner: string, ttlMs: number) {
    const now = this.now();
    const result = await this.jobs.updateOne(
      { _id: jobId, "lease.owner": owner },
      { $set: { "lease.expiresAt": new Date(now.getTime() + ttlMs) } }
    );
    return result.matchedCount === 1;
  }

  async updateStage(jobId: string, owner: string, index: number, patch: Partial<StageState>) {
    assertNoSecrets(patch, "el estado de la etapa");
    const set: Record<string, unknown> = { updatedAt: this.now() };
    for (const [key, value] of Object.entries(patch)) set[`stages.${index}.${key}`] = value;
    const unset: Record<string, ""> = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v === undefined).map(([k]) => [`stages.${index}.${k}`, "" as const])
    );
    for (const key of Object.keys(unset)) delete set[key];
    return this.jobs.findOneAndUpdate(
      { _id: jobId, "lease.owner": owner },
      { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { returnDocument: "after" }
    );
  }

  finishJob(jobId: string, owner: string, status: "failed" | "succeeded") {
    const now = this.now();
    return this.jobs.findOneAndUpdate(
      { _id: jobId, "lease.owner": owner },
      { $set: { status, active: false, lease: null, updatedAt: now, finishedAt: now } },
      { returnDocument: "after" }
    );
  }

  /**
   * Prepara el reintento: el trabajo fallido vuelve a la cola y su etapa
   * fallida pasa a pendiente. Las etapas ya completadas se conservan.
   */
  async prepareRetry(jobId: string, activeStages?: readonly string[]) {
    const job = await this.jobs.findOne({ _id: jobId, status: "failed" });
    if (!job) return null;
    // Las etapas desactivadas (p. ej. deploy en la fase 1) se quitan del trabajo.
    const stages = job.stages.filter((stage) => !activeStages || activeStages.includes(stage.name)).map((stage) =>
      stage.status === "failed" || stage.status === "running"
        ? { name: stage.name, label: stage.label, status: "pending" as const, attempts: stage.attempts }
        : stage
    );
    try {
      return await this.jobs.findOneAndUpdate(
        { _id: jobId, status: "failed" },
        { $set: { status: "queued", active: true, stages, lease: null, updatedAt: this.now() }, $unset: { finishedAt: "" } },
        { returnDocument: "after" }
      );
    } catch (error) {
      if (isDuplicateKey(error)) throw new ActiveJobExistsError(job.clientId);
      throw error;
    }
  }

  /**
   * Trabajos que quedaron "running" con el lease vencido (p. ej. reinicio del
   * servidor) se marcan como fallidos para que se puedan reintentar.
   */
  async failAbandonedJobs() {
    const now = this.now();
    const abandoned = await this.jobs.find({ active: true, status: "running", "lease.expiresAt": { $lt: now } }).toArray();
    for (const job of abandoned) {
      const index = job.stages.findIndex((s) => s.status === "running");
      const stages = job.stages.map((s, i) =>
        i === index
          ? { ...s, status: "failed" as const, error: { code: "interrupted", message: "El trabajo se interrumpió (reinicio del servidor). Reintenta para continuar.", retryable: true } }
          : s
      );
      await this.jobs.updateOne(
        { _id: job._id, "lease.expiresAt": { $lt: now } },
        { $set: { status: "failed", active: false, lease: null, stages, updatedAt: now } }
      );
      await this.updateClient(job.clientId, { status: "failed" });
    }
    return abandoned.length;
  }

  // ---- recursos ------------------------------------------------------------

  getResource(kind: ResourceKind, name: string) {
    return this.resources.findOne({ _id: `${kind}:${name}` });
  }

  listResources(clientId: string) {
    return this.resources.find({ clientId }).toArray();
  }

  /**
   * Reclama un recurso para un cliente antes de crearlo fuera. Si ya estaba
   * reclamado por otro cliente lanza OwnershipError. `created` indica si el
   * reclamo es nuevo (es decir, la plataforma no lo conocía hasta ahora).
   */
  async claimResource(kind: ResourceKind, name: string, clientId: string) {
    const now = this.now();
    try {
      const doc: ResourceDoc = { _id: `${kind}:${name}`, kind, name, clientId, ref: {}, createdAt: now, updatedAt: now };
      await this.resources.insertOne(doc);
      return { resource: doc, created: true };
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      const existing = await this.getResource(kind, name);
      if (!existing || existing.clientId !== clientId) {
        throw new OwnershipError(`El recurso ${name} pertenece a otro cliente. No se reutiliza.`);
      }
      return { resource: existing, created: false };
    }
  }

  async updateResourceRef(kind: ResourceKind, name: string, clientId: string, ref: ResourceDoc["ref"]) {
    assertNoSecrets(ref, `el recurso ${kind}`);
    const set: Record<string, unknown> = { updatedAt: this.now() };
    for (const [key, value] of Object.entries(ref)) set[`ref.${key}`] = value;
    const result = await this.resources.findOneAndUpdate(
      { _id: `${kind}:${name}`, clientId },
      { $set: set },
      { returnDocument: "after" }
    );
    if (!result) throw new OwnershipError(`El recurso ${name} no pertenece a este cliente.`);
    return result;
  }

  // ---- auditoría -----------------------------------------------------------

  async audit(entry: Omit<AuditDoc, "at">) {
    assertNoSecrets(entry, "la auditoría");
    await this.auditLog.insertOne({ ...entry, at: this.now() });
  }
}
