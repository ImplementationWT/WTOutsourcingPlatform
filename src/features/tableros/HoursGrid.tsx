import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { hoursLabel, type Board } from "@/features/tasks/api";
import { workItems } from "@/features/tasks/filters";

type Scale = "days" | "weeks" | "months";
type Metric = "i" | "b" | "p";
const SCALES: { id: Scale; label: string; n: number }[] = [
  { id: "days", label: "Días", n: 14 },
  { id: "weeks", label: "Semanas", n: 10 },
  { id: "months", label: "Meses", n: 8 },
];
const METRICS: { id: Metric; label: string }[] = [
  { id: "i", label: "Invertidas" },
  { id: "b", label: "Facturables" },
  { id: "p", label: "Proyectadas" },
];
const DAY = 86_400_000;
const MS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const DS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`);

const bucketStart = (ms: number, scale: Scale) => {
  const d = new Date(Math.floor(ms / DAY) * DAY);
  if (scale === "days") return d.getTime();
  if (scale === "weeks") return d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};
const nextBucket = (ms: number, scale: Scale) => {
  if (scale === "days") return ms + DAY;
  if (scale === "weeks") return ms + 7 * DAY;
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
};
const label = (ms: number, scale: Scale) => {
  const d = new Date(ms);
  if (scale === "days") return `${DS[d.getUTCDay()]} ${d.getUTCDate()}`;
  if (scale === "weeks") return `${d.getUTCDate()} ${MS[d.getUTCMonth()]}`;
  return `${MS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
};

/**
 * Horas por persona en el tiempo: cada ítem reparte sus horas por igual entre los días de su
 * timeline; la burbuja crece con las horas del periodo. Sin fechas no entra en la cuadrícula.
 */
export function HoursGrid({ board }: { board: Board }) {
  const [scale, setScale] = useState<Scale>("months");
  const [metric, setMetric] = useState<Metric>("i");
  const [offset, setOffset] = useState(0);
  const n = SCALES.find((s) => s.id === scale)!.n;
  const step = Math.max(1, Math.floor(n / 2));
  const today = bucketStart(Date.now(), scale);
  // Arranca dos periodos antes de hoy y se mueve de a media pantalla.
  let first = bucketStart(today - 1, scale);
  first = bucketStart(first - 1, scale);
  const move = offset * step;
  for (let k = 0; k < Math.abs(move); k++) first = move > 0 ? nextBucket(first, scale) : bucketStart(first - 1, scale);
  const starts: number[] = [];
  for (let k = 0, cur = first; k < n; k++, cur = nextBucket(cur, scale)) starts.push(cur);
  const index = new Map(starts.map((s, k) => [s, k]));

  const items = workItems(board.tasks).filter((x) => x.owner && x[metric] > 0);
  const grid = new Map<string, number[]>();
  let undated = 0;
  for (const x of items) {
    const a = x.start ?? (x.sub ? x.task.derived.startDate : null);
    const b = x.end ?? (x.sub ? x.task.derived.dueDate : null);
    if (!a || !b) {
      undated += x[metric];
      continue;
    }
    const lo = utc(a);
    const hi = utc(b);
    if (hi < lo) continue;
    const days = Math.round((hi - lo) / DAY) + 1;
    const row = grid.get(x.owner!) ?? starts.map(() => 0);
    for (let d = lo; d <= hi; d += DAY) {
      const k = index.get(bucketStart(d, scale));
      if (k !== undefined) row[k] += x[metric] / days;
    }
    grid.set(x.owner!, row);
  }
  const people = board.people.filter((p) => grid.has(p.id));
  const max = Math.max(0.0001, ...[...grid.values()].flat());
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const cols = `minmax(9rem,12rem) repeat(${n}, minmax(${scale === "days" ? "3.25rem" : "4.5rem"}, 1fr)) 4.5rem`;
  const seg = (active: boolean) => cn("h-8 rounded-lg px-3 text-sm font-medium", active ? "bg-card font-semibold shadow-sm" : "text-muted-foreground");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="Tipo de horas" className="inline-flex rounded-xl bg-muted p-1">
          {METRICS.map((m) => (
            <button key={m.id} role="tab" type="button" aria-selected={metric === m.id} className={seg(metric === m.id)} onClick={() => setMetric(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="icon-sm" variant="outline" aria-label="Anterior" onClick={() => setOffset(offset - 1)}>
            <ChevronLeft />
          </Button>
          <Button size="sm" variant="outline" onClick={() => setOffset(0)}>
            Hoy
          </Button>
          <Button size="icon-sm" variant="outline" aria-label="Siguiente" onClick={() => setOffset(offset + 1)}>
            <ChevronRight />
          </Button>
          <div role="tablist" aria-label="Escala" className="inline-flex rounded-xl bg-muted p-1">
            {SCALES.map((s) => (
              <button
                key={s.id}
                role="tab"
                type="button"
                aria-selected={scale === s.id}
                className={seg(scale === s.id)}
                onClick={() => {
                  setScale(s.id);
                  setOffset(0);
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="overflow-x-auto rounded-xl border border-border">
        <div role="table" aria-label="Horas por persona" className="min-w-max">
          <div role="row" className="grid border-b border-border text-xs text-muted-foreground" style={{ gridTemplateColumns: cols }}>
            <span role="columnheader" className="px-3 py-2.5">
              Persona
            </span>
            {starts.map((s) => (
              <span key={s} role="columnheader" className="flex items-center justify-center border-l border-border py-2">
                <span className={cn("rounded-full px-2.5 py-0.5 whitespace-nowrap", s === today && "bg-primary font-semibold text-primary-foreground")}>{label(s, scale)}</span>
              </span>
            ))}
            <span role="columnheader" className="flex items-center justify-center border-l border-border">
              Total
            </span>
          </div>
          {people.map((p) => {
            const row = grid.get(p.id)!;
            const total = row.reduce((a, v) => a + v, 0);
            return (
              <div key={p.id} role="row" className="grid border-t border-border" style={{ gridTemplateColumns: cols }}>
                <span role="rowheader" className="flex items-center truncate px-3 text-sm font-medium">
                  {p.name}
                </span>
                {row.map((v, k) => {
                  const size = v > 0 ? Math.round(8 + Math.sqrt(v / max) * 30) : 0;
                  return (
                    <div key={k} role="cell" tabIndex={0} aria-label={`${p.name} · ${label(starts[k], scale)}: ${hoursLabel(r1(v))}`} className={cn("group/tip relative flex h-16 items-center justify-center border-l border-border hover:bg-muted/60", starts[k] === today && "bg-muted/30")}>
                      {v > 0 && (
                        <>
                          <span aria-hidden className="rounded-full ring-2 ring-card" style={{ width: size, height: size, background: "var(--viz-1)" }} />
                          <span className="absolute right-1.5 bottom-1 text-[11px] text-muted-foreground tabular-nums">{r1(v)}</span>
                          <span role="tooltip" className="pointer-events-none absolute top-1 left-1/2 z-30 hidden -translate-x-1/2 rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs font-medium whitespace-nowrap text-popover-foreground shadow-popover group-hover/tip:block group-focus-visible/tip:block">
                            {p.name} · {label(starts[k], scale)}: {hoursLabel(r1(v))}
                          </span>
                        </>
                      )}
                    </div>
                  );
                })}
                <span role="cell" className="flex items-center justify-center border-l border-border text-sm font-bold tabular-nums">
                  {total ? hoursLabel(r1(total)) : "—"}
                </span>
              </div>
            );
          })}
          {!people.length && <p className="p-8 text-center text-sm text-muted-foreground">No hay horas con fechas en este periodo.</p>}
        </div>
      </div>
      {undated > 0 && <p className="text-xs text-muted-foreground">{hoursLabel(r1(undated))} sin fechas no se muestran en la cuadrícula.</p>}
    </div>
  );
}
