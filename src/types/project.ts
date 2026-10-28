import type { Job } from "@/features/projects/provisioning";

export type AccountProvider = "github" | "domain" | "mongodb";

export type AccountStatus = "connected" | "pending" | "expiring" | "error";

export interface LinkedAccount {
  provider: AccountProvider;
  /** Identificador visible: repo, dominio, base, etc. */
  label: string;
  status: AccountStatus;
}

/** Repositorio de GitHub tal como lo devuelve GET /api/projects. */
export interface ProjectRepo {
  id: number;
  name: string;
  fullName: string;
  description: string | null;
  url: string;
  private: boolean;
  archived: boolean;
  defaultBranch: string;
  language: string | null;
  createdAt: string | null;
  pushedAt: string | null;
  /** Topics de GitHub del repo: las etiquetas del panel. */
  topics: string[];
  /** Cliente de la plataforma asociado ({slug}-app), si existe. */
  clientId: string | null;
  clientStatus: "provisioning" | "ready" | "failed" | null;
  /** Equipo del proyecto (null: repo sin proyecto de la plataforma o proyecto sin equipo). */
  teamId?: string | null;
}

/**
 * Estado de la contraseña inicial del admin de la app (sin el valor).
 * GET /api/clients/:slug/initial-password y client.initialAdmin del detalle.
 */
export interface InitialAdminStatus {
  username: string;
  mustChangeOnFirstLogin: boolean;
  mode: "random" | "default" | null;
  state: "pending" | "default" | "available" | "revealed" | "expired" | "unavailable";
  expiresAt?: string | null;
  revealedAt?: string | null;
  revealedBy?: string | null;
}

/** POST /api/clients/:slug/initial-password/reveal — solo una vez. */
export interface RevealedCredentials {
  username: string;
  password: string;
  mustChangeOnFirstLogin: boolean;
}

/** GET /api/clients/:slug — solo referencias, nunca URI, SESSION_SECRET ni contraseñas. */
export interface ClientDetail {
  client: {
    id: string;
    name: string;
    description: string;
    status: "provisioning" | "ready" | "failed";
    readiness: { ready: boolean; checkedAt?: string; detail?: string };
    /** Versión real del template del repo y schemaVersion de /api/meta (tras el health check). */
    template: { name: string; version: string; schemaVersion: number | null } | null;
    initialAdmin: InitialAdminStatus;
    /** Despliegue en el VPS: solo referencias (nunca claves, tokens ni variables). */
    deployment: {
      appUrl: string;
      host: string | null;
      dnsVerifiedAt: string | null;
      certificate: "issued" | "existing" | null;
      https: { verifiedAt: string; trusted: boolean } | null;
      image: { digest: string | null; deployedAt: string | null } | null;
      lastRunUrl: string | null;
      redeployRequestedAt: string | null;
      redeployRequestedBy: string | null;
    };
    deployEnabled: boolean;
    /** Servidor donde se despliega (fijado al crear el proyecto). */
    server: { id: string; name: string; appsDomain: string };
    /** Equipo dueño del proyecto (null: anterior a los equipos; solo lo ven los CEO/CCO). */
    team: { id: string; name: string } | null;
    /** Estado y fechas por proveedor; nunca valores. */
    integrations: ClientIntegration[];
    /** Will Doo de la app (plantilla 1.7.0): off, basic (solo, sin IA) o claude. */
    willDoo: { mode: WillDooMode; updatedAt: string | null };
    createdAt: string;
  };
  resources: {
    repository: { fullName: string; url: string | null };
    database: string;
    databaseUser: string;
    subdomain: string;
    baseUrl: string;
  };
  job: Job | null;
}

/** GET /api/dashboard — datos reales (sin métricas inventadas). */
export type LiveStatus = "online" | "offline" | "not_deployed";

export interface DashboardProject {
  id: string;
  name: string;
  status: "provisioning" | "ready" | "failed";
  appUrl: string;
  live: LiveStatus;
  responseMs: number | null;
  templateVersion: string | null;
  schemaVersion: number | null;
  httpsVerifiedAt: string | null;
  image: { digest: string | null; deployedAt: string | null } | null;
  latestJob: { status: string; failedStage: { name: string; label: string; message: string | null } | null; finishedAt: string | null } | null;
  initialAdmin: InitialAdminStatus["state"];
  createdAt: string;
}

export interface DashboardData {
  generatedAt: string;
  deployEnabled: boolean;
  totals: { projects: number; ready: number; provisioning: number; failed: number; online: number; offline: number; deployed: number };
  lastDeployAt: string | null;
  projects: DashboardProject[];
  attention: { clientId: string; name: string; kind: "job_failed" | "offline" | "password_pending"; message: string }[];
  activity: { at: string; actor: string; actorName?: string | null; action: string; clientId: string }[];
}

/** Borrado de un proyecto (POST /delete y GET /deletion). */
export interface Deletion {
  clientId: string;
  status: "running" | "succeeded" | "failed";
  steps: { id: string; label: string; status: "pending" | "running" | "done" | "skipped" | "warning" | "failed"; detail?: string }[];
  requestedBy: string;
  startedAt: string;
  finishedAt: string | null;
  error: { code: string; message: string } | null;
}

/** GET /api/integrations/catalog — campos del formulario de cada proveedor (sin secretos). */
export interface IntegrationProvider {
  id: string;
  label: string;
  description: string;
  help: string[];
  helpUrl: string;
  fields: { name: string; label: string; type: "secret" | "text"; placeholder?: string; maxLength: number }[];
}

export type WillDooMode = "off" | "basic" | "claude";

export interface ClientIntegration {
  provider: string;
  enabled: boolean;
  configuredAt: string | null;
  updatedAt: string | null;
}

export type ValidationOutcome = { ok: true } | { ok: false; code: "auth_failed" | "timeout" | "unavailable"; error: string };
