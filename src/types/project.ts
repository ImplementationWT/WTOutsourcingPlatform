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

/** GET /api/clients/:slug — solo referencias, nunca URI ni contraseñas. */
export interface ClientDetail {
  client: {
    id: string;
    name: string;
    description: string;
    status: "provisioning" | "ready" | "failed";
    readiness: { ready: boolean; checkedAt?: string; detail?: string };
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
