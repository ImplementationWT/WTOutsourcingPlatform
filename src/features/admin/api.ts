import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { useSession, type UserRole } from "@/features/auth/auth";

export interface Team {
  id: string;
  name: string;
}

export interface AdminTeam extends Team {
  leadUserId: string | null;
  projects: number;
  createdAt: string;
}

export interface AdminUser {
  id: string;
  username: string;
  name: string;
  role: UserRole;
  teamId: string | null;
  active: boolean;
  mustChangeCredentials: boolean;
  locked: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

/** Equipos visibles: todos para un jefe, el propio para el resto. */
export function useTeams() {
  const enabled = Boolean(useSession().data);
  return useQuery({
    queryKey: ["teams"],
    queryFn: async () => (await apiFetch<{ teams: Team[] }>("/api/teams")).teams,
    enabled,
    staleTime: 60_000,
  });
}

export const ADMIN_USERS_KEY = ["admin", "users"] as const;
export const ADMIN_TEAMS_KEY = ["admin", "teams"] as const;

export function useAdminUsers() {
  return useQuery({ queryKey: ADMIN_USERS_KEY, queryFn: async () => (await apiFetch<{ users: AdminUser[] }>("/api/admin/users")).users });
}

export function useAdminTeams() {
  return useQuery({ queryKey: ADMIN_TEAMS_KEY, queryFn: async () => (await apiFetch<{ teams: AdminTeam[] }>("/api/admin/teams")).teams });
}

const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

/** Alta: la contraseña temporal se devuelve una sola vez. */
export const createUser = (input: { username: string; name: string; role: UserRole; teamId: string | null }) =>
  apiFetch<{ user: AdminUser; temporaryPassword: string }>("/api/admin/users", json("POST", input));
export const updateUser = (id: string, patch: Partial<Pick<AdminUser, "name" | "role" | "teamId" | "active">>) =>
  apiFetch<{ user: AdminUser }>(`/api/admin/users/${id}`, json("PATCH", patch));
export const resetPassword = (id: string) => apiFetch<{ temporaryPassword: string }>(`/api/admin/users/${id}/reset-password`, json("POST"));
export const createTeam = (input: { name: string }) => apiFetch<{ team: Team }>("/api/admin/teams", json("POST", input));
export const updateTeam = (id: string, patch: { name?: string; leadUserId?: string | null }) => apiFetch(`/api/admin/teams/${id}`, json("PATCH", patch));
export const moveProject = (slug: string, teamId: string | null) => apiFetch(`/api/admin/clients/${slug}/team`, json("POST", { teamId }));

// ---- equipo elegido por un jefe (selector de la cabecera) ---------------------------------

const TEAM_FILTER_KEY = "forge.team-filter";
const listeners = new Set<() => void>();

function readTeamFilter(): string | null {
  try {
    return window.localStorage.getItem(TEAM_FILTER_KEY);
  } catch {
    return null;
  }
}

let teamFilter = typeof window === "undefined" ? null : readTeamFilter();

export function setTeamFilter(value: string | null) {
  teamFilter = value;
  try {
    if (value) window.localStorage.setItem(TEAM_FILTER_KEY, value);
    else window.localStorage.removeItem(TEAM_FILTER_KEY);
  } catch {
    // sin almacenamiento: se queda en memoria
  }
  for (const listener of listeners) listener();
}

/** Equipo que filtra el panel (solo jefes; null = todos). Para el resto siempre null. */
export function useTeamFilter() {
  const isBoss = useSession().data?.role === "boss";
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => teamFilter,
    () => null,
  );
  return isBoss ? value : null;
}

/** Añade ?teamId= a una ruta de la API si un jefe eligió equipo. */
export function withTeam(path: string, teamId: string | null) {
  if (!teamId) return path;
  return `${path}${path.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(teamId)}`;
}
