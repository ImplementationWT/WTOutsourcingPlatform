export const STAGES = [
  { name: "github_repository", label: "Repositorio en GitHub" },
  { name: "mongodb_database", label: "Base de datos en MongoDB Atlas" },
  { name: "github_secrets", label: "Secrets del entorno production" },
  { name: "deploy", label: "Primer despliegue" },
  { name: "health_check", label: "Verificación de salud" }
] as const;

export type StageName = (typeof STAGES)[number]["name"];
export type StageStatus = "pending" | "running" | "succeeded" | "failed";
export type JobStatus = "queued" | "running" | "failed" | "succeeded";
export type ClientStatus = "provisioning" | "ready" | "failed";

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

export interface ClientDoc {
  _id: string; // slug
  name: string;
  description: string;
  status: ClientStatus;
  readiness: { ready: boolean; checkedAt?: Date; detail?: string };
  /** Versión real del template del repo (package.json → template.version) y lo que expone /api/meta. */
  template?: { name: string; version: string; verifiedAt: Date; schemaVersion?: number; schemaCheckedAt?: Date };
  initialAdmin?: InitialAdminInfo;
  latestJobId: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export type ResourceKind = "github_repository" | "mongodb_user" | "mongodb_database" | "github_environment" | "deploy";

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
  actor: string;
  action: string;
  clientId: string;
  target: string;
  details?: Record<string, string | number | boolean | string[]>;
}
