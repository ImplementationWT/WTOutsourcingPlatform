import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/api-client";

// Propuestas (sitios HTML) publicadas en WTProposalPlatform a través de esta API (/api/sites).

export type SiteStatus = "live" | "archived" | "deleted";

export interface Site {
  id: string;
  name: string;
  url: string;
  status: SiteStatus;
  homepage: string;
  files: { path: string; size: number }[];
  totalSize: number;
  access: { mode: "public" | "password" };
  /** Certificado y servidor del subdominio en el VPS de la plataforma. */
  domain: "pending" | "ready" | "error";
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  proposalId: string | null;
  lead: { id: string; name: string } | null;
  project: { id: string; name: string } | null;
}

export interface SitesConfig {
  configured: boolean;
  sitesSuffix?: string;
  maxUploadMb?: number;
}

export interface SiteStats {
  series: { day: string; people: number; visits: number; views: number }[];
  period: { people: number; visits: number; views: number };
  allTime: { people: number; views: number };
  log: { visitor: string; start: string; end: string; pages: number; device: "mobile" | "tablet" | "desktop"; os: string; browser: string; referrer: string | null }[];
}

const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

export const sitesKeys = { all: ["sites"] as const, list: (status: SiteStatus, scope: string) => ["sites", "list", status, scope] as const };

export const useSitesConfig = () => useQuery({ queryKey: ["sites", "config"], queryFn: () => apiFetch<SitesConfig>("/api/sites/config"), staleTime: 5 * 60_000 });

/** Sitios de un estado; con `leadId` o `projectId`, solo los ligados a él. */
export function useSites(status: SiteStatus, scope: { leadId?: string; projectId?: string } = {}) {
  const qs = new URLSearchParams({ status, ...(scope.leadId ? { leadId: scope.leadId } : {}), ...(scope.projectId ? { projectId: scope.projectId } : {}) });
  return useQuery({
    queryKey: sitesKeys.list(status, qs.toString()),
    queryFn: () => apiFetch<{ items: Site[]; counts: Record<SiteStatus, number>; canWrite: boolean }>(`/api/sites?${qs}`),
  });
}

export const useSiteStats = (id: string | null, days: number) =>
  useQuery({
    queryKey: ["sites", "stats", id, days],
    enabled: Boolean(id),
    queryFn: () => apiFetch<SiteStats>(`/api/sites/${id}/stats?days=${days}&tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`),
  });

/** Subida multipart (el navegador pone el boundary): `name` + `file` o `html`; en actualizar, `mode`. */
async function upload<T>(path: string, form: FormData): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", body: form, credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "No se pudo conectar con el servidor.");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 413) throw new ApiError(413, (body as { error?: string } | null)?.error ?? "El archivo es demasiado grande.");
    throw new ApiError(res.status, (body as { error?: string } | null)?.error ?? `Error ${res.status}`, body);
  }
  return body as T;
}

export const sitesApi = {
  nameAvailability: (name: string, exceptId?: string) => apiFetch<{ available: boolean; reason?: string }>(`/api/sites/name-availability?${new URLSearchParams({ name, ...(exceptId ? { exceptId } : {}) })}`),
  create: (form: FormData, link: { leadId?: string; projectId?: string }) => upload<{ site: Site }>(`/api/sites?${new URLSearchParams(link as Record<string, string>)}`, form),
  replaceFiles: (id: string, form: FormData) => upload<Site>(`/api/sites/${id}/files`, form),
  update: (id: string, patch: { name?: string; homepage?: string; access?: { mode: "public" } | { mode: "password"; password?: string } }) => apiFetch<{ site: Site }>(`/api/sites/${id}`, json("PATCH", patch)),
  setStatus: (id: string, status: SiteStatus) => apiFetch<{ site: Site }>(`/api/sites/${id}/status`, json("POST", { status })),
  remove: (id: string) => apiFetch<{ ok: true }>(`/api/sites/${id}`, json("DELETE")),
  teamMark: () => apiFetch<{ mark: string | null }>("/api/sites/team-mark"),
  downloadUrl: (id: string) => `/api/sites/${id}/download`,
};

/** Refresca listas y detalles que muestran propuestas (sitios, lead y proyecto). */
export function useSitesRefresh() {
  const queryClient = useQueryClient();
  return () => Promise.all([queryClient.invalidateQueries({ queryKey: sitesKeys.all }), queryClient.invalidateQueries({ queryKey: ["sales"] })]);
}

/** Nombre del subdominio sugerido a partir de un texto («Manpersa SAC» → manpersa-sac). */
export const slugify = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);

export const SAMPLE_HTML = `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Propuesta</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#0f0f14;color:#fff;padding:56px 48px}h1{font-size:38px}p{color:#b8b8c4;max-width:540px;line-height:1.6}</style></head>
<body><h1>Propuesta para tu empresa</h1><p>Reemplaza este texto con el alcance, los entregables y la inversión.</p></body>
</html>
`;
