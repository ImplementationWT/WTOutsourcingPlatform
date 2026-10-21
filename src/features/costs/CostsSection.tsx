import { useState } from "react";
import { Link } from "react-router-dom";
import { Info, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { type CostBucket, type CostRange, type CostSummary, formatUsd, monthLabel, useCostSessions, useCostSummary } from "./api";

const STATUS_LABELS = { active: "En curso", merged: "Publicada", closed: "Cerrada" } as const;

/** Misma cuadrícula para todas las tarjetas de la sección: quedan alineadas en columnas. */
const GRID = "grid gap-4 sm:grid-cols-2 xl:grid-cols-4";

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card className="h-full">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl font-semibold tabular-nums">{value}</CardTitle>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardHeader>
    </Card>
  );
}

/**
 * Gráfico de barras horizontales: cada fila es proporcional al valor más alto. El detalle
 * (sesiones, PR, costo por PR) va debajo de cada barra.
 */
function BarChart<T extends CostBucket>({
  title,
  description,
  rows,
  label,
  barClass,
  empty = "Sin sesiones en este periodo.",
}: {
  title: string;
  description?: string;
  rows: T[];
  label: (row: T) => React.ReactNode;
  barClass: string;
  empty?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.costCents));
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="space-y-3" aria-label={title}>
            {rows.map((row, i) => (
              <li key={i} className="space-y-1">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate">{label(row)}</span>
                  <span className="shrink-0 font-medium tabular-nums">{formatUsd(row.costCents)}</span>
                </div>
                <div className="h-2.5 overflow-hidden rounded-full bg-foreground/[0.06]">
                  <div className={cn("h-full rounded-full", barClass)} style={{ width: `${Math.max(2, (row.costCents / max) * 100)}%` }} />
                </div>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {row.sessions} {row.sessions === 1 ? "sesión" : "sesiones"} · {row.mergedPrs} PR fusionados
                  {row.costPerMergedPrCents !== null && ` · ${formatUsd(row.costPerMergedPrCents)} por PR`}
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Tendencia mensual: columnas verticales por mes. */
function MonthlyChart({ months }: { months: CostSummary["byMonth"] }) {
  const max = Math.max(1, ...months.map((m) => m.costCents));
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Gasto mensual</CardTitle>
        <CardDescription>Por mes de inicio de la sesión (UTC).</CardDescription>
      </CardHeader>
      <CardContent>
        {months.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin sesiones en este periodo.</p>
        ) : (
          <ul className="flex h-48 items-end gap-3 overflow-x-auto" aria-label="Gasto por mes">
            {months.map((m) => (
              <li key={m.month} className="flex h-full min-w-14 flex-1 flex-col items-center justify-end gap-1.5">
                <span className="text-xs tabular-nums">{formatUsd(m.costCents)}</span>
                <div className="w-full max-w-12 rounded-t-md bg-violet-400/80" style={{ height: `${Math.max(2, (m.costCents / max) * 100)}%` }} />
                <span className="text-xs text-muted-foreground">{monthLabel(m.month)}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function SessionsTable({ range }: { range: CostRange }) {
  const sessions = useCostSessions(range);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Tus sesiones</CardTitle>
        <CardDescription>Conversaciones del AI Developer que iniciaste (también las borradas del panel).</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {sessions.isLoading ? (
          <Skeleton className="h-24" />
        ) : !sessions.data?.length ? (
          <p className="text-sm text-muted-foreground">Sin sesiones en este periodo.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="pb-2 font-medium">Fecha</th>
                <th className="pb-2 font-medium">Proyecto</th>
                <th className="pb-2 font-medium">Conversación</th>
                <th className="pb-2 font-medium">Estado</th>
                <th className="pb-2 text-right font-medium">Gasto</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-foreground/10">
              {sessions.data.map((s) => (
                <tr key={s.id} className={cn(s.deleted && "text-muted-foreground")}>
                  <td className="py-2 pr-3 whitespace-nowrap">{new Date(s.createdAt).toLocaleDateString()}</td>
                  <td className="py-2 pr-3">{s.project}</td>
                  <td className="max-w-72 truncate py-2 pr-3" title={s.title}>
                    {s.title}
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {STATUS_LABELS[s.status]}
                    {s.pullRequest ? ` · PR #${s.pullRequest}` : ""}
                    {s.deleted ? " · borrada" : ""}
                  </td>
                  <td className="py-2 text-right tabular-nums">{formatUsd(s.costCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

/** Mes en curso por defecto (del día 1 a hoy). */
function defaultRange(): CostRange {
  const today = new Date().toISOString().slice(0, 10);
  return { from: `${today.slice(0, 7)}-01`, to: today };
}

/** Costos del AI Developer (dentro del Dashboard). Cada rol ve su alcance. */
export default function CostsSection() {
  const [range, setRange] = useState<CostRange>(defaultRange);
  const summary = useCostSummary(range);
  const data = summary.data;

  return (
    <section id="costos" className="scroll-mt-20 space-y-4">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Costos</h2>
        <p className="mt-1 text-muted-foreground">
          {data?.scope === "boss"
            ? "Gasto del AI Developer (Claude) de todos los equipos."
            : data?.scope === "lead"
              ? "Gasto del AI Developer (Claude) en los proyectos de tu equipo."
              : "Gasto del AI Developer (Claude) en tus sesiones."}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="costs-from" className="text-xs">
            Desde
          </Label>
          <Input id="costs-from" type="date" value={range.from} max={range.to || undefined} onChange={(e) => setRange({ ...range, from: e.target.value })} className="w-40" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="costs-to" className="text-xs">
            Hasta
          </Label>
          <Input id="costs-to" type="date" value={range.to} min={range.from || undefined} onChange={(e) => setRange({ ...range, to: e.target.value })} className="w-40" />
        </div>
        <Button variant="ghost" onClick={() => setRange(defaultRange())}>
          Este mes
        </Button>
        <Button variant="ghost" onClick={() => setRange({ from: "", to: "" })} disabled={!range.from && !range.to}>
          Todo
        </Button>
      </div>

      <p className="flex items-start gap-2 rounded-lg border border-sky-400/20 bg-sky-500/5 px-3 py-2 text-sm text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0 text-sky-400" />
        Precio de lista que informa Anthropic por sesión, en USD. No es la factura: descuentos, créditos o impuestos no se reflejan.
      </p>

      {summary.isLoading ? (
        <div className={GRID}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : summary.isError || !data ? (
        <p className="text-sm text-red-300">{summary.error?.message ?? "No se pudieron cargar los costos."}</p>
      ) : (
        <>
          <div className={GRID}>
            <Stat label="Gasto total" value={formatUsd(data.totals.costCents)} hint="en el periodo elegido" />
            <Stat label="Sesiones" value={String(data.totals.sessions)} hint="conversaciones del AI Developer" />
            <Stat label="PR fusionados" value={String(data.totals.mergedPrs)} hint="cambios publicados" />
            <Stat label="Costo por PR fusionado" value={formatUsd(data.totals.costPerMergedPrCents)} hint="gasto total ÷ PR fusionados" />
          </div>

          {data.scope === "boss" && data.byTeam.length > 0 && (
            <div className={GRID}>
              {data.byTeam.map((team) => (
                <Card key={team.teamId ?? "none"} className="h-full">
                  <CardHeader>
                    <CardDescription className="flex items-center gap-2">
                      <Wallet className="size-4 text-violet-300" />
                      {team.name}
                    </CardDescription>
                    <CardTitle className="text-2xl font-semibold tabular-nums">{formatUsd(team.costCents)}</CardTitle>
                    <p className="text-xs text-muted-foreground">
                      {team.sessions} sesiones · {team.mergedPrs} PR · {formatUsd(team.costPerMergedPrCents)} por PR
                    </p>
                  </CardHeader>
                </Card>
              ))}
            </div>
          )}

          <MonthlyChart months={data.byMonth} />

          {data.scope === "developer" ? (
            <SessionsTable range={range} />
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              <BarChart
                title={data.scope === "boss" ? "Proyectos más caros" : "Proyectos del equipo"}
                rows={data.byProject.slice(0, 10)}
                barClass="bg-violet-400/80"
                label={(row) => (
                  <>
                    <Link to={`/projects/${row.clientId}`} className="underline-offset-4 hover:underline">
                      {row.name}
                    </Link>
                    {data.scope === "boss" && row.teamName && <span className="ml-1.5 text-xs text-muted-foreground">{row.teamName}</span>}
                  </>
                )}
              />
              <BarChart
                title="Gasto por persona"
                description="Según quién inició cada sesión."
                rows={data.byPerson.slice(0, 10)}
                barClass="bg-sky-400/80"
                label={(row) => (
                  <>
                    {row.name} <span className="font-mono text-xs text-muted-foreground">{row.username}</span>
                  </>
                )}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}
