import { AlertTriangle, CheckCircle2, Database, GitBranch, Globe, Hourglass, Loader2, MinusCircle, XCircle, type LucideIcon } from "lucide-react";
import type { AccountProvider, AccountStatus, LiveStatus } from "@/types/project";

export const providerMeta: Record<AccountProvider, { name: string; icon: LucideIcon }> = {
  github: { name: "GitHub", icon: GitBranch },
  domain: { name: "Dominio", icon: Globe },
  mongodb: { name: "MongoDB", icon: Database },
};

// Los estados siempre llevan icono + texto, nunca solo color.
/** Salud en vivo de la app (GET /health/ready por HTTPS) o estado del aprovisionamiento. */
export const liveStatusMeta: Record<LiveStatus | "provisioning" | "failed", { label: string; icon: LucideIcon; className: string }> = {
  online: { label: "Online", icon: CheckCircle2, className: "text-ok-fg" },
  offline: { label: "No responde", icon: XCircle, className: "text-danger-fg" },
  not_deployed: { label: "Sin desplegar", icon: MinusCircle, className: "text-muted-foreground" },
  provisioning: { label: "Aprovisionando", icon: Loader2, className: "text-info-fg" },
  failed: { label: "Falló", icon: AlertTriangle, className: "text-warn-fg" },
};

export const accountStatusMeta: Record<
  AccountStatus,
  { label: string; icon: LucideIcon; className: string }
> = {
  connected: { label: "Conectada", icon: CheckCircle2, className: "text-ok-fg" },
  pending: { label: "Pendiente", icon: Hourglass, className: "text-info-fg" },
  expiring: { label: "Por vencer", icon: AlertTriangle, className: "text-warn-fg" },
  error: { label: "Error", icon: XCircle, className: "text-danger-fg" },
};
