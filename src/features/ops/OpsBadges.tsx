import { StatusBadge } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";
import { HEALTH_LABELS, HEALTH_TONE, PRIORITY_LABELS, PRIORITY_TONE, STAGE_LABELS, STAGES, type Health, type Priority, type Stage } from "./api";

export function HealthBadge({ value }: { value: Health }) {
  return <StatusBadge tone={HEALTH_TONE[value]}>{HEALTH_LABELS[value]}</StatusBadge>;
}

export function PriorityBadge({ value }: { value: Priority }) {
  return <StatusBadge tone={PRIORITY_TONE[value]}>{PRIORITY_LABELS[value]}</StatusBadge>;
}

export function StageBadge({ value }: { value: Stage }) {
  return <StatusBadge tone="outline">{STAGE_LABELS[value]}</StatusBadge>;
}

/** Sentimiento de 0 a 100: barra fina con el número al lado. */
export function SentimentBar({ value }: { value: number }) {
  const tone = value >= 70 ? "bg-ok" : value >= 40 ? "bg-warn" : "bg-danger";
  return (
    <div className="flex items-center gap-2" title={`Sentiment score: ${value}/100`}>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-foreground/10">
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">{value}</span>
    </div>
  );
}

/**
 * Recorrido por las etapas; la actual resaltada y las anteriores marcadas. Con `onChange` cada
 * etapa es un botón (CEO/CCO y Team Leader); sin él, solo se muestra.
 */
export function StageTrack({ stage, onChange, disabled }: { stage: Stage; onChange?: (stage: Stage) => void; disabled?: boolean }) {
  const current = STAGES.indexOf(stage);
  return (
    <ol className="flex flex-wrap gap-1.5" aria-label="Etapas del proyecto">
      {STAGES.map((s, i) => {
        const tone =
          i === current
            ? "border-primary bg-primary/10 font-medium text-foreground"
            : i < current
              ? "border-foreground/15 text-muted-foreground"
              : "border-dashed border-foreground/15 text-muted-foreground/80";
        return (
          <li key={s} aria-current={i === current ? "step" : undefined}>
            {onChange ? (
              <button
                type="button"
                disabled={disabled || i === current}
                onClick={() => onChange(s)}
                className={cn("rounded-md border px-2.5 py-1 text-xs transition-colors enabled:hover:border-primary/60 enabled:hover:text-foreground disabled:cursor-default", tone)}
              >
                {STAGE_LABELS[s]}
              </button>
            ) : (
              <span className={cn("block rounded-md border px-2.5 py-1 text-xs", tone)}>{STAGE_LABELS[s]}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
