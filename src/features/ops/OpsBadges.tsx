import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { HEALTH_LABELS, HEALTH_TONE, PRIORITY_LABELS, PRIORITY_TONE, STAGE_LABELS, STAGES, stageAge, type Health, type Priority, type Stage, type StuckProject } from "./api";

export function HealthBadge({ value }: { value: Health }) {
  return <StatusBadge tone={HEALTH_TONE[value]}>{HEALTH_LABELS[value]}</StatusBadge>;
}

export function PriorityBadge({ value }: { value: Priority }) {
  return <StatusBadge tone={PRIORITY_TONE[value]}>{PRIORITY_LABELS[value]}</StatusBadge>;
}

export function StageBadge({ value }: { value: Stage }) {
  return <StatusBadge tone="outline">{STAGE_LABELS[value]}</StatusBadge>;
}

/** Días en la etapa contra el plazo: verde en plazo, ámbar desde el 75 % y rojo si se pasa. */
export function StageAgeBadge({ stage, since, sla }: { stage: Stage; since: string; sla: number | null }) {
  const age = stageAge(since, sla);
  const title = sla === null ? `En ${STAGE_LABELS[stage]} desde ${formatDate(since)} · sin plazo` : `En ${STAGE_LABELS[stage]} desde ${formatDate(since)} · plazo ${sla} días`;
  return (
    <StatusBadge tone={age.tone} title={title}>
      {age.text}
    </StatusBadge>
  );
}

/** Aviso de proyectos que llevan más tiempo del esperado en su etapa (los de toda la lista filtrada). */
export function StuckBanner({ projects }: { projects: StuckProject[] }) {
  if (!projects.length) return null;
  return (
    <section aria-label="Proyectos atascados" className="space-y-3 rounded-2xl border border-danger/40 bg-danger/5 p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="flex items-center gap-2 font-semibold text-danger">
          <AlertTriangle className="size-4" aria-hidden />
          {projects.length} {projects.length === 1 ? "proyecto atascado" : "proyectos atascados"}
        </p>
        <p className="text-sm text-muted-foreground">Llevan más tiempo del esperado en su etapa: los developers se quedan sin tareas y no se facturan horas.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {projects.map((p) => (
          <Link key={p.id} to={`/operativa/${p.id}?tab=stages`} className="inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-border bg-card px-3 py-1.5 text-sm transition-colors hover:bg-accent">
            <span className="font-semibold">{p.name}</span>
            <span className="whitespace-nowrap text-muted-foreground">{STAGE_LABELS[p.stage]}</span>
            <StatusBadge tone="danger">
              {p.days} d · +{p.days - (p.sla ?? 0)} d
            </StatusBadge>
          </Link>
        ))}
      </div>
    </section>
  );
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
    <ol className="flex flex-wrap gap-2" aria-label="Etapas del proyecto">
      {STAGES.map((s, i) => {
        const tone =
          i === current
            ? "border-primary/40 bg-primary/10 text-foreground"
            : i < current
              ? "border-border bg-card text-muted-foreground"
              : "border-dashed border-border text-muted-foreground/80";
        return (
          <li key={s} aria-current={i === current ? "step" : undefined}>
            {onChange ? (
              <button
                type="button"
                disabled={disabled || i === current}
                onClick={() => onChange(s)}
                className={cn("inline-flex h-9 items-center rounded-full border px-3.5 text-sm font-semibold transition-colors enabled:hover:border-primary/50 enabled:hover:text-foreground disabled:cursor-default", tone)}
              >
                {STAGE_LABELS[s]}
              </button>
            ) : (
              <span className={cn("inline-flex h-9 items-center rounded-full border px-3.5 text-sm font-semibold", tone)}>{STAGE_LABELS[s]}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
