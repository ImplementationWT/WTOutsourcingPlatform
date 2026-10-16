import type { ProjectRepo } from "@/types/project";

export type Origin = "all" | "platform" | "other";
export type ClientStatusFilter = NonNullable<ProjectRepo["clientStatus"]>;

/** Filtros de la página de Proyectos; viven en la URL para poder compartirlos. */
export interface ProjectFilters {
  q: string;
  origin: Origin;
  status: ClientStatusFilter | null;
  /** El proyecto debe tener todas estas etiquetas. */
  tags: string[];
  hideArchived: boolean;
}

const ORIGINS: Origin[] = ["all", "platform", "other"];
const STATUSES: ClientStatusFilter[] = ["ready", "provisioning", "failed"];

export function readFilters(params: URLSearchParams): ProjectFilters {
  const origin = params.get("origen") as Origin | null;
  const status = params.get("estado") as ClientStatusFilter | null;
  return {
    q: params.get("q") ?? "",
    origin: origin && ORIGINS.includes(origin) ? origin : "all",
    status: status && STATUSES.includes(status) ? status : null,
    tags: (params.get("etiquetas") ?? "").split(",").filter(Boolean),
    hideArchived: params.get("archivados") === "ocultar",
  };
}

export function writeFilters(filters: ProjectFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.origin !== "all") params.set("origen", filters.origin);
  if (filters.status) params.set("estado", filters.status);
  if (filters.tags.length) params.set("etiquetas", filters.tags.join(","));
  if (filters.hideArchived) params.set("archivados", "ocultar");
  return params;
}

export const hasActiveFilters = (f: ProjectFilters) =>
  Boolean(f.q || f.origin !== "all" || f.status || f.tags.length || f.hideArchived);

export function applyFilters(projects: ProjectRepo[], f: ProjectFilters): ProjectRepo[] {
  const query = f.q.trim().toLowerCase();
  return projects.filter((repo) => {
    if (f.hideArchived && repo.archived) return false;
    if (f.origin === "platform" && !repo.clientId) return false;
    if (f.origin === "other" && repo.clientId) return false;
    if (f.status && repo.clientStatus !== f.status) return false;
    if (!f.tags.every((tag) => repo.topics.includes(tag))) return false;
    if (!query) return true;
    return [repo.name, repo.description ?? "", ...repo.topics].some((text) => text.toLowerCase().includes(query));
  });
}

/** Todas las etiquetas en uso, de la más a la menos frecuente. */
export function tagCounts(projects: ProjectRepo[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const repo of projects) for (const tag of repo.topics) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Convierte lo que escribe el usuario al formato de GitHub: "Cliente X" → "cliente-x". */
export function normalizeTag(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}
