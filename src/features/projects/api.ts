import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import type { ClientDetail, Project, ProjectRepo, RevealedCredentials } from "@/types/project";
import { mockProjects } from "./data";

/** Lo único que el navegador envía; el resto lo deriva el backend del slug. */
export interface NewProjectInput {
  name: string;
  slug: string;
  description: string;
}

async function fetchProjects(): Promise<ProjectRepo[]> {
  return (await apiFetch<{ projects: ProjectRepo[] }>("/api/projects")).projects;
}

export function useClient(slug: string) {
  return useQuery({
    queryKey: ["client", slug],
    queryFn: () => apiFetch<ClientDetail>(`/api/clients/${encodeURIComponent(slug)}`),
    retry: false,
  });
}

/** Revelación única de la contraseña inicial: el servidor la borra al entregarla. */
export function revealInitialPassword(slug: string) {
  return apiFetch<RevealedCredentials>(`/api/clients/${encodeURIComponent(slug)}/initial-password/reveal`, {
    method: "POST",
  });
}

/** Proyectos reales: repos de GitHub de la organización (sin internos AB/WT). */
export function useProjects() {
  return useQuery({ queryKey: ["projects"], queryFn: fetchProjects });
}

// El dashboard sigue con métricas de ejemplo hasta tener una fuente real
// (uptime, tráfico y costos no salen de GitHub).
async function fetchDemoProjects(): Promise<Project[]> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return mockProjects;
}

export function useDemoProjects() {
  return useQuery({ queryKey: ["demo-projects"], queryFn: fetchDemoProjects });
}
