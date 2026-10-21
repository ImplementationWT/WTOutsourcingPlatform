import { useQuery } from "@tanstack/react-query";
import { ApiError, apiFetch } from "@/lib/api-client";

// La sesión vive en una cookie HttpOnly emitida por el backend; las contraseñas solo existen en
// el servidor.
export type UserRole = "boss" | "lead" | "developer";

export interface SessionUser {
  id: string;
  username: string;
  name: string;
  role: UserRole;
  teamId: string | null;
  /** Primer ingreso o contraseña restablecida: debe cambiarla antes de usar el panel. */
  mustChangeCredentials: boolean;
}

export const ROLE_LABELS: Record<UserRole, string> = {
  boss: "CEO/CCO",
  lead: "Team leader",
  developer: "Developer",
};

export const SESSION_KEY = ["session"] as const;

async function fetchSession(): Promise<SessionUser | null> {
  try {
    return (await apiFetch<{ user: SessionUser }>("/api/auth/me")).user;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export function useSession() {
  return useQuery({ queryKey: SESSION_KEY, queryFn: fetchSession, retry: false, staleTime: 5 * 60_000 });
}

/**
 * Todos los roles operan proyectos (crear, desplegar, AI Developer…): el CEO/CCO cualquiera; team
 * leaders y developers, los de su equipo (la API ya solo les devuelve esos).
 */
export const canOperate = (user: SessionUser | null | undefined) => Boolean(user);

/** ¿Puede el usuario de la sesión crear, desplegar, usar el AI Developer…? */
export function useCanOperate() {
  return canOperate(useSession().data);
}

export function useIsBoss() {
  return useSession().data?.role === "boss";
}

export async function login(username: string, password: string): Promise<SessionUser> {
  const { user } = await apiFetch<{ user: SessionUser }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  return user;
}

export async function changePassword(current: string, next: string): Promise<SessionUser> {
  const { user } = await apiFetch<{ user: SessionUser }>("/api/auth/password", {
    method: "POST",
    body: JSON.stringify({ current, next }),
  });
  return user;
}

export async function logout() {
  await apiFetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
}
