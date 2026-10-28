export const STAGES = [
  { name: "github_repository", label: "Repositorio en GitHub" },
  { name: "mongodb_database", label: "Base de datos en MongoDB Atlas" },
  { name: "github_secrets", label: "Secrets del entorno production" },
  { name: "dns_https", label: "DNS del subdominio" },
  { name: "server_prepare", label: "Preparación del servidor (HTTPS y nginx)" },
  { name: "deploy", label: "Primer despliegue" },
  { name: "health_check", label: "Verificación de salud" }
] as const;

/** Etapas de los trabajos sobre integraciones de un cliente existente (antes de deploy/health_check). */
export const INTEGRATION_STAGES = [
  { name: "integration_secret", label: "Credencial de la integración en GitHub" },
  { name: "integration_remove", label: "Quitar la integración de GitHub" }
] as const;

export type StageName = (typeof STAGES)[number]["name"] | (typeof INTEGRATION_STAGES)[number]["name"];
export type StageStatus = "pending" | "running" | "succeeded" | "failed";
export type JobStatus = "queued" | "running" | "failed" | "succeeded";
export type ClientStatus = "provisioning" | "ready" | "failed";
export type WillDooMode = "off" | "basic" | "claude";

export type SubStepStatus = "pending" | "running" | "done" | "skipped" | "failed";

/** Paso interno de una etapa, para mostrar el progreso con detalle en el panel. */
export interface SubStep {
  id: string;
  label: string;
  status: SubStepStatus;
  detail?: string;
}

export interface StageState {
  name: StageName;
  label: string;
  status: StageStatus;
  attempts: number;
  startedAt?: Date;
  finishedAt?: Date;
  durationMs?: number;
  /** Último mensaje de progreso (sin secretos). */
  detail?: string;
  /** Pasos internos (p. ej. los de MongoDB), en el orden en que se ejecutan. */
  steps?: SubStep[];
  error?: { code: string; message: string; retryable: boolean };
}

export interface JobDoc {
  _id: string;
  clientId: string;
  /** Trabajos de integración: qué proveedor y qué operación (sin credenciales). */
  integration?: { provider: string; action: "set" | "remove" };
  status: JobStatus;
  /** true mientras el trabajo está en cola o en curso; índice único parcial por cliente. */
  active: boolean;
  stages: StageState[];
  lease: { owner: string; expiresAt: Date } | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  finishedAt?: Date;
}

export type InitialAdminMode = "random" | "default";

/**
 * Estado de la contraseña inicial del admin de la app. Solo metadatos: el
 * valor nunca se guarda aquí (ver InitialPasswordVault).
 */
export interface InitialAdminInfo {
  mode: InitialAdminMode;
  /** Se escribió INITIAL_ADMIN_PASSWORD en este trabajo y quedó pendiente de revelar. */
  generatedAt?: Date;
  revealExpiresAt?: Date;
  revealedAt?: Date;
  revealedBy?: string;
  /** El secret ya existía (intento anterior) y la plataforma no conoce su valor. */
  reused?: boolean;
}

export interface IntegrationState {
  enabled: boolean;
  /** Se pidió activarla; queda pendiente hasta escribir el secret. */
  requestedAt: Date;
  /** Secret escrito en GitHub por primera vez / por última vez. */
  configuredAt?: Date;
  updatedAt?: Date;
}

export interface DeploymentInfo {
  host: string;
  dnsVerifiedAt?: Date;
  port?: number;
  certificate?: "issued" | "existing";
  preparedAt?: Date;
  /** Imagen por digest del último despliegue correcto y cuándo se hizo (según el servidor). */
  image?: string;
  deployedAt?: Date;
  lastRunUrl?: string;
  httpsVerifiedAt?: Date;
  /** false si se verificó con la CA de staging (ACME_CA): HTTPS funciona pero no es de confianza. */
  httpsTrusted?: boolean;
  redeployRequestedAt?: Date;
  redeployRequestedBy?: string;
}

export interface ClientDoc {
  _id: string; // slug
  name: string;
  description: string;
  status: ClientStatus;
  readiness: { ready: boolean; checkedAt?: Date; detail?: string };
  /** Versión real del template del repo (package.json → template.version) y lo que expone /api/meta. */
  template?: { name: string; version: string; verifiedAt: Date; schemaVersion?: number; schemaCheckedAt?: Date };
  initialAdmin?: InitialAdminInfo;
  /** Despliegue en el VPS: solo referencias (nunca claves, tokens ni variables de entorno). */
  deployment?: DeploymentInfo;
  /** Integraciones por proveedor: solo estado y fechas, nunca credenciales. */
  integrations?: Record<string, IntegrationState>;
  /**
   * Servidor donde se despliega, fijado al crearlo (nunca cambia). Sin él, el servidor
   * principal de la configuración (proyectos anteriores a los servidores múltiples).
   */
  server?: ClientServerRef;
  /**
   * Equipo al que pertenece (obligatorio en los proyectos nuevos). Los anteriores a los equipos
   * no lo tienen: solo los ven los jefes hasta que lo asignen.
   */
  /**
   * Will Doo de la app (plantilla 1.7.0): off, basic («Will Doo solo», sin IA) o claude (con la
   * clave de Anthropic del cliente). Sin el campo, la app usa basic.
   */
  willDoo?: { mode: WillDooMode; updatedAt: Date; updatedBy: string };
  teamId?: string | null;
  latestJobId: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Servidor del proyecto: id y, copiados al crearlo, nombre y dominio de apps. */
export interface ClientServerRef {
  id: string;
  name: string;
  appsDomain: string;
}

/**
 * Servidor de despliegue dado de alta desde el panel. La clave privada del provisioner
 * se genera aquí y solo se guarda cifrada (AES-256-GCM, ligada al id del servidor).
 */
export interface ServerDoc {
  _id: string; // uuid
  name: string;
  /** Host SSH (el DEPLOY_HOST que se escribe en los repos). */
  host: string;
  sshPort: number;
  /** Dominio de apps: https://<slug>.<appsDomain>; su comodín *.<appsDomain> apunta a publicIp. */
  appsDomain: string;
  publicIp: string;
  provisionerPublicKey: string;
  provisionerKey: { iv: string; ciphertext: string; tag: string };
  /** Huella fijada tras confirmarla con la consola del VPS (línea known_hosts). */
  knownHosts?: string;
  hostKeyFingerprint?: string;
  verification?: ServerVerification;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ServerCheck {
  id: string;
  label: string;
  ok: boolean;
  /** Si falla, ¿impide usar el servidor? (las vistas previas, por ejemplo, son opcionales). */
  required: boolean;
  detail?: string;
}

export interface ServerVerification {
  at: Date;
  ok: boolean;
  checks: ServerCheck[];
  error?: string;
}

export type ResourceKind =
  | "github_repository"
  | "mongodb_user"
  | "mongodb_database"
  | "github_environment"
  | "server_client"
  | "deploy";

/**
 * Referencias a recursos externos. Solo nombres e identificadores: nunca
 * contraseñas, URIs ni tokens (AdminStore lo verifica antes de escribir).
 */
export interface ResourceDoc {
  _id: string; // `${kind}:${name}`
  kind: ResourceKind;
  name: string;
  clientId: string;
  ref: Record<string, string | number | boolean | string[] | null>;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditDoc {
  at: Date;
  /** Usuario (username) o "sistema". */
  actor: string;
  /** Nombre real y equipo del actor en el momento del evento (los añade AdminStore.audit). */
  actorName?: string;
  actorTeamId?: string | null;
  action: string;
  clientId: string;
  target: string;
  details?: Record<string, string | number | boolean | string[]>;
}

// ---- usuarios y equipos ------------------------------------------------------

/** boss (jefe): solo lectura de todo. lead (team leader) y developer: operan los proyectos de su equipo. */
export type UserRole = "boss" | "lead" | "developer";

export interface UserDoc {
  _id: string; // uuid
  /** Único, en minúsculas. */
  username: string;
  name: string;
  role: UserRole;
  /** Equipo (null para los jefes). */
  teamId: string | null;
  /** scrypt (auth/password.ts). Nunca sale de la API. */
  passwordHash: string;
  /** Debe cambiarla en el próximo ingreso (alta o restablecimiento). */
  mustChangePassword: boolean;
  active: boolean;
  /** Intentos fallidos seguidos y bloqueo temporal (sobreviven a reinicios). */
  failedLogins: number;
  lockedUntil?: Date;
  lastLoginAt?: Date;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TeamDoc {
  _id: string; // uuid
  name: string;
  leadUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type DeletionStepStatus = "pending" | "running" | "done" | "skipped" | "warning" | "failed";

/** Paso del borrado de un cliente (sin secretos: solo nombres y resultados). */
export interface DeletionStep {
  id: string;
  label: string;
  status: DeletionStepStatus;
  detail?: string;
}

export interface DeletionDoc {
  _id: string; // slug
  status: "running" | "succeeded" | "failed";
  steps: DeletionStep[];
  requestedBy: string;
  /** Equipo del proyecto al pedir el borrado (para reintentarlo aunque el proyecto ya no exista). */
  teamId?: string | null;
  startedAt: Date;
  finishedAt?: Date;
  error?: { code: string; message: string };
}

// ---- AI Developer ------------------------------------------------------------

export type AiSessionStatus = "active" | "merged" | "closed";

/** Una sesión del AI Developer sobre el repo de un cliente (sin secretos ni transcripción). */
export interface AiSessionDoc {
  _id: string; // uuid
  clientId: string;
  title: string;
  status: AiSessionStatus;
  /** Sesión de Claude Managed Agents y recurso del repo montado (para renovar su token). */
  agentSessionId: string;
  repoResourceId: string;
  repository: string;
  branch: string;
  baseBranch: string;
  /** Commit de main del que partió la rama. */
  baseSha: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt?: Date;
  /** El contexto de la sesión ya acompañó a un mensaje (va con el primero). */
  contextSent?: boolean;
  pullRequest?: { number: number; url: string; createdAt: Date; createdBy: string };
  merge?: { sha: string; at: Date; by: string };
  closedAt?: Date;
  closedBy?: string;
  /** Vista previa de la rama en preview-<slug>.<dominio> (una por proyecto a la vez). */
  preview?: AiPreviewState;
  /** Quién la abrió y de qué equipo era el proyecto entonces (para los costos). */
  startedByUserId?: string | null;
  /** Nombre real de quien la abrió (para el contexto del agente). */
  createdByName?: string | null;
  teamId?: string | null;
  /**
   * Gasto del agente (Claude) en centavos de USD. Es el PRECIO DE LISTA que informa Anthropic
   * (session.usage.list_cost), no la factura real: descuentos o créditos no se reflejan.
   * Solo crece: se guarda el máximo visto (los eventos de coste son acumulados).
   */
  costCents?: number;
  budgetCents?: number | null;
  lastCostAt?: Date;
  /** Borrada del panel: deja de listarse, pero su coste sigue contando. */
  deletedAt?: Date;
  deletedBy?: string;
}

export type AiPreviewStatus = "installing" | "building" | "ready" | "failed" | "stopped";

export interface AiPreviewState {
  status: AiPreviewStatus;
  host: string;
  /** Commit de la rama que se está construyendo o se muestra. */
  sha: string | null;
  requestedAt: Date;
  requestedBy: string;
  /** "live": clon de la rama en modo desarrollo (desde la plantilla 1.6.0). */
  mode?: "live";
  /** Anteriores a la vista en vivo (construidas en GitHub Actions). */
  runId?: number;
  runUrl?: string;
  readyAt?: Date;
  /** Trayendo el último commit de la rama (vista en vivo). */
  updating?: boolean;
  updatedAt?: Date;
  updateError?: string;
  updateFailedSha?: string;
  updateFailedAt?: Date;
  stopReason?: "manual" | "expired" | "merged" | "closed";
  /** Se apaga sola tras este momento si nadie la abre (se alarga con cada visita). */
  expiresAt?: Date;
  stoppedAt?: Date;
  error?: string;
}
