/**
 * Cliente de WTProposalPlatform (panel.sites.whatever.tech): esa plataforma guarda los archivos de
 * cada propuesta y la publica en <nombre>.sites.whatever.tech. Esta API la llama con su llave de
 * servidor; el navegador nunca ve la llave ni habla con ella directamente.
 */
export interface SitesClient {
  /** Llama a `path` (p. ej. /api/projects) de la plataforma y devuelve su respuesta tal cual. */
  forward(method: string, path: string, init?: { body?: BodyInit | null; headers?: Record<string, string> }): Promise<Response>;
}

export function createSitesClient({ baseUrl, key, fetchImpl = fetch }: { baseUrl: string; key: string; fetchImpl?: typeof fetch }): SitesClient {
  return {
    forward(method, path, init = {}) {
      return fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: { ...init.headers, authorization: `Bearer ${key}` },
        body: init.body ?? undefined,
        // Un cuerpo en stream (subida de archivos) se reenvía sin cargarlo en memoria.
        ...(init.body && typeof init.body === "object" && "getReader" in init.body ? { duplex: "half" } : {}),
        signal: AbortSignal.timeout(5 * 60_000)
      } as RequestInit);
    }
  };
}

/** Sitio tal como lo devuelve la plataforma (GET /api/projects). */
export interface RemoteSite {
  id: string;
  name: string;
  url: string;
  status: "live" | "archived" | "deleted";
  homepage: string;
  files: { path: string; size: number }[];
  totalSize: number;
  access: { mode: "public" | "password" };
  domain: "pending" | "ready" | "error";
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
