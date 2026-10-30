import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const pillTones = {
  brand: "border-brand-400/25 bg-brand-400/10 text-brand-200",
  emerald: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
};

export function Pill({ tone = "brand", children }: { tone?: keyof typeof pillTones; children: ReactNode }) {
  return (
    <span className={cn("shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium", pillTones[tone])}>
      {children}
    </span>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-md border border-foreground/10 bg-foreground/5 px-1.5 py-0.5 font-mono text-[0.8125rem] text-foreground">
      {children}
    </code>
  );
}

/** Fila de solo lectura: icono, título, detalle y una etiqueta a la derecha. */
export function InfoRow({
  icon: Icon,
  title,
  children,
  note,
  pill,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  note?: ReactNode;
  pill?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-4 py-4 first:pt-0 last:pb-0">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-foreground/10 bg-foreground/5">
        <Icon className="size-4.5 text-foreground/90" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        <div className="mt-1 text-sm text-muted-foreground">{children}</div>
        {note && <p className="mt-1 text-xs text-muted-foreground/80">{note}</p>}
      </div>
      {pill}
    </div>
  );
}

export const fieldClass =
  "h-10 bg-foreground/[0.03] dark:bg-foreground/[0.03] border-foreground/15 focus-visible:border-brand-400/60 focus-visible:ring-brand-400/20";
