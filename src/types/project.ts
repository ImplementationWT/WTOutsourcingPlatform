import type { Job } from "@/features/projects/provisioning";

export type ProjectStatus = "online" | "degraded" | "offline" | "provisioning";

export type AccountProvider =
  | "github"
  | "domain"
  | "mongodb"
  | "claude"
  | "vercel"
  | "aws"
  | "stripe";

export type AccountStatus = "connected" | "pending" | "expiring" | "error";

export interface LinkedAccount {
  provider: AccountProvider;
  /** Identificador visible: repo, dominio, cluster, workspace, etc. */
  label: string;
  status: AccountStatus;
}

export interface ProjectMetrics {
  uptime: number;
  requestsPerDay: number;
  avgResponseMs: number;
  monthlyCost: number;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  url: string;
  environment: "production" | "staging";
  status: ProjectStatus;
  createdAt: string;
  accounts: LinkedAccount[];
  metrics: ProjectMetrics;
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
  /** Cliente de la plataforma asociado ({slug}-app), si existe. */
  clientId: string | null;
  clientStatus: "provisioning" | "ready" | "failed" | null;
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
