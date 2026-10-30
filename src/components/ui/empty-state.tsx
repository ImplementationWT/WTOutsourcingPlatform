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
    <div className={cn("flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-foreground/15 px-6 py-10 text-center", className)}>
      <div aria-hidden className="relative flex size-16 items-center justify-center">
        <span className="absolute inset-0 rounded-full bg-primary/10" />
        <span className="absolute inset-2.5 rounded-full bg-primary/15" />
        <Icon className="relative size-6 text-primary" />
      </div>
      <div className="max-w-sm space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}
