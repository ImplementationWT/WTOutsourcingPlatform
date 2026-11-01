import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Inbox } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Estado vacío: ilustración sencilla (icono sobre círculos con los tonos de la paleta), texto y
 * la acción para empezar.
 */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 rounded-xl px-6 py-12 text-center", className)}>
      <div aria-hidden className="flex size-10 items-center justify-center rounded-xl border border-border bg-muted/60">
        <Icon className="size-4.5 text-muted-foreground" />
      </div>
      <div className="max-w-sm space-y-1">
        <p className="text-sm font-semibold">{title}</p>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}
