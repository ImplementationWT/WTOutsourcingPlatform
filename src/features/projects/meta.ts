import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  CreditCard,
  Database,
  GitBranch,
  Globe,
  Hourglass,
  Loader2,
  Sparkles,
  Triangle,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { AccountProvider, AccountStatus, ProjectStatus } from "@/types/project";

export const providerMeta: Record<AccountProvider, { name: string; icon: LucideIcon }> = {
  github: { name: "GitHub", icon: GitBranch },
  domain: { name: "Dominio", icon: Globe },
  mongodb: { name: "MongoDB", icon: Database },
  claude: { name: "Claude", icon: Sparkles },
  vercel: { name: "Vercel", icon: Triangle },
  aws: { name: "AWS", icon: Cloud },
  stripe: { name: "Stripe", icon: CreditCard },
};

// Los estados siempre llevan icono + texto, nunca solo color.
export const projectStatusMeta: Record<
  ProjectStatus,
  { label: string; icon: LucideIcon; className: string }
> = {
  online: { label: "Online", icon: CheckCircle2, className: "text-emerald-600 dark:text-emerald-400" },
  degraded: { label: "Degradado", icon: AlertTriangle, className: "text-amber-600 dark:text-amber-400" },
  offline: { label: "Offline", icon: XCircle, className: "text-red-600 dark:text-red-400" },
  provisioning: { label: "Aprovisionando", icon: Loader2, className: "text-sky-600 dark:text-sky-400" },
};

export const accountStatusMeta: Record<
  AccountStatus,
  { label: string; icon: LucideIcon; className: string }
> = {
  connected: { label: "Conectada", icon: CheckCircle2, className: "text-emerald-600 dark:text-emerald-400" },
  pending: { label: "Pendiente", icon: Hourglass, className: "text-sky-600 dark:text-sky-400" },
  expiring: { label: "Por vencer", icon: AlertTriangle, className: "text-amber-600 dark:text-amber-400" },
  error: { label: "Error", icon: XCircle, className: "text-red-600 dark:text-red-400" },
};
