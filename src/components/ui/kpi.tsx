import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Indicador: etiqueta arriba, valor grande y una línea de apoyo. */
export function Kpi({ label, value, unit, sub, className }: { label: string; value: ReactNode; /** Unidad pequeña junto al valor (prototipo): «h», «/h». */ unit?: string; sub?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col justify-between gap-3.5 rounded-[14px] border border-border bg-card p-4 transition-colors hover:border-line-strong sm:p-[18px]", className)}>
      <p className="text-caps-label leading-snug">{label}</p>
      <div className="space-y-1">
        <p className="flex items-baseline gap-1.5 text-xl font-bold tracking-tight whitespace-nowrap tabular-nums sm:text-[28px] sm:leading-tight">
          {value}
          {unit && <span className="text-sm font-medium tracking-normal text-muted-foreground">{unit}</span>}
        </p>
        {sub && <p className="font-subtitle text-xs text-muted-foreground">{sub}</p>}
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
