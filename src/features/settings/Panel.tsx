import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Tarjeta de la página (prototipo): borde fino, esquinas amplias y aire. */
export function Panel({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <section aria-label={label} className={cn("rounded-2xl border border-border bg-card p-6 sm:p-7", className)}>
      {children}
    </section>
  );
}
