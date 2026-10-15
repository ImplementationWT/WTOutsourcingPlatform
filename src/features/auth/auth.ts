import { useQuery } from "@tanstack/react-query";
import { ApiError, apiFetch } from "@/lib/api-client";

// La sesión vive en una cookie HttpOnly emitida por el backend; las
// credenciales del administrador solo existen en el servidor.
export interface SessionUser {
  username: string;
  role: "admin";
}

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

export async function login(username: string, password: string): Promise<SessionUser> {
  const { user } = await apiFetch<{ user: SessionUser }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  return user;
}

export async function logout() {
  await apiFetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
}
