import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { STAGE_LABELS, STAGES, stageStyle, updateStageSla, useStageSla, type Stage, type StageSla } from "@/features/ops/api";
import { errorText, toast } from "@/lib/toast";
import { Panel } from "./Panel";

/** Plazos por etapa del proyecto (solo CEO/CCO): días esperados; vacío = sin límite. */
export function StageSlaCard() {
  const queryClient = useQueryClient();
  const { data } = useStageSla();
  const [draft, setDraft] = useState<Partial<Record<Stage, string>>>({});
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const valueOf = (st: Stage) => draft[st] ?? (data.days[st] === null ? "" : String(data.days[st]));
  const parsed = Object.fromEntries(STAGES.map((st) => [st, valueOf(st).trim() === "" ? null : Number(valueOf(st))])) as StageSla;
  const invalid = STAGES.some((st) => parsed[st] !== null && (!Number.isInteger(parsed[st]) || (parsed[st] as number) < 1 || (parsed[st] as number) > 3650));
  const dirty = STAGES.some((st) => parsed[st] !== data.days[st]);

  async function save() {
    setBusy(true);
    try {
      await updateStageSla(parsed);
      setDraft({});
      await queryClient.invalidateQueries({ queryKey: ["ops"] });
      toast.success("Plazos por etapa guardados");
    } catch (err) {
      toast.error("No se pudieron guardar los plazos.", { description: errorText(err, "Inténtalo de nuevo.") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel label="Plazos por etapa" className="lg:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl leading-tight font-bold">Plazos por etapa</h2>
          <p className="font-subtitle mt-1.5 text-[15px] text-muted-foreground">Días esperados en cada etapa del proyecto. Vacío = sin límite.</p>
        </div>
        <div className="flex flex-wrap gap-2" aria-label="Colores del plazo">
          <Chip color="green" className="h-7 px-3 text-[13px]">En plazo</Chip>
          <Chip color="amber" className="h-7 px-3 text-[13px]">Desde el 75 %</Chip>
          <Chip color="red" className="h-7 px-3 text-[13px]">Vencido</Chip>
        </div>
      </div>
      <div className="mt-7 grid grid-cols-[repeat(auto-fill,minmax(9.75rem,1fr))] gap-x-5 gap-y-6">
        {STAGES.map((st, i) => (
          <div key={st} className="min-w-0">
            <p className="text-caps-label">Paso {i + 1}</p>
            <label htmlFor={`sla-${st}`} className="mt-2.5 inline-flex h-7 max-w-full items-center rounded-full px-3 text-[13px] font-semibold whitespace-nowrap" style={stageStyle(st)}>
              <span className="truncate">{STAGE_LABELS[st]}</span>
            </label>
            <div className="mt-3 flex h-12 items-center rounded-xl bg-muted px-4 focus-within:ring-3 focus-within:ring-ring/50">
              <input
                id={`sla-${st}`}
                inputMode="numeric"
                aria-label={`Días esperados en ${STAGE_LABELS[st]}`}
                value={valueOf(st)}
                placeholder="—"
                onChange={(e) => setDraft({ ...draft, [st]: e.target.value.replace(/[^0-9]/g, "") })}
                className="w-full min-w-0 bg-transparent text-base font-semibold tabular-nums outline-none placeholder:text-foreground"
              />
              <span className="shrink-0 text-[15px] text-muted-foreground">días</span>
            </div>
          </div>
        ))}
      </div>
      {invalid && <p role="alert" className="mt-4 text-sm text-destructive">Usa días enteros entre 1 y 3650.</p>}
      <div className="mt-7 flex flex-wrap items-center gap-3 border-t border-border pt-6">
        <p className="font-subtitle min-w-0 flex-1 text-[15px] text-muted-foreground">Se aplican a todos los proyectos.</p>
        <Button variant="outline" size="lg" disabled={!dirty || busy} onClick={() => setDraft({})}>
          Descartar
        </Button>
        <Button size="lg" disabled={!dirty || invalid || busy} loading={busy} onClick={() => void save()}>
          Guardar cambios
        </Button>
      </div>
    </Panel>
  );
}
