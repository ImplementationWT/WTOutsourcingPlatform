import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Indicador: etiqueta arriba, valor grande y una línea de apoyo. */
export function Kpi({ label, value, sub, className }: { label: string; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col justify-between gap-3 rounded-2xl border border-border bg-card p-4 shadow-card", className)}>
      <p className="text-caps-label leading-snug">{label}</p>
      <div className="space-y-1">
        <p className="text-lg font-bold tracking-tight whitespace-nowrap tabular-nums sm:text-2xl">{value}</p>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </div>
    </div>
  );
}

/** Fila de indicadores que se acomoda al ancho. */
export function KpiRow({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section aria-label={label} className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(8.5rem,1fr))]">
      {children}
    </section>
  );
}
