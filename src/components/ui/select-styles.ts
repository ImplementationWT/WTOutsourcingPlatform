import { cn } from "@/lib/utils";

export interface SelectOption {
  value: string;
  label: string;
  /** Texto secundario debajo de la etiqueta (p. ej. el equipo o el rol). */
  description?: string;
  disabled?: boolean;
}

/** Botón del select: mismo alto que Input y Button (tokens de control). */
export const triggerClass = (size: "sm" | "default" = "default") =>
  cn(
    "group/select inline-flex w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-input bg-transparent px-2.5 text-left text-sm outline-none transition-colors select-none dark:bg-input/30",
    "hover:bg-muted/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-popup-open:border-ring",
    "disabled:pointer-events-none disabled:opacity-50 data-disabled:pointer-events-none data-disabled:opacity-50 aria-invalid:border-destructive",
    size === "sm" ? "h-control-sm" : "h-control",
  );

export const popupClass =
  "z-50 max-h-[min(22rem,var(--available-height))] min-w-[max(var(--anchor-width),10rem)] max-w-[var(--available-width)] origin-[var(--transform-origin)] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-popover outline-none transition-[scale,opacity] duration-150 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0 motion-reduce:transition-none";

export const itemClass =
  "relative grid min-h-control cursor-default grid-cols-[1rem_1fr] items-center gap-2 rounded-md py-1.5 pr-3 pl-2 text-sm outline-none select-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground data-selected:font-medium";

/** Convierte un catálogo y sus etiquetas en opciones del Select. */
export const optionsOf = <V extends string>(values: readonly V[], labels: Record<V, string> | Record<string, string>): SelectOption[] =>
  values.map((v) => ({ value: v, label: (labels as Record<string, string>)[v] ?? v }));
