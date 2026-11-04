import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/features/auth/auth";
import { apiFetch } from "@/lib/api-client";
import { canAccess } from "@/lib/access";

/** Contadores del menú: tareas sin sprint (Backlog / Sprints). */
export function useNavBadges(): Record<"backlog", number> {
  const role = useSession().data?.role;
  const backlog = useQuery({
    queryKey: ["tasks", "backlog-count"],
    queryFn: () => apiFetch<{ count: number }>("/api/tasks/backlog-count"),
    enabled: canAccess(role, "backlog"),
    staleTime: 30_000,
  });
  return { backlog: backlog.data?.count ?? 0 };
}
