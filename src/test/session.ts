import type { QueryClient } from "@tanstack/react-query";
import { SESSION_KEY, type SessionUser } from "@/features/auth/auth";

export const LEAD: SessionUser = { id: "u-lead", username: "ana", name: "Ana", role: "lead", teamId: "t-1", mustChangeCredentials: false };
export const BOSS: SessionUser = { id: "u-boss", username: "jefe", name: "Jefa", role: "boss", teamId: null, mustChangeCredentials: false };

/** Sesión ya cargada (sin pedir /api/auth/me): por defecto, un team leader que opera. */
export function withSession(queryClient: QueryClient, user: SessionUser = LEAD) {
  queryClient.setQueryData(SESSION_KEY, user);
  return queryClient;
}
