import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Encabezado de cada pantalla: título grande, descripción corta debajo y la acción principal a la
 * derecha (en el celular, la acción queda junto al título y la descripción se oculta si es larga).
 */
export function PageHeader({
  title,
  description,
  badges,
  actions,
  stackOnMobile,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Insignias junto al título (estado, origen…). */
  badges?: ReactNode;
  actions?: ReactNode;
  /** En el celular, las acciones bajan debajo del título (títulos largos, como el de un registro). */
  stackOnMobile?: boolean;
  className?: string;
}) {
  return (
    <header className={cn("flex items-start justify-between gap-4", stackOnMobile && "max-sm:flex-col", className)}>
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-page-title break-words">{title}</h1>
          {badges && <div className="flex flex-wrap items-center gap-1.5">{badges}</div>}
        </div>
        {description && <div className="max-w-2xl text-sm text-muted-foreground sm:text-[15px] sm:leading-6">{description}</div>}
      </div>
      {actions && <div className={cn("flex shrink-0 flex-wrap items-center justify-end gap-2", stackOnMobile && "max-sm:justify-start")}>{actions}</div>}
    </header>
  );
}
