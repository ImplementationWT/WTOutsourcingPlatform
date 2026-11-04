import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useSession } from "@/features/auth/auth";
import { canAccess, type ModuleId } from "@/lib/access";

/** Muestra la pantalla solo a los roles del módulo (MODULE_ACCESS); al resto lo lleva al inicio. */
export function RequireModule({ module, children }: { module: ModuleId; children: ReactNode }) {
  const role = useSession().data?.role;
  if (!role) return null;
  return canAccess(role, module) ? <>{children}</> : <Navigate to="/" replace />;
}
