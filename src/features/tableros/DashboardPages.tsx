import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { BarList, ChartCard, ColumnChart, Donut, type Series } from "@/components/charts/charts";
import { MAX_SERIES, OTHER_COLOR, TONE_VAR, vizColor } from "@/components/charts/viz";
import { PageHeader } from "@/components/layout/PageHeader";
import { Kpi, KpiRow } from "@/components/ui/kpi";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/features/auth/auth";
import { INVOICE_STAGE_LABELS, INVOICE_STAGE_TONE, INVOICE_STAGES, MONTHS, useInvoices, type Invoice } from "@/features/finance/api";
import { money, STAGE_LABELS, STAGES, stageAge, useOpsProjects } from "@/features/ops/api";
import { LEAD_STATUS_LABELS, LEAD_TEMPERATURE_LABELS, type LeadStatus, type LeadTemperature } from "@/features/sales/api";
import { useSites, useSitesConfig } from "@/features/sites/api";
import { hoursLabel, sprintLabel, sprintState, statusOf, TASK_STATUS_LABELS, TASK_STATUS_TONE, TASK_STATUSES, useBoard } from "@/features/tasks/api";
import { workItems } from "@/features/tasks/filters";
import { canAccess } from "@/lib/access";
import { apiFetch } from "@/lib/api-client";
import { HoursGrid } from "./HoursGrid";

const short = (cents: number) => {
  const usd = cents / 100;
  return usd >= 1000 ? `$${Math.round(usd / 100) / 10}k` : `$${Math.round(usd)}`;
};
const monthShort = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1].slice(0, 3)} ${m.slice(2, 4)}`;
const count = (n: number) => String(Math.round(n * 10) / 10);

/** Aviso cuando el rol no lee los datos de un dashboard (las reglas de acceso de los datos no cambian). */
function NoAccess({ what }: { what: string }) {
  return (
    <p className="flex items-start gap-3 rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground">
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
      Tu rol no tiene acceso a {what}, así que este dashboard no muestra datos.
    </p>
  );
}

// ---- Financiero --------------------------------------------------------------------

/** Meses seguidos desde el primero hasta el último con invoices. */
function monthRange(invoices: Invoice[]) {
  const ms = invoices.map((v) => v.month).sort();
  if (!ms.length) return [];
  const out: string[] = [];
  let [y, m] = ms[0].split("-").map(Number);
  for (let i = 0; i < 36; i++) {
    const k = `${y}-${String(m).padStart(2, "0")}`;
    out.push(k);
    if (k >= ms.at(-1)!) break;
    m += 1;
    if (m > 12) [y, m] = [y + 1, 1];
  }
  return out;
}

function FinancialBody() {
  const { data, isLoading } = useInvoices();
  if (isLoading || !data) return <Skeleton className="h-64 w-full" />;
  const inv = data.invoices;
  const current = new Date().toISOString().slice(0, 7);
  const sum = (f: (v: Invoice) => boolean) => inv.filter(f).reduce((n, v) => n + v.totalCents, 0);
  const OPEN = ["invoiced", "due", "follow_up", "overdue"];
  // Series = team leads, en orden fijo por nombre; más de 5 van a «Otros».
  const leads = [...new Set(inv.map((v) => v.lead?.name ?? "Sin team leader"))].sort();
  const series: Series[] = leads.slice(0, MAX_SERIES).map((name, i) => ({ key: name, label: name, color: vizColor(i) }));
  if (leads.length > MAX_SERIES) series.push({ key: "__other", label: "Otros", color: OTHER_COLOR });
  const seriesOf = (v: Invoice) => {
    const name = v.lead?.name ?? "Sin team leader";
    return leads.indexOf(name) < MAX_SERIES ? name : "__other";
  };
  const months = monthRange(inv);
  const columnsOf = (f: (v: Invoice) => boolean) =>
    months.map((m) => ({ label: monthShort(m), values: Object.fromEntries(series.map((s) => [s.key, inv.filter((v) => v.month === m && seriesOf(v) === s.key && f(v)).reduce((n, v) => n + v.totalCents, 0)])) }));
  const tableOf = (f: (v: Invoice) => boolean) => ({ columns: ["Mes", ...series.map((s) => s.label)], rows: columnsOf(f).map((c) => [c.label, ...series.map((s) => money(c.values[s.key] ?? 0))]) });
  const open = inv.filter((v) => v.effectiveStage !== "paid");
  const openParts = series.map((s) => ({ label: s.label, color: s.color, value: open.filter((v) => seriesOf(v) === s.key).length }));
  const byStage = INVOICE_STAGES.map((st) => ({ label: INVOICE_STAGE_LABELS[st], value: sum((v) => v.effectiveStage === st), text: money(sum((v) => v.effectiveStage === st)), color: TONE_VAR[INVOICE_STAGE_TONE[st]] }));
  return (
    <>
      <KpiRow label="Indicadores">
        <Kpi label="Facturación del mes actual" value={money(sum((v) => v.month === current))} sub={MONTHS[Number(current.slice(5)) - 1]} />
        <Kpi label="Total pendiente de cobro" value={money(sum((v) => OPEN.includes(v.effectiveStage)))} sub="Invoiced, Due, Follow Up y Overdue" />
        <Kpi label="Por cobrar este mes" value={money(sum((v) => v.month === current && v.effectiveStage !== "paid"))} sub="Sin cobrar con mes actual" />
        <Kpi label="Total cobrado" value={money(sum((v) => v.effectiveStage === "paid"))} sub="Invoices en Paid" />
      </KpiRow>
      <div className="grid gap-4 xl:grid-cols-3 [&>*]:min-w-0">
        <ChartCard className="xl:col-span-2" title="Cashflow total por mes" sub="Monto bruto + fee por team leader" table={tableOf(() => true)}>
          <ColumnChart columns={columnsOf(() => true)} series={series} format={short} />
        </ChartCard>
        <ChartCard title="Invoices abiertas por team leader" sub="Todas las que no están en Paid" table={{ columns: ["Team leader", "Invoices"], rows: openParts.map((p) => [p.label, p.value]) }}>
          <Donut parts={openParts} center={String(open.length)} centerLabel="abiertas" />
        </ChartCard>
        <ChartCard className="xl:col-span-2" title="Cashflow pendiente por mes" sub="Solo invoices sin cobrar" table={tableOf((v) => v.effectiveStage !== "paid")}>
          <ColumnChart columns={columnsOf((v) => v.effectiveStage !== "paid")} series={series} format={short} />
        </ChartCard>
        <ChartCard title="Monto por stage" sub="Total de invoices en cada stage" table={{ columns: ["Stage", "Monto"], rows: byStage.map((r) => [r.label, r.text]) }}>
          <BarList rows={byStage} />
        </ChartCard>
      </div>
    </>
  );
}

export function FinancialDashboard() {
  const role = useSession().data?.role;
  return (
    <div className="space-y-6">
      <PageHeader stackOnMobile title="Dashboard Financiero" description="Cashflow, cobranza y estado de las invoices." />
      {canAccess(role, "invoices") ? <FinancialBody /> : <NoAccess what="Invoices" />}
    </div>
  );
}

// ---- Comercial ---------------------------------------------------------------------

interface CommercialData {
  leads: number;
  meetings: number;
  proposals: number;
  byStatus: { key: LeadStatus | null; count: number }[];
  byTemperature: { key: LeadTemperature | null; count: number }[];
  byFunnel: { key: string | null; count: number }[];
  bySource: { key: string | null; count: number }[];
}

/** Propuestas publicadas: el mismo conteo que la pestaña «Publicadas» del tablero Propuestas. */
function useLiveSites(enabled: boolean): number | null {
  const { data } = useSites("live", {}, enabled);
  return enabled ? (data?.counts.live ?? null) : null;
}

function CommercialBody() {
  // Sin caché: los conteos deben ser los de los tableros en este momento.
  const { data, isLoading } = useQuery({ queryKey: ["tableros", "comercial"], queryFn: () => apiFetch<CommercialData>("/api/tableros/comercial"), staleTime: 0 });
  const role = useSession().data?.role;
  const sitesConfig = useSitesConfig();
  const sitesOn = canAccess(role, "proposals") && sitesConfig.data?.configured === true;
  const sites = useLiveSites(sitesOn);
  if (isLoading || !data) return <Skeleton className="h-64 w-full" />;
  const status = data.byStatus.map((r) => ({ label: r.key ? LEAD_STATUS_LABELS[r.key] : "Sin estado", values: { n: r.count } }));
  const temps: (LeadTemperature | null)[] = ["hot", "warm", "nurturing", null];
  const tempParts = temps.map((t, i) => ({ label: t ? LEAD_TEMPERATURE_LABELS[t] : "Sin temperatura", color: t ? vizColor(i) : OTHER_COLOR, value: data.byTemperature.find((r) => r.key === t)?.count ?? 0 })).filter((p) => p.value > 0);
  const top = data.bySource.slice(0, 8);
  const rest = data.bySource.slice(8).reduce((n, r) => n + r.count, 0);
  const sources = [...top.map((r) => ({ label: r.key || "Sin fuente", values: { n: r.count } })), ...(rest ? [{ label: "Otras", values: { n: rest } }] : [])];
  const one: Series[] = [{ key: "n", label: "Leads", color: "var(--viz-1)" }];
  const hot = data.byTemperature.find((r) => r.key === "hot")?.count ?? 0;
  return (
    <>
      <KpiRow label="Indicadores">
        <Kpi label="Leads" value={data.leads} sub={`${hot} en Hot`} />
        <Kpi label="Reuniones" value={data.meetings} sub="Registradas" />
        <Kpi label="Propuestas" value={sites ?? "—"} sub={sites === null ? "Sin conexión con Propuestas" : "Publicadas"} />
      </KpiRow>
      <div className="grid gap-4 xl:grid-cols-3 [&>*]:min-w-0">
        <ChartCard className="xl:col-span-2" title="Leads por estado" sub="Embudo comercial actual" table={{ columns: ["Estado", "Leads"], rows: status.map((c) => [c.label, c.values.n]) }}>
          <ColumnChart columns={status} series={one} format={count} />
        </ChartCard>
        <ChartCard title="Leads por temperatura" sub="Hot, Warm y Nurturing" table={{ columns: ["Temperatura", "Leads"], rows: tempParts.map((p) => [p.label, p.value]) }}>
          <Donut parts={tempParts} center={String(data.leads)} centerLabel="leads" />
        </ChartCard>
        <ChartCard className="xl:col-span-3" title="Leads por fuente" sub="Origen del lead" table={{ columns: ["Fuente", "Leads"], rows: sources.map((c) => [c.label, c.values.n]) }}>
          <ColumnChart columns={sources} series={one} format={count} />
        </ChartCard>
      </div>
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        El pipeline de deals («Pipeline abierto» y «Pipeline por stage») queda fuera hasta decidir cómo se relacionan los deals con Comercial.
      </p>
    </>
  );
}

export function CommercialDashboard() {
  const role = useSession().data?.role;
  return (
    <div className="space-y-6">
      <PageHeader stackOnMobile title="Dashboard Comercial" description="Leads, reuniones y propuestas." />
      {canAccess(role, "leads") ? <CommercialBody /> : <NoAccess what="Leads" />}
    </div>
  );
}

// ---- Operativo ---------------------------------------------------------------------

export function OperationalDashboard() {
  const { data: board, isLoading } = useBoard();
  const projects = useOpsProjects("page=1&pageSize=100").data;
  const [sprintProject, setSprintProject] = useState<string | null>(null);
  const body =
    isLoading || !board || !projects ? (
      <Skeleton className="h-64 w-full" />
    ) : (
      (() => {
        const tasks = board.tasks;
        const done = tasks.filter((t) => statusOf(t) === "done").length;
        const items = workItems(tasks);
        const projected = items.reduce((n, x) => n + x.p, 0);
        const invested = items.reduce((n, x) => n + x.i, 0);
        const activeSprints = board.sprints.filter((s) => sprintState(s, tasks) === "active").length;
        // Conteos sobre todos los proyectos visibles (los del tablero de Tasks), no solo la primera página.
        const all = board.projects;
        const rows = projects.rows;
        const statusParts = TASK_STATUSES.map((s) => ({ label: TASK_STATUS_LABELS[s], color: TONE_VAR[TASK_STATUS_TONE[s]], value: tasks.filter((t) => statusOf(t) === s).length }));
        const noSubs = tasks.filter((t) => !statusOf(t)).length;
        if (noSubs) statusParts.push({ label: "Sin tareas", color: OTHER_COLOR, value: noSubs });
        const ages = rows
          .filter((p) => p.stage !== "completed")
          .map((p) => ({ p, age: stageAge(p.stageSince, projects.sla?.[p.stage] ?? null) }))
          .sort((a, b) => b.age.over - a.age.over);
        const stageCols = STAGES.map((st) => ({ label: STAGE_LABELS[st], values: { n: all.filter((p) => p.stage === st).length } }));
        const sprints = board.sprints.filter((s) => !sprintProject || s.projectId === sprintProject);
        const sprintRows = sprints.map((s) => {
          const all = tasks.filter((t) => t.sprintId === s.id);
          const pct = all.length ? Math.round((all.filter((t) => statusOf(t) === "done").length / all.length) * 100) : 0;
          const project = board.projects.find((p) => p.id === s.projectId);
          return { label: `${sprintProject ? "" : `${project?.name} · `}${sprintLabel(s).split(":")[0]}`, value: pct, text: `${pct}%`, color: "var(--viz-1)", tip: `${sprintLabel(s)} · ${pct}% de ${all.length} tareas` };
        });
        return (
          <>
            <KpiRow label="Indicadores">
              <Kpi label="Proyectos activos" value={all.filter((p) => p.stage !== "completed").length} sub={`${all.length} en total`} />
              <Kpi label="Tareas completadas" value={`${tasks.length ? Math.round((done / tasks.length) * 100) : 0}%`} sub={`${done} de ${tasks.length}`} />
              <Kpi label="Tareas bloqueadas" value={tasks.filter((t) => statusOf(t) === "stuck").length} sub="Status Stuck" />
              <Kpi label="Horas invertidas" value={hoursLabel(Math.round(invested * 10) / 10)} sub={`de ${hoursLabel(Math.round(projected * 10) / 10)} proyectadas`} />
              <Kpi label="Sprints activos" value={activeSprints} sub={`${board.sprints.length} en total`} />
              <Kpi label="Proyectos atascados" value={projects.stuck.length} sub={<Link className="underline-offset-4 hover:underline" to="/operativa">Fuera del tiempo esperado</Link>} />
            </KpiRow>
            <div className="grid gap-4 xl:grid-cols-3 [&>*]:min-w-0">
              <ChartCard title="Tareas por status" sub="Estado actual de todas las tareas" table={{ columns: ["Status", "Tareas"], rows: statusParts.map((p) => [p.label, p.value]) }}>
                <Donut parts={statusParts} center={String(tasks.length)} centerLabel="tareas" />
              </ChartCard>
              <ChartCard className="xl:col-span-2" title="Tiempo en etapa por proyecto" sub="Días en la etapa actual · esperado entre paréntesis" table={{ columns: ["Proyecto", "Etapa", "Días", "Esperado"], rows: ages.map(({ p, age }) => [p.name, STAGE_LABELS[p.stage], age.days, age.sla ?? "—"]) }}>
                <BarList rows={ages.map(({ p, age }) => ({ label: `${p.name} · ${STAGE_LABELS[p.stage]}`, value: age.days, text: `${age.days} d${age.sla ? ` (${age.sla})` : ""}`, color: TONE_VAR[age.tone] }))} />
              </ChartCard>
              <ChartCard className="xl:col-span-3" title="Proyectos por etapa" sub="Etapa actual de cada proyecto" table={{ columns: ["Etapa", "Proyectos"], rows: stageCols.map((c) => [c.label, c.values.n]) }}>
                <ColumnChart columns={stageCols} series={[{ key: "n", label: "Proyectos", color: "var(--viz-1)" }]} format={count} height={200} />
              </ChartCard>
              <ChartCard className="xl:col-span-3" title="Horas por persona" sub="Distribuidas por día entre el inicio y el fin de cada tarea" table={{ columns: ["Persona", "Invertidas", "Facturables", "Proyectadas"], rows: board.people.map((p) => { const mine = items.filter((x) => x.owner === p.id); return [p.name, hoursLabel(mine.reduce((n, x) => n + x.i, 0)), hoursLabel(mine.reduce((n, x) => n + x.b, 0)), hoursLabel(mine.reduce((n, x) => n + x.p, 0))]; }) }}>
                <HoursGrid board={board} />
              </ChartCard>
              <ChartCard
                className="xl:col-span-3"
                title="Avance por sprint"
                sub="% de tareas completadas"
                action={
                  <div className="w-52">
                    <Select label="Filtrar por proyecto" size="sm" value={sprintProject} emptyLabel="Todos los proyectos" options={board.projects.filter((p) => board.sprints.some((s) => s.projectId === p.id)).map((p) => ({ value: p.id, label: p.name }))} onValueChange={setSprintProject} />
                  </div>
                }
                table={{ columns: ["Sprint", "Avance"], rows: sprintRows.map((r) => [r.label, r.text]) }}
              >
                <BarList rows={sprintRows} />
              </ChartCard>
            </div>
          </>
        );
      })()
    );
  return (
    <div className="space-y-6">
      <PageHeader stackOnMobile title="Dashboard Operativo" description="Proyectos, tareas, sprints y horas del equipo." />
      {body}
    </div>
  );
}
