import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import type { DeployServer, NewServerInput, ServersResponse } from "@/types/server";

const serverUrl = (id: string, path = "") => `/api/servers/${encodeURIComponent(id)}${path}`;
const post = <T>(url: string, body?: unknown) =>
  apiFetch<T>(url, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export function useServers() {
  return useQuery({ queryKey: ["servers"], queryFn: () => apiFetch<ServersResponse>("/api/servers") });
}

export const createServer = (input: NewServerInput) => post<{ server: DeployServer }>("/api/servers", input);
export const readFingerprint = (id: string) => post<{ fingerprint: string }>(serverUrl(id, "/fingerprint"));
export const pinHostKey = (id: string, consoleOutput: string) => post<{ server: DeployServer }>(serverUrl(id, "/host-key"), { consoleOutput });
export const verifyServer = (id: string) => post<{ server: DeployServer }>(serverUrl(id, "/verify"));
export const rotateServerKey = (id: string) => post<{ server: DeployServer }>(serverUrl(id, "/rotate-key"));
export const deleteServer = (id: string, confirm: string) => post<{ ok: true }>(serverUrl(id, "/delete"), { confirm });
