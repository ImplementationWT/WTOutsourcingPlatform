/**
 * Gráficos del panel en HTML/SVG con los tokens `--viz-*` (validados en claro y oscuro con el
 * validador de dataviz). Orden fijo de colores: el color sigue a la entidad, nunca a su posición.
 * Cada gráfico trae tooltip al pasar el mouse (solo CSS, no se queda pegado) y vista de tabla.
 */
export const VIZ = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)", "var(--viz-4)", "var(--viz-5)"] as const;
/** Color fijo de una entidad según su posición en la lista completa (no en la filtrada). Más de 5 no se cicla: va a «Otros». */
export const vizColor = (index: number) => VIZ[index] ?? OTHER_COLOR;
export const OTHER_COLOR = "var(--muted-foreground)";
/** Máximo de series con color propio; el resto se agrupa en «Otros». */
export const MAX_SERIES = VIZ.length;


/** Color CSS de un tono de estado (para estados: tareas, stages), nunca para series. */
export const TONE_VAR: Record<"ok" | "warn" | "danger" | "info" | "accent" | "primary" | "neutral" | "outline", string> = {
  ok: "var(--status-ok)",
  warn: "var(--status-warn)",
  danger: "var(--status-danger)",
  info: "var(--status-info)",
  accent: "var(--status-accent)",
  primary: "var(--primary)",
  neutral: "var(--muted-foreground)",
  outline: "var(--muted-foreground)",
};
