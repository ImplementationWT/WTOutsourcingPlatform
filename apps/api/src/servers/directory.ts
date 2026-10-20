import { randomBytes, randomUUID } from "node:crypto";
import type { Collection } from "mongodb";
import { MongoServerError } from "mongodb";
import {
  createServerAdapter,
  fetchHostKey as defaultFetchHostKey,
  generateClientKeyPair,
  type ServerAdapter,
  type ServerConnection,
  type ServerInfo
} from "../adapters/server.js";
import { FatalError } from "../lib/errors.js";
import { registerSecret } from "../lib/redact.js";
import { open, seal } from "../lib/server-cipher.js";
import type { DnsResolver, ServerTargetConfig } from "../jobs/types.js";
import type { ClientDoc, ClientServerRef, ServerCheck, ServerDoc } from "../store/models.js";

/** Id del servidor de la configuración (DEPLOY_HOST…): el de los proyectos anteriores. */
export const PRIMARY_SERVER_ID = "principal";
/** Versión mínima de los scripts del VPS (vista previa en vivo desde la 3). */
export const MIN_SCRIPTS_VERSION = 3;
const MIN_DISK_MB = 2_048;

/** Servidor listo para desplegar: datos para los repos y su adaptador SSH. */
export interface DeployTarget extends ServerTargetConfig {
  id: string;
  name: string;
  appsDomain: string;
  adapter: ServerAdapter;
}

/** Resuelve el servidor de un proyecto (lo usan etapas, borrado y AI Developer). */
export interface ServerTargets {
  target(id: string): Promise<DeployTarget>;
}

export type ServerStatus = "host_key" | "verify" | "ready";

export class ServerDirectoryError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export interface CreateServerInput {
  name: string;
  host: string;
  sshPort: number;
  appsDomain: string;
  publicIp: string;
}

export interface ServerDirectoryDeps {
  servers: Collection<ServerDoc>;
  clients: Collection<ClientDoc>;
  /** Clave AES-256 que cifra las claves privadas del provisioner (sin ella, solo el principal). */
  key?: Buffer;
  /** Servidor de la configuración, si existe (no se edita ni se borra desde el panel). */
  primary?: Omit<DeployTarget, "id" | "name">;
  /** GHCR_ORG y ACME_CA de la plataforma (comunes a todos los servidores). */
  ghcrOrg?: string;
  acmeCa?: string;
  resolver: DnsResolver;
  createAdapter?: (connection: ServerConnection) => ServerAdapter;
  fetchHostKey?: typeof defaultFetchHostKey;
  now?: () => Date;
}

const statusOf = (doc: ServerDoc): ServerStatus => (!doc.knownHosts ? "host_key" : doc.verification?.ok ? "ready" : "verify");
const sealContext = (id: string) => `server:${id}`;
const FINGERPRINT_RE = /SHA256:[A-Za-z0-9+/]{43}/;

/**
 * Servidores de despliegue. Seguridad:
 * - Launchpad genera el par del provisioner de cada servidor; la privada solo se guarda
 *   cifrada y nunca sale de la API (ni en respuestas ni en logs).
 * - La clave del host se fija solo cuando una persona confirma su huella con la que ve
 *   en la consola del VPS; después cualquier otra se rechaza.
 * - Un servidor solo se usa tras verificarlo (server-info + DNS comodín).
 */
export class ServerDirectory implements ServerTargets {
  private readonly adapters = new Map<string, { updatedAt: number; adapter: ServerAdapter }>();
  private readonly now: () => Date;

  constructor(private readonly deps: ServerDirectoryDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Se pueden dar de alta servidores (hay clave de cifrado). */
  get available() {
    return Boolean(this.deps.key);
  }

  /** GHCR_ORG que debe tener el platform.conf de cada servidor. */
  get ghcrOrg() {
    return this.deps.ghcrOrg ?? null;
  }

  private async projectCounts() {
    const rows = await this.deps.clients.aggregate<{ _id: string | null; count: number }>([{ $group: { _id: "$server.id", count: { $sum: 1 } } }]).toArray();
    return new Map(rows.map((row) => [row._id ?? PRIMARY_SERVER_ID, row.count]));
  }

  private publicView(doc: ServerDoc, projects: number) {
    return {
      id: doc._id,
      name: doc.name,
      primary: false,
      host: doc.host,
      sshPort: doc.sshPort,
      appsDomain: doc.appsDomain,
      publicIp: doc.publicIp,
      status: statusOf(doc),
      provisionerPublicKey: doc.provisionerPublicKey,
      hostKeyFingerprint: doc.hostKeyFingerprint ?? null,
      verification: doc.verification ?? null,
      projects,
      createdBy: doc.createdBy,
      createdAt: doc.createdAt
    };
  }

  private primaryView(projects: number) {
    const primary = this.deps.primary;
    if (!primary) return null;
    return {
      id: PRIMARY_SERVER_ID,
      name: "Principal",
      primary: true,
      host: primary.host,
      sshPort: null,
      appsDomain: primary.appsDomain,
      publicIp: primary.publicIp,
      status: "ready" as ServerStatus,
      provisionerPublicKey: null,
      hostKeyFingerprint: null,
      verification: null,
      projects,
      createdBy: null,
      createdAt: null
    };
  }

  async list() {
    const [docs, counts] = await Promise.all([this.deps.servers.find().sort({ createdAt: 1 }).toArray(), this.projectCounts()]);
    const primary = this.primaryView(counts.get(PRIMARY_SERVER_ID) ?? 0);
    return [...(primary ? [primary] : []), ...docs.map((doc) => this.publicView(doc, counts.get(doc._id) ?? 0))];
  }

  async get(id: string) {
    const doc = await this.load(id);
    const projects = await this.deps.clients.countDocuments({ "server.id": id });
    return this.publicView(doc, projects);
  }

  private async load(id: string) {
    const doc = await this.deps.servers.findOne({ _id: id });
    if (!doc) throw new ServerDirectoryError(404, "Servidor no encontrado.");
    return doc;
  }

  private requireKey() {
    if (!this.deps.key) {
      throw new ServerDirectoryError(503, "Falta la clave de cifrado de servidores (SERVER_KEYS_ENCRYPTION_KEY_SECRET_REF) en la plataforma.");
    }
    return this.deps.key;
  }

  private newKeyPair(id: string, name: string) {
    const pair = generateClientKeyPair(`launchpad-provisioner ${name}`.slice(0, 80));
    return { provisionerPublicKey: pair.publicKey, provisionerKey: seal(this.requireKey(), pair.privateKey, sealContext(id)) };
  }

  async create(input: CreateServerInput, actor: string) {
    this.requireKey();
    const appsDomain = input.appsDomain.toLowerCase();
    if (this.deps.primary && appsDomain === this.deps.primary.appsDomain.toLowerCase()) {
      throw new ServerDirectoryError(409, `${appsDomain} ya es el dominio del servidor principal.`);
    }
    const id = randomUUID();
    const at = this.now();
    const doc: ServerDoc = {
      _id: id,
      name: input.name,
      host: input.host.toLowerCase(),
      sshPort: input.sshPort,
      appsDomain,
      publicIp: input.publicIp,
      ...this.newKeyPair(id, input.name),
      createdBy: actor,
      createdAt: at,
      updatedAt: at
    };
    try {
      await this.deps.servers.insertOne(doc);
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw new ServerDirectoryError(409, `Ya hay un servidor con el dominio ${appsDomain}.`);
      }
      throw error;
    }
    return this.publicView(doc, 0);
  }

  /** Huella actual del servidor (solo para mostrarla; no se fija). */
  async readFingerprint(id: string) {
    const doc = await this.load(id);
    const { fingerprint } = await (this.deps.fetchHostKey ?? defaultFetchHostKey)(doc.host, doc.sshPort);
    return { fingerprint };
  }

  /**
   * Fija la clave del host si su huella coincide con la que la persona copió de la consola
   * del VPS (salida de ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub).
   */
  async pinHostKey(id: string, consoleOutput: string) {
    const doc = await this.load(id);
    const expected = FINGERPRINT_RE.exec(consoleOutput)?.[0];
    if (!expected) throw new ServerDirectoryError(400, "Pega la salida de ssh-keygen -lf: debe contener la huella SHA256:…");
    if (doc.knownHosts && (await this.deps.clients.countDocuments({ "server.id": id }))) {
      throw new ServerDirectoryError(409, "El servidor ya tiene proyectos: su huella no se puede cambiar (los repos la usan para desplegar).");
    }
    const live = await (this.deps.fetchHostKey ?? defaultFetchHostKey)(doc.host, doc.sshPort);
    if (live.fingerprint !== expected) {
      throw new ServerDirectoryError(
        409,
        `La huella del servidor (${live.fingerprint}) no coincide con la de la consola. No se fija: comprueba el host o una posible suplantación.`
      );
    }
    const knownHosts = `${doc.host} ${live.type} ${live.key.toString("base64")}`;
    await this.deps.servers.updateOne(
      { _id: id },
      { $set: { knownHosts, hostKeyFingerprint: live.fingerprint, updatedAt: this.now() }, $unset: { verification: "" } }
    );
    return this.get(id);
  }

  private adapterFor(doc: ServerDoc) {
    if (!doc.knownHosts) throw new ServerDirectoryError(409, "Primero confirma la huella del servidor.");
    const cached = this.adapters.get(doc._id);
    if (cached && cached.updatedAt === doc.updatedAt.getTime()) return cached.adapter;
    const privateKey = open(this.requireKey(), doc.provisionerKey, sealContext(doc._id));
    registerSecret(privateKey);
    const [, type, b64] = doc.knownHosts.split(" ");
    const connection: ServerConnection = {
      host: doc.host,
      port: doc.sshPort,
      hostKeys: [{ type, key: Buffer.from(b64, "base64") }],
      provisionerKey: privateKey
    };
    const adapter = (this.deps.createAdapter ?? createServerAdapter)(connection);
    this.adapters.set(doc._id, { updatedAt: doc.updatedAt.getTime(), adapter });
    return adapter;
  }

  /** Comprueba el servidor (scripts, configuración, nginx, Docker, DNS) y guarda el resultado. */
  async verify(id: string) {
    const doc = await this.load(id);
    const adapter = this.adapterFor(doc);
    let checks: ServerCheck[] = [];
    let error: string | undefined;
    try {
      const info = await adapter.serverInfo();
      checks = [...this.infoChecks(doc, info), await this.dnsCheck(doc)];
    } catch (e) {
      error = e instanceof Error ? e.message : "No se pudo consultar el servidor.";
    }
    const verification = { at: this.now(), ok: !error && checks.every((c) => c.ok || !c.required), checks, ...(error ? { error } : {}) };
    // updatedAt no cambia: el adaptador en caché sigue valiendo.
    await this.deps.servers.updateOne({ _id: id }, { $set: { verification } });
    return this.get(id);
  }

  private infoChecks(doc: ServerDoc, info: ServerInfo): ServerCheck[] {
    const loopback = /^http:\/\/(127\.0\.0\.1|localhost):/.test(info.panelUpstream);
    return [
      {
        id: "scripts",
        label: "Scripts de la plataforma actualizados",
        required: true,
        ok: info.scriptsVersion >= MIN_SCRIPTS_VERSION,
        detail: `Versión ${info.scriptsVersion} (mínima ${MIN_SCRIPTS_VERSION}).`
      },
      {
        id: "domain",
        label: "APP_BASE_DOMAIN coincide",
        required: true,
        ok: info.appBaseDomain === doc.appsDomain,
        detail: info.appBaseDomain === doc.appsDomain ? doc.appsDomain : `El servidor tiene ${info.appBaseDomain || "(vacío)"}; aquí está ${doc.appsDomain}.`
      },
      {
        id: "ghcr",
        label: "GHCR_ORG coincide",
        required: true,
        ok: !this.deps.ghcrOrg || info.ghcrOrg === this.deps.ghcrOrg,
        detail: `Servidor: ${info.ghcrOrg || "(vacío)"}${this.deps.ghcrOrg ? ` · plataforma: ${this.deps.ghcrOrg}` : ""}.`
      },
      { id: "acme", label: "ACME_EMAIL configurado (certificados)", required: true, ok: info.acmeEmail },
      {
        id: "nginx",
        label: "nginx válido e incluye las apps",
        required: true,
        ok: info.nginx.valid && info.nginx.include,
        detail: !info.nginx.valid ? "nginx -t falla." : !info.nginx.include ? "Falta el include: bootstrap-vps.sh --wire-nginx." : undefined
      },
      { id: "docker", label: "Docker disponible", required: true, ok: info.docker },
      { id: "certbot", label: "certbot instalado", required: true, ok: info.certbot },
      {
        id: "ports",
        label: "Puertos libres",
        required: true,
        ok: info.ports.used < info.ports.total,
        detail: `${info.ports.used} de ${info.ports.total} en uso.`
      },
      {
        id: "disk",
        label: "Espacio en disco",
        required: false,
        ok: info.diskFreeMb === null || info.diskFreeMb >= MIN_DISK_MB,
        detail: info.diskFreeMb === null ? undefined : `${Math.round(info.diskFreeMb / 1024)} GB libres.`
      },
      {
        id: "preview",
        label: "Vistas previas del AI Developer",
        required: false,
        ok: Boolean(info.panelOrigin) && !loopback,
        detail: !info.panelOrigin
          ? "Falta PANEL_ORIGIN en platform.conf."
          : loopback
            ? "PANEL_UPSTREAM apunta a loopback: en un servidor sin Launchpad debe ser https://<panel>."
            : undefined
      }
    ];
  }

  /** El comodín *.<dominio> debe resolver a la IP pública (un nombre aleatorio lo demuestra). */
  private async dnsCheck(doc: ServerDoc): Promise<ServerCheck> {
    const probe = `launchpad-check-${randomBytes(4).toString("hex")}.${doc.appsDomain}`;
    const label = `DNS comodín *.${doc.appsDomain} → ${doc.publicIp}`;
    try {
      const addresses = await this.deps.resolver.resolve4(probe);
      return {
        id: "dns",
        label,
        required: true,
        ok: addresses.includes(doc.publicIp),
        detail: addresses.includes(doc.publicIp) ? undefined : `Resuelve a ${addresses.join(", ")}.`
      };
    } catch {
      return { id: "dns", label, required: true, ok: false, detail: `${probe} no resuelve: crea el registro A *.${doc.appsDomain}.` };
    }
  }

  /** Clave nueva del provisioner: hay que instalarla en el VPS y volver a verificar. */
  async rotateKey(id: string) {
    const doc = await this.load(id);
    await this.deps.servers.updateOne(
      { _id: id },
      { $set: { ...this.newKeyPair(id, doc.name), updatedAt: this.now() }, $unset: { verification: "" } }
    );
    this.adapters.delete(id);
    return this.get(id);
  }

  async remove(id: string) {
    await this.load(id);
    const projects = await this.deps.clients.countDocuments({ "server.id": id });
    if (projects) throw new ServerDirectoryError(409, `El servidor tiene ${projects} proyecto(s): bórralos antes de quitarlo.`);
    await this.deps.servers.deleteOne({ _id: id });
    this.adapters.delete(id);
  }

  /** Referencia para un proyecto nuevo: solo servidores verificados. */
  async select(id: string | undefined): Promise<ClientServerRef | undefined> {
    if (!id || id === PRIMARY_SERVER_ID) {
      if (!this.deps.primary && (await this.deps.servers.countDocuments())) {
        throw new ServerDirectoryError(400, "Elige el servidor donde se desplegará el proyecto.");
      }
      return undefined;
    }
    const doc = await this.deps.servers.findOne({ _id: id });
    if (!doc) throw new ServerDirectoryError(400, "El servidor elegido no existe.");
    if (statusOf(doc) !== "ready") throw new ServerDirectoryError(409, `El servidor ${doc.name} aún no está verificado.`);
    return { id: doc._id, name: doc.name, appsDomain: doc.appsDomain };
  }

  async target(id: string): Promise<DeployTarget> {
    if (id === PRIMARY_SERVER_ID) {
      if (!this.deps.primary) throw new FatalError("server_not_configured", "El servidor principal no está configurado.");
      return { id, name: "Principal", ...this.deps.primary };
    }
    const doc = await this.deps.servers.findOne({ _id: id });
    if (!doc) throw new FatalError("server_not_found", "El servidor del proyecto ya no existe en la plataforma.");
    if (!doc.knownHosts) throw new FatalError("server_not_ready", `El servidor ${doc.name} no tiene la huella confirmada.`);
    if (!this.deps.ghcrOrg) throw new FatalError("server_not_configured", "Falta GHCR_ORG en la plataforma.");
    return {
      id: doc._id,
      name: doc.name,
      host: doc.host,
      knownHosts: doc.knownHosts,
      publicIp: doc.publicIp,
      appsDomain: doc.appsDomain,
      ghcrOrg: this.deps.ghcrOrg,
      acmeCa: this.deps.acmeCa,
      adapter: this.adapterFor(doc)
    };
  }
}
