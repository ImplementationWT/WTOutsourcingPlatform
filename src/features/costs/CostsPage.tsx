import { useState } from "react";
import { Link } from "react-router-dom";
import { Download, Info, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useTeamFilter } from "@/features/admin/api";
import { cn } from "@/lib/utils";
import { type CostBucket, type CostRange, type CostSummary, costQuery, formatUsd, monthLabel, useCostSessions, useCostSummary } from "./api";

const STATUS_LABELS = { active: "En curso", merged: "Publicada", closed: "Cerrada" } as const;

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card size="sm">
      <CardContent>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

/** Tendencia mensual: barras horizontales proporcionales al mes de mayor gasto. */
function MonthlyChart({ months }: { months: CostSummary["byMonth"] }) {
  const max = Math.max(1, ...months.map((m) => m.costCents));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Gasto mensual</CardTitle>
        <CardDescription>Por mes de inicio de la sesión (UTC).</CardDescription>
      </CardHeader>
      <CardContent>
        {months.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin sesiones en este periodo.</p>
        ) : (
          <ul className="space-y-2" aria-label="Gasto por mes">
            {months.map((m) => (
              <li key={m.month} className="grid grid-cols-[5.5rem_1fr_6.5rem] items-center gap-3 text-sm">
                <span className="text-muted-foreground">{monthLabel(m.month)}</span>
                <span className="h-2.5 overflow-hidden rounded-full bg-foreground/[0.06]">
                  <span className="block h-full rounded-full bg-violet-400/80" style={{ width: `${Math.max(2, (m.costCents / max) * 100)}%` }} />
                </span>
                <span className="text-right tabular-nums">{formatUsd(m.costCents)}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function BreakdownTable<T extends CostBucket>({
  title,
  description,
  rows,
  name,
  limit,
}: {
  title: string;
  description?: string;
  rows: T[];
  name: (row: T) => React.ReactNode;
  limit?: number;
}) {
  const shown = limit ? rows.slice(0, limit) : rows;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {shown.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin datos en este periodo.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="pb-2 font-medium">Nombre</th>
                <th className="pb-2 text-right font-medium">Gasto</th>
                <th className="pb-2 text-right font-medium">Sesiones</th>
                <th className="pb-2 text-right font-medium">PR fusionados</th>
                <th className="pb-2 text-right font-medium">Por PR</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-foreground/10">
              {shown.map((row, i) => (
                <tr key={i}>
                  <td className="py-2 pr-3">{name(row)}</td>
                  <td className="py-2 text-right tabular-nums">{formatUsd(row.costCents)}</td>
                  <td className="py-2 text-right tabular-nums">{row.sessions}</td>
                  <td className="py-2 text-right tabular-nums">{row.mergedPrs}</td>
                  <td className="py-2 text-right tabular-nums">{formatUsd(row.costPerMergedPrCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
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

export default function CostsPage() {
  const [range, setRange] = useState<CostRange>(defaultRange);
  const teamId = useTeamFilter();
  const summary = useCostSummary(range);
  const data = summary.data;
  const exportUrl = `/api/costs/export.csv${costQuery(range, teamId)}`;

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Costos</h1>
          <p className="mt-2 text-muted-foreground">
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
          <Button variant="ghost" onClick={() => setRange({ from: "", to: "" })} disabled={!range.from && !range.to}>
            Todo
          </Button>
          <Button variant="outline" render={<a href={exportUrl} download />} nativeButton={false}>
            <Download />
            Exportar CSV
          </Button>
        </div>
      </div>

      <p className="flex items-start gap-2 rounded-lg border border-sky-400/20 bg-sky-500/5 px-3 py-2 text-sm text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0 text-sky-400" />
        Precio de lista que informa Anthropic por sesión, en USD. No es la factura: descuentos, créditos o impuestos no se reflejan.
      </p>

      {summary.isLoading ? (
        <div className="grid gap-4 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : summary.isError || !data ? (
        <p className="text-sm text-red-300">{summary.error?.message ?? "No se pudieron cargar los costos."}</p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Gasto total" value={formatUsd(data.totals.costCents)} />
            <Stat label="Sesiones" value={String(data.totals.sessions)} />
            <Stat label="PR fusionados" value={String(data.totals.mergedPrs)} />
            <Stat label="Costo por PR fusionado" value={formatUsd(data.totals.costPerMergedPrCents)} hint="Gasto total ÷ PR fusionados" />
          </div>

          {data.scope === "boss" && !teamId && data.byTeam.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {data.byTeam.map((team) => (
                <Card key={team.teamId ?? "none"} size="sm">
                  <CardContent>
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <Wallet className="size-4 text-violet-300" />
                      {team.name}
                    </p>
                    <p className="mt-2 text-xl font-semibold tabular-nums">{formatUsd(team.costCents)}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {team.sessions} sesiones · {team.mergedPrs} PR · {formatUsd(team.costPerMergedPrCents)} por PR
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          <MonthlyChart months={data.byMonth} />

          {data.scope === "developer" ? (
            <SessionsTable range={range} />
          ) : (
            <div className="grid gap-6 xl:grid-cols-2">
              <BreakdownTable
                title={data.scope === "boss" ? "Proyectos más caros" : "Proyectos del equipo"}
                rows={data.byProject}
                limit={data.scope === "boss" ? 10 : undefined}
                name={(row) => (
                  <span>
                    <Link to={`/projects/${row.clientId}`} className="underline-offset-4 hover:underline">
                      {row.name}
                    </Link>
                    {data.scope === "boss" && row.teamName && <span className="ml-1.5 text-xs text-muted-foreground">{row.teamName}</span>}
                  </span>
                )}
              />
              <BreakdownTable
                title={data.scope === "boss" ? "Por persona" : "Gasto por developer"}
                description="Según quién inició cada sesión."
                rows={data.byPerson}
                name={(row) => (
                  <span>
                    {row.name} <span className="font-mono text-xs text-muted-foreground">{row.username}</span>
                  </span>
                )}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}
