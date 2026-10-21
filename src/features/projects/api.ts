import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { useTeamFilter, withTeam } from "@/features/admin/api";
import type {
  ClientDetail,
  DashboardData,
  Deletion,
  IntegrationProvider,
  ProjectRepo,
  RevealedCredentials,
  ValidationOutcome,
} from "@/types/project";

/** Lo único que el navegador envía; el resto lo deriva el backend del slug. */
export interface NewProjectInput {
  name: string;
  slug: string;
  description: string;
  /** Solo las integraciones activadas, con sus credenciales (viajan una vez, por HTTPS). */
  integrations?: Record<string, Record<string, string>>;
  /** Servidor donde se desplegará (no cambia nunca). */
  serverId?: string;
}

async function fetchProjects(teamId: string | null): Promise<ProjectRepo[]> {
  return (await apiFetch<{ projects: ProjectRepo[] }>(withTeam("/api/projects", teamId))).projects;
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
        templateVersion: string;
        integrationsAvailable: boolean;
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
  // Solo los del equipo del usuario; un jefe ve todos o los del equipo que elija.
  const teamId = useTeamFilter();
  return useQuery({ queryKey: ["projects", teamId], queryFn: () => fetchProjects(teamId) });
}

/** Reemplaza las etiquetas (topics de GitHub) de un proyecto. */
export function updateProjectTopics(name: string, topics: string[]) {
  return apiFetch<{ topics: string[] }>(`/api/projects/${encodeURIComponent(name)}/topics`, {
    method: "PUT",
    body: JSON.stringify({ topics }),
  });
}

/** Catálogo de integraciones (sin secretos: solo cómo pintar el formulario). */
export function useIntegrationCatalog() {
  return useQuery({
    queryKey: ["integration-catalog"],
    queryFn: () => apiFetch<{ providers: IntegrationProvider[]; available: boolean }>("/api/integrations/catalog"),
    staleTime: 10 * 60_000,
  });
}

/*
 * Las llamadas con credenciales son funciones simples (no useMutation ni useQuery):
 * así las credenciales no quedan en la caché de react-query.
 */
export function validateIntegration(provider: string, credentials: Record<string, string>) {
  return apiFetch<ValidationOutcome>(`/api/integrations/${encodeURIComponent(provider)}/validate`, {
    method: "POST",
    body: JSON.stringify(credentials),
  });
}

export function saveIntegration(slug: string, provider: string, credentials: Record<string, string>) {
  return apiFetch<{ action: "redeploy" | "write" | "stored" | "written"; jobId?: string; message?: string }>(
    `/api/clients/${encodeURIComponent(slug)}/integrations/${encodeURIComponent(provider)}`,
    { method: "PUT", body: JSON.stringify(credentials) },
  );
}

export function removeIntegration(slug: string, provider: string) {
  return apiFetch<{ action: string; jobId: string }>(
    `/api/clients/${encodeURIComponent(slug)}/integrations/${encodeURIComponent(provider)}`,
    { method: "DELETE" },
  );
}

/** Panel principal con datos reales: estado, salud en vivo, atención y actividad. */
export function useDashboard() {
  const teamId = useTeamFilter();
  return useQuery({
    queryKey: ["dashboard", teamId],
    queryFn: () => apiFetch<DashboardData>(withTeam("/api/dashboard", teamId)),
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
