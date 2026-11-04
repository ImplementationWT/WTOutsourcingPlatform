import { Link } from "react-router-dom";
import { AlertTriangle, Check } from "lucide-react";
import { Chip, type ChipColor } from "@/components/ui/chip";
import type { Tone } from "@/components/ui/tones";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { HEALTH_CHIP, HEALTH_LABELS, PRIORITY_CHIP, PRIORITY_LABELS, STAGE_LABELS, STAGES, stageAge, stageStyle, type Health, type Priority, type Stage, type StuckProject } from "./api";

/** Tono de un estado (en plazo, cerca, atrasado) como color de chip. */
const TONE_CHIP: Partial<Record<Tone, ChipColor>> = { ok: "green", warn: "amber", danger: "red" };

export function HealthBadge({ value }: { value: Health }) {
  return <Chip color={HEALTH_CHIP[value]}>{HEALTH_LABELS[value]}</Chip>;
}

export function PriorityBadge({ value }: { value: Priority }) {
  return <Chip color={PRIORITY_CHIP[value]}>{PRIORITY_LABELS[value]}</Chip>;
}

export function StageBadge({ value }: { value: Stage }) {
  return (
    <span className="inline-flex h-6 w-fit items-center rounded-full px-2.5 text-xs font-semibold whitespace-nowrap" style={stageStyle(value)}>
      {STAGE_LABELS[value]}
    </span>
  );
}

/** Días en la etapa contra el plazo: verde en plazo, ámbar desde el 75 % y rojo si se pasa. */
export function StageAgeBadge({ stage, since, sla }: { stage: Stage; since: string; sla: number | null }) {
  const age = stageAge(since, sla);
  const title = sla === null ? `En ${STAGE_LABELS[stage]} desde ${formatDate(since)} · sin plazo` : `En ${STAGE_LABELS[stage]} desde ${formatDate(since)} · plazo ${sla} días`;
  return (
    <Chip color={TONE_CHIP[age.tone] ?? "gray"} title={title}>
      {age.text}
    </Chip>
  );
}

/**
 * Etapas como pasos numerados unidos por una línea (prototipo `.stps`): las anteriores con check
 * verde, la actual con anillo rojo. Con `onChange` cada paso es un botón (CEO/CCO y Team Leader).
 */
export function StageStepper({ stage, onChange }: { stage: Stage; onChange?: (stage: Stage) => void }) {
  const current = STAGES.indexOf(stage);
  const pct = (current / (STAGES.length - 1)) * 100;
  return (
    <div className="overflow-x-auto pb-1">
      <ol aria-label="Etapas del proyecto" className="relative flex min-w-[760px] justify-between pb-11">
        <span aria-hidden className="absolute top-[15px] right-4 left-4 h-0.5 rounded bg-border">
          <span className="block h-full rounded bg-[var(--chip-green-fg)]" style={{ width: `${pct}%` }} />
        </span>
        {STAGES.map((s, i) => {
          const done = i < current;
          const on = i === current;
          const align = i === 0 ? "left-0 items-start text-left" : i === STAGES.length - 1 ? "right-0 items-end text-right" : "left-1/2 -translate-x-1/2 items-center text-center";
          const body = (
            <>
              <span
                className={cn(
                  "relative z-[1] flex size-8 items-center justify-center rounded-full border-2 text-[13px] font-bold transition-colors",
                  done ? "border-[var(--chip-green-fg)] bg-[var(--chip-green-fg)] text-white" : on ? "border-primary bg-card text-accent-text shadow-[0_0_0_5px_var(--accent-soft)]" : "border-line-strong bg-card text-muted-foreground",
                )}
              >
                {done ? <Check className="size-4" strokeWidth={3} /> : i + 1}
              </span>
              <span className={cn("absolute top-[42px] flex flex-col gap-0.5 whitespace-nowrap", align)}>
                <span className={cn("text-[13px] leading-tight", i > current ? "font-medium text-muted-foreground" : "font-semibold")}>{STAGE_LABELS[s]}</span>
                <span className={cn("text-[11.5px]", on ? "font-semibold text-accent-text" : "text-muted-foreground")}>{done ? "Completada" : on ? "En curso" : "Pendiente"}</span>
              </span>
            </>
          );
          return (
            <li key={s} aria-current={on ? "step" : undefined} className="relative size-8">
              {onChange && !on ? (
                <button type="button" aria-label={`Pasar a ${STAGE_LABELS[s]}`} onClick={() => onChange(s)} className="block size-8 rounded-full outline-none [&:hover>span:first-child]:border-primary focus-visible:ring-3 focus-visible:ring-ring/50">
                  {body}
                </button>
              ) : (
                body
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Aviso de proyectos que llevan más tiempo del esperado en su etapa (los de toda la lista filtrada). */
export function StuckBanner({ projects }: { projects: StuckProject[] }) {
  if (!projects.length) return null;
  return (
    <section aria-label="Proyectos atascados" className="space-y-3 rounded-[14px] border border-primary bg-card p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="flex items-center gap-2 font-semibold text-accent-text">
          <AlertTriangle className="size-4" aria-hidden />
          {projects.length} {projects.length === 1 ? "proyecto atascado" : "proyectos atascados"}
        </p>
        <p className="text-sm text-muted-foreground">Llevan más tiempo del esperado en su etapa: los developers se quedan sin tareas y no se facturan horas.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {projects.map((p) => (
          <Link key={p.id} to={`/operativa/${p.id}?tab=stages`} className="inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-[10px] border border-border bg-card px-3 py-1.5 text-sm transition-colors hover:border-line-strong hover:bg-muted">
            <span className="font-semibold">{p.name}</span>
            <span className="whitespace-nowrap text-muted-foreground">{STAGE_LABELS[p.stage]}</span>
            <Chip color="red">
              {p.days} d · +{p.days - (p.sla ?? 0)} d
            </Chip>
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
