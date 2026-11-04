import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { STAGE_LABELS, STAGES, updateStageSla, useStageSla, type Stage, type StageSla } from "@/features/ops/api";
import { errorText, toast } from "@/lib/toast";

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
  const dirty = Object.keys(draft).length > 0;

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
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Plazos por etapa</CardTitle>
        <CardDescription>Días esperados en cada etapa del proyecto. El chip se pone ámbar desde el 75 % y rojo al pasarse. Vacío = sin límite.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {STAGES.map((st) => (
            <div key={st} className="space-y-1.5">
              <Label htmlFor={`sla-${st}`} className="text-caps-label">
                {STAGE_LABELS[st]}
              </Label>
              <Input id={`sla-${st}`} inputMode="numeric" value={valueOf(st)} placeholder="Sin límite" onChange={(e) => setDraft({ ...draft, [st]: e.target.value.replace(/[^0-9]/g, "") })} />
            </div>
          ))}
        </div>
        {invalid && <p role="alert" className="text-sm text-destructive">Usa días enteros entre 1 y 3650.</p>}
        <div className="flex gap-2">
          <Button disabled={!dirty || invalid || busy} loading={busy} onClick={() => void save()}>
            Guardar plazos
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setDraft(Object.fromEntries(STAGES.map((st) => [st, data.defaults[st] === null ? "" : String(data.defaults[st])])))}>
            Valores iniciales
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
