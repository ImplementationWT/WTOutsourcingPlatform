import { cn } from "@/lib/utils";
import { HEALTH_LABELS, HEALTH_TONE, PRIORITY_LABELS, PRIORITY_TONE, STAGE_LABELS, STAGES, type Health, type Priority, type Stage } from "./api";

const pill = "inline-flex h-5 items-center rounded-full px-2 text-xs font-medium whitespace-nowrap";

export function HealthBadge({ value }: { value: Health }) {
  return <span className={cn(pill, HEALTH_TONE[value])}>{HEALTH_LABELS[value]}</span>;
}

export function PriorityBadge({ value }: { value: Priority }) {
  return <span className={cn(pill, PRIORITY_TONE[value])}>{PRIORITY_LABELS[value]}</span>;
}

export function StageBadge({ value }: { value: Stage }) {
  return <span className={cn(pill, "border border-foreground/15 text-foreground/80")}>{STAGE_LABELS[value]}</span>;
}

/** Sentimiento de 0 a 100: barra fina con el número al lado. */
export function SentimentBar({ value }: { value: number }) {
  const tone = value >= 70 ? "bg-emerald-500" : value >= 40 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2" title={`Sentiment score: ${value}/100`}>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-foreground/10">
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">{value}</span>
    </div>
  );
}

/** Recorrido por las etapas del proyecto; la actual resaltada y las anteriores marcadas. */
export function StageTrack({ stage }: { stage: Stage }) {
  const current = STAGES.indexOf(stage);
  return (
    <ol className="flex flex-wrap gap-1.5" aria-label="Etapas del proyecto">
      {STAGES.map((s, i) => (
        <li
          key={s}
          aria-current={i === current ? "step" : undefined}
          className={cn(
            "rounded-md border px-2 py-1 text-xs",
            i === current ? "border-primary bg-primary/10 font-medium text-foreground" : i < current ? "border-foreground/10 text-muted-foreground" : "border-dashed border-foreground/15 text-muted-foreground/70",
          )}
        >
          {STAGE_LABELS[s]}
        </li>
      ))}
    </ol>
  );
}
