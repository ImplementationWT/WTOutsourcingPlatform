import type { AtlasAdapter } from "../adapters/atlas.js";
import type { GithubAdapter } from "../adapters/github.js";
import type { HttpProbe } from "../adapters/http-probe.js";
import type { MongoBootstrapAdapter } from "../adapters/mongo-bootstrap.js";
import type { ClientNames } from "../domain/naming.js";
import type { AdminStore } from "../store/admin-store.js";
import type { InitialPasswordVault } from "../store/initial-password-vault.js";
import type { ClientDoc, InitialAdminMode, StageName, SubStepStatus } from "../store/models.js";

export interface DeployTargetConfig {
  host: string;
  user: string;
  privateKey: string;
  knownHosts: string;
  port?: number;
}

export interface ProvisioningConfig {
  appsDomain: string;
  atlas: { clusterName: string; srvHost: string };
  /** Del contrato del template (§1, §3, §4, §7). */
  template: {
    name: string;
    environment: string;
    deployWorkflow: string;
    ref: string;
    schemaVersion: number;
    /** TEMPLATE_VERSION: template.version exacta que deben tener los repos generados. */
    expectedVersion: string;
    /** MIN_SCHEMA_VERSION: schemaVersion mínima que debe devolver /api/meta. */
    minSchemaVersion: number;
  };
  /** INITIAL_ADMIN_MODE y cuánto tiempo puede revelarse la contraseña generada. */
  initialAdmin: { mode: InitialAdminMode; revealTtlMs: number };
  /**
   * Fase 2 (despliegue + health check). Con false el trabajo termina tras
   * escribir los secrets: repo creado y conectado a su base.
   */
  deployEnabled: boolean;
  /** Secrets SSH compartidos (decisión temporal: una clave para todos los repos). */
  deploy?: DeployTargetConfig;
}

/** Tiempos de espera/polling; los tests los reducen a milisegundos. */
export interface Timing {
  stageAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  leaseTtlMs: number;
  repoContentTimeoutMs: number;
  mongoAuthTimeoutMs: number;
  workflowAvailableTimeoutMs: number;
  runAppearTimeoutMs: number;
  runCompleteTimeoutMs: number;
  healthTimeoutMs: number;
  pollIntervalMs: number;
}

export const DEFAULT_TIMING: Timing = {
  stageAttempts: 5,
  backoffBaseMs: 2_000,
  backoffMaxMs: 30_000,
  leaseTtlMs: 120_000,
  repoContentTimeoutMs: 90_000,
  mongoAuthTimeoutMs: 180_000,
  workflowAvailableTimeoutMs: 120_000,
  runAppearTimeoutMs: 60_000,
  runCompleteTimeoutMs: 25 * 60_000,
  // El primer arranque de la app ejecuta las migraciones antes de responder ready.
  healthTimeoutMs: 10 * 60_000,
  pollIntervalMs: 5_000
};

export interface Deps {
  atlas: AtlasAdapter;
  github: GithubAdapter;
  mongo: MongoBootstrapAdapter;
  probe: HttpProbe;
  vault: InitialPasswordVault;
  config: ProvisioningConfig;
  timing: Timing;
  sleep?: (ms: number) => Promise<void>;
  /** Generador de contraseñas (inyectable para tests). */
  generatePassword?: () => string;
  /** Generadores de SESSION_SECRET e INITIAL_ADMIN_PASSWORD (inyectables para tests). */
  generateSessionSecret?: () => string;
  generateInitialAdminPassword?: () => string;
}

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** Estado que vive SOLO en memoria durante una ejecución del trabajo. */
export interface JobMemory {
  credential?: { password: string; version: number };
  /** INITIAL_ADMIN_PASSWORD recién generada; se descarta al terminar la etapa. */
  initialAdminPassword?: string;
}

export interface StageContext {
  client: ClientDoc;
  names: ClientNames;
  deps: Deps;
  store: AdminStore;
  memory: JobMemory;
  actor: string;
  log: Logger;
  /** Mensaje de progreso visible en el panel (se redacta). */
  report(detail: string): Promise<void>;
  /** Declara los pasos internos de la etapa (todos pendientes). */
  plan(steps: { id: string; label: string }[]): Promise<void>;
  /** Actualiza un paso declarado con `plan`; si no existe en esta etapa no hace nada. */
  step(id: string, status: SubStepStatus, detail?: string): Promise<void>;
  audit(action: string, target: string, details?: Record<string, string | number | boolean | string[]>): Promise<void>;
}

export interface Stage {
  name: StageName;
  /** reconcile + apply: consulta el estado real y solo crea lo que falte. */
  run(ctx: StageContext): Promise<void>;
}
