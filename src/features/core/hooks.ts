import { useQueryClient } from "@tanstack/react-query";
import { activityKeys } from "@/features/activity/api";
import { useSession } from "@/features/auth/auth";
import { DEAL_STATUSES, opsBase, opsKeys, type DealStatus } from "@/features/ops/api";
import { COMMERCIAL_DEAL_STATUSES, coreKeys, type Deal } from "./api";

/** Empresas y Contactos: escriben CEO/CCO y Comercial (§6). */
export const canWriteCore = (role?: string) => role === "boss" || role === "commercial";

/** Después de un cambio en un deal: la tabla, el detalle y los resúmenes de proyectos. */
export function useDealRefresh() {
  const queryClient = useQueryClient();
  return (projectId?: string | null) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: coreKeys.deals }),
      queryClient.invalidateQueries({ queryKey: ["core", "deal"] }),
      queryClient.invalidateQueries({ queryKey: opsKeys.allProjects }),
      ...(projectId
        ? [queryClient.invalidateQueries({ queryKey: opsKeys.project(projectId) }), queryClient.invalidateQueries({ queryKey: activityKeys.updates(opsBase(projectId)) })]
        : []),
    ]);
}

/** Estados que el usuario puede elegir: Comercial llega hasta «Propuesto». */
export function useDealStatusOptions(): readonly DealStatus[] {
  const role = useSession().data?.role;
  return role === "commercial" ? COMMERCIAL_DEAL_STATUSES : DEAL_STATUSES;
}

export const dealLocked = (deal: Pick<Deal, "status">) => deal.status === "invoiced" || deal.status === "paid";

