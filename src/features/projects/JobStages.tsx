import { useState } from "react";
import { Check, CheckCircle2, ChevronDown, Circle, Loader2, Minus, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDuration, type Job, type JobStage, type SubStep } from "./provisioning";

function SubStepIcon({ status }: { status: SubStep["status"] }) {
  switch (status) {
    case "running":
      return <Loader2 className="size-3.5 animate-spin text-brand-300" aria-label="En curso" />;
    case "done":
      return <Check className="size-3.5 text-ok-fg" aria-label="Hecho" />;
    case "skipped":
      return <Minus className="size-3.5 text-muted-foreground" aria-label="Omitido" />;
    case "failed":
      return <X className="size-3.5 text-danger-fg" aria-label="Falló" />;
    default:
      return <Circle className="size-2 fill-foreground/15 text-transparent" aria-label="Pendiente" />;
  }
}

/** Lista de verificación de los pasos internos de una etapa (p. ej. MongoDB). */
function SubSteps({ stage }: { stage: JobStage }) {
  const finishedOk = stage.status === "succeeded";
  const [expanded, setExpanded] = useState(false);
  const done = stage.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  const open = !finishedOk || expanded;

  return (
    <div className="mt-2">
      {finishedOk && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {done}/{stage.steps.length} pasos completados
          <ChevronDown className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
        </button>
      )}
      {open && (
        <ol className="mt-1 space-y-1.5 rounded-lg border border-foreground/10 bg-foreground/[0.02] p-3">
          {stage.steps.map((step) => (
            <li key={step.id} className="flex gap-2.5">
              <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                <SubStepIcon status={step.status} />
              </span>
              <div className="min-w-0">
                <p
                  className={cn(
                    "text-sm",
                    step.status === "pending" && "text-muted-foreground/70",
                    step.status === "running" && "font-medium text-foreground",
                    step.status === "failed" && "text-danger-fg",
                  )}
                >
                  {step.label}
                </p>
                {step.detail && step.status !== "pending" && (
                  <p className={cn("text-xs break-words", step.status === "failed" ? "text-danger-fg" : "text-muted-foreground")}>
                    {step.detail}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function StageIcon({ status }: { status: JobStage["status"] }) {
  switch (status) {
    case "running":
      return <Loader2 className="size-5 animate-spin text-brand-300" aria-label="En curso" />;
    case "succeeded":
      return <CheckCircle2 className="size-5 text-ok-fg" aria-label="Completada" />;
    case "failed":
      return <XCircle className="size-5 text-danger-fg" aria-label="Fallida" />;
    default:
      return <Circle className="size-5 text-foreground/20" aria-label="Pendiente" />;
  }
}

/** Barra de progreso + lista de etapas con estado, duración, detalle y error resumido. */
export default function JobStages({ job }: { job: Job }) {
  const done = job.stages.filter((s) => s.status === "succeeded").length;
  const progress = Math.round((done / job.stages.length) * 100);

  return (
    <div className="space-y-6">
      <div
        className="h-1.5 overflow-hidden rounded-full bg-foreground/10"
        role="progressbar"
        aria-valuenow={progress}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Progreso del aprovisionamiento"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500",
            job.status === "failed" ? "bg-danger/70" : job.status === "succeeded" ? "bg-ok" : "bg-brand-400",
          )}
          style={{ width: `${Math.max(progress, job.status === "running" ? 4 : 0)}%` }}
        />
      </div>

      <ol className="space-y-1" aria-live="polite">
        {job.stages.map((stage, index) => {
          const duration = formatDuration(stage.durationMs);
          return (
            <li key={stage.name} className="flex gap-3">
              <div className="flex flex-col items-center">
                <StageIcon status={stage.status} />
                {index < job.stages.length - 1 && (
                  <span className={cn("my-1 w-px flex-1", stage.status === "succeeded" ? "bg-ok/30" : "bg-foreground/10")} />
                )}
              </div>
              <div className="min-w-0 flex-1 pb-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <p className={cn("text-sm font-medium", stage.status === "pending" && "text-muted-foreground")}>
                    {stage.label}
                    <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">{stage.name}</span>
                  </p>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {duration}
                    {stage.attempts > 1 && ` · ${stage.attempts} intentos`}
                  </span>
                </div>
                {stage.error ? (
                  <p className="mt-1 rounded-md border border-danger/20 bg-danger/10 px-2.5 py-1.5 text-sm break-words text-danger-fg">
                    <span className="font-mono text-xs text-danger-fg">{stage.error.code}</span> · {stage.error.message}
                  </p>
                ) : (
                  // Con pasos internos, el detalle vive en cada paso; el de la etapa solo al final.
                  stage.detail &&
                  (stage.steps.length === 0 || stage.status === "succeeded") && (
                    <p className="mt-0.5 text-sm break-words text-muted-foreground">{stage.detail}</p>
                  )
                )}
                {stage.steps.length > 0 && stage.status !== "pending" && <SubSteps stage={stage} />}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
