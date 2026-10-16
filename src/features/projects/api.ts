import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import type { ClientDetail, DashboardData, Deletion, ProjectRepo, RevealedCredentials } from "@/types/project";

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

/** Configuración de la plataforma que manda el backend (despliegue activo y dominio de las apps). */
export function usePlatform() {
  return useQuery({
    queryKey: ["platform"],
    queryFn: () =>
      apiFetch<{
        deployEnabled: boolean;
        appBaseDomain: string;
        githubOwner: string;
        atlas: { clusterName: string; consoleUrl: string | null };
      }>("/api/platform"),
    staleTime: 5 * 60_000,
  });
}

/** Lanza de nuevo el workflow Deploy del repo del cliente (queda auditado). */
export function redeployClient(slug: string) {
  return apiFetch<{ requestedAt: string; actionsUrl: string }>(`/api/clients/${encodeURIComponent(slug)}/redeploy`, {
    method: "POST",
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

/** Panel principal con datos reales: estado, salud en vivo, atención y actividad. */
export function useDashboard() {
  return useQuery({
    queryKey: ["dashboard"],
    queryFn: () => apiFetch<DashboardData>("/api/dashboard"),
    refetchInterval: 30_000,
  });
}

/** Borra el proyecto y todo lo relacionado (irreversible). `confirm` debe ser el slug. */
export function deleteClient(slug: string, confirm: string) {
  return apiFetch<Deletion>(`/api/clients/${encodeURIComponent(slug)}/delete`, {
    method: "POST",
    body: JSON.stringify({ confirm }),
  });
}

export function fetchDeletion(slug: string) {
  return apiFetch<Deletion>(`/api/clients/${encodeURIComponent(slug)}/deletion`);
}
