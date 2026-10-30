/**
 * Tonos de estado del panel: solo tokens de la paleta (ver --status-* en index.css). Fondo suave
 * y texto legible en ambos temas; `outline` para estados sin color (etapas, borradores).
 */
export const TONES = ["ok", "warn", "danger", "info", "accent", "primary", "neutral", "outline"] as const;
export type Tone = (typeof TONES)[number];

export const TONE_CLASS: Record<Tone, string> = {
  ok: "bg-ok/15 text-ok-fg",
  warn: "bg-warn/15 text-warn-fg",
  danger: "bg-danger/15 text-danger-fg",
  info: "bg-info/15 text-info-fg",
  accent: "bg-accent-2/15 text-accent-2-fg",
  primary: "bg-primary/15 text-primary",
  neutral: "bg-foreground/10 text-muted-foreground",
  outline: "border border-foreground/15 text-foreground/80",
};

/** Punto de color del tono (leyendas, barras). */
export const TONE_DOT: Record<Tone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  info: "bg-info",
  accent: "bg-accent-2",
  primary: "bg-primary",
  neutral: "bg-muted-foreground",
  outline: "bg-foreground/30",
};
