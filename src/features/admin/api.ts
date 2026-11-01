import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { useSession, type UserRole } from "@/features/auth/auth";

export interface Team {
  id: string;
  name: string;
  /** Team Leader del equipo (se propone al crear un proyecto). */
  leadUserId?: string | null;
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
  /** Correo de trabajo: el de los Team Leaders asigna sus reuniones de Read.ai al equipo. */
  email: string | null;
  role: UserRole;
  teamId: string | null;
  active: boolean;
  mustChangeCredentials: boolean;
  locked: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

/** Equipos visibles: todos para un CEO/CCO, el propio para el resto. */
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
export const createUser = (input: { username: string; name: string; email: string | null; role: UserRole; teamId: string | null }) =>
  apiFetch<{ user: AdminUser; temporaryPassword: string }>("/api/admin/users", json("POST", input));
export const updateUser = (id: string, patch: Partial<Pick<AdminUser, "name" | "email" | "role" | "teamId" | "active">>) =>
  apiFetch<{ user: AdminUser }>(`/api/admin/users/${id}`, json("PATCH", patch));
export const resetPassword = (id: string) => apiFetch<{ temporaryPassword: string }>(`/api/admin/users/${id}/reset-password`, json("POST"));
export const createTeam = (input: { name: string }) => apiFetch<{ team: Team }>("/api/admin/teams", json("POST", input));
export const updateTeam = (id: string, patch: { name?: string; leadUserId?: string | null }) => apiFetch(`/api/admin/teams/${id}`, json("PATCH", patch));
export const moveProject = (slug: string, teamId: string | null) => apiFetch(`/api/admin/clients/${slug}/team`, json("POST", { teamId }));
