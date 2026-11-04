import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Plus, Search, Undo2 } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kpi, KpiRow } from "@/components/ui/kpi";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatDate } from "@/lib/format";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { api, hoursLabel, SPRINT_STATE, sprintLabel, sprintState, useBoard, useBoardAction, type Task } from "./api";
import { workItems } from "./filters";
import { HOURS_PER_DAY, sprintCapacity } from "./planning";
import { Owners } from "./TaskBoard";
import { TaskDetail } from "./TaskDetail";

const hoursToDo = (items: ReturnType<typeof workItems>) => items.reduce((n, x) => n + Math.max(0, x.p - x.i), 0);

/**
 * Backlog / Sprints: prioriza las tareas sin sprint y asígnalas según la capacidad del equipo
 * (6 h por día hábil por developer), para que cada developer tenga trabajo a la mano.
 */
export default function BacklogPage() {
  const { data: board, isLoading, error } = useBoard();
  const run = useBoardAction();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState("");
  const [detail, setDetail] = useState<{ taskId: string; subId: string | null } | null>(null);
  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error || !board) return <p role="alert" className="text-sm text-destructive">{error instanceof Error ? error.message : "No se pudo cargar el backlog."}</p>;

  const today = new Date().toISOString().slice(0, 10);
  const projectId = params.get("project") ?? undefined;
  const names = new Map(board.people.map((p) => [p.id, p.name]));
  const projectOf = new Map(board.projects.map((p) => [p.id, p]));
  const inScope = (t: Task) => !projectId || t.projectId === projectId;
  const needle = q.trim().toLowerCase();
  const backlog = board.tasks.filter((t) => !t.sprintId && inScope(t) && (!needle || `${t.title} ${projectOf.get(t.projectId)?.name}`.toLowerCase().includes(needle)));
  const sprints = board.sprints.filter((s) => !projectId || s.projectId === projectId).sort((a, b) => a.startDate.localeCompare(b.startDate));
  const openItems = workItems(board.tasks).filter((x) => x.status !== "done");
  const developers = board.people
    .filter((p) => p.role === "developer")
    .map((p) => {
      const mine = openItems.filter((x) => x.owner === p.id);
      return { ...p, count: mine.length, todo: hoursToDo(mine) };
    })
    .sort((a, b) => a.count - b.count);
  const activeHours = board.sprints.filter((s) => sprintState(s, board.tasks, today) === "active").reduce((n, s) => n + board.tasks.filter((t) => t.sprintId === s.id).reduce((m, t) => m + t.derived.estimatedHours, 0), 0);
  const allBacklog = board.tasks.filter((t) => !t.sprintId && inScope(t));
  const noOwner = board.tasks.filter((t) => inScope(t) && t.derived.status !== "done" && !t.derived.ownerIds.length).length;
  const creatable = board.projects.find((p) => p.id === projectId && p.canManage) ?? board.projects.find((p) => p.canManage);

  const assign = async (task: Task, sprintId: string) => {
    if (await run(() => api.updateTask(task.id, { sprintId }))) {
      const s = board.sprints.find((x) => x.id === sprintId);
      toast.success(`Asignada a ${s ? sprintLabel(s) : "sprint"}`, { undo: () => run(() => api.updateTask(task.id, { sprintId: null })) });
    }
  };
  const toBacklog = async (task: Task) => {
    const prev = task.sprintId;
    if (await run(() => api.updateTask(task.id, { sprintId: null }))) toast.success("Devuelta al backlog", { undo: () => run(() => api.updateTask(task.id, { sprintId: prev })) });
  };
  const newTask = async () => {
    if (!creatable) return;
    const created = await run(() => api.createTask({ projectId: creatable.id, title: "Nueva tarea", sprintId: null }));
    if (created) setDetail({ taskId: created.task.id, subId: null });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        stackOnMobile
        title="Backlog / Sprints"
        description={<span className="max-sm:hidden">Prioriza el backlog y asigna tareas a cada sprint según la capacidad del equipo ({HOURS_PER_DAY} h por día hábil por developer).</span>}
        actions={
          <div className="flex flex-wrap gap-2">
            <div className="w-full sm:w-56">
              <Select label="Filtrar por proyecto" value={projectId ?? null} emptyLabel="Todos los proyectos" options={board.projects.map((p) => ({ value: p.id, label: p.name }))} onValueChange={(v) => setParams(v ? { project: v } : {}, { replace: true })} />
            </div>
            {creatable && (
              <Button size="lg" onClick={() => void newTask()}>
                <Plus /> Nueva <span className="max-sm:hidden">tarea</span>
              </Button>
            )}
          </div>
        }
      />

      <KpiRow label="Indicadores">
        <Kpi label="En backlog" value={allBacklog.length} sub={`${hoursLabel(allBacklog.reduce((n, t) => n + t.derived.estimatedHours, 0))} por planificar`} />
        <Kpi label="En sprints activos" value={hoursLabel(activeHours)} sub="Planificadas" />
        <Kpi label="Developers sin tareas" value={developers.filter((d) => !d.count).length} sub={developers.some((d) => !d.count) ? "Asigna trabajo desde el backlog" : "Todos tienen trabajo"} />
        <Kpi label="Tareas sin owner" value={noOwner} sub="Sin responsable" />
      </KpiRow>

      <section aria-label="Disponibilidad de developers" className="space-y-2 rounded-2xl border border-border bg-card p-4">
        <h2 className="font-semibold">Disponibilidad de developers</h2>
        <p className="text-xs text-muted-foreground">Tareas abiertas y horas por hacer de cada developer. Los que no tienen tareas aparecen primero. Haz clic para ver su trabajo.</p>
        <div className="flex flex-wrap gap-2">
          {developers.map((d) => (
            <Link key={d.id} to={`/operativa/mi-trabajo?as=${d.id}`} className="inline-flex items-center gap-2 rounded-xl border border-border px-3 py-1.5 text-sm hover:bg-accent">
              <Owners ids={[d.id]} names={names} />
              <b>{d.name}</b>
              <StatusBadge tone={!d.count ? "danger" : d.count === 1 ? "warn" : "ok"}>{!d.count ? "Sin tareas" : `${d.count} ${d.count === 1 ? "abierta" : "abiertas"} · ${hoursLabel(d.todo)} por hacer`}</StatusBadge>
            </Link>
          ))}
          {!developers.length && <p className="text-sm text-muted-foreground">No hay developers en los equipos que ves.</p>}
        </div>
      </section>

      <div className="grid items-start gap-4 xl:grid-cols-2 [&>*]:min-w-0">
        <section aria-label="Backlog" className="rounded-2xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">Backlog</h2>
            <label className="flex h-9 w-full items-center gap-2 rounded-lg border border-input px-2.5 sm:w-56">
              <Search className="size-3.5 text-muted-foreground" aria-hidden />
              <Input className="h-auto border-0 bg-transparent p-0 focus-visible:ring-0 dark:bg-transparent" aria-label="Buscar en backlog" placeholder="Buscar tarea" value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
          </div>
          <p className="mb-2 text-xs text-muted-foreground">Tareas sin sprint. Asigna un sprint y un owner.</p>
          {!backlog.length && <p className="py-8 text-center text-sm text-muted-foreground">Backlog vacío: todas las tareas ya tienen sprint.</p>}
          {backlog.map((t) => {
            const project = projectOf.get(t.projectId);
            const manage = Boolean(project?.canManage);
            const open = board.sprints.filter((s) => s.projectId === t.projectId && s.endDate >= today);
            return (
              <div key={t.id} className="space-y-2 border-t border-border py-3">
                <div className="flex items-start justify-between gap-3">
                  <button type="button" className="text-left font-semibold hover:underline" onClick={() => setDetail({ taskId: t.id, subId: null })}>
                    {t.title}
                  </button>
                  <span className="font-semibold whitespace-nowrap tabular-nums">{hoursLabel(t.derived.estimatedHours)}</span>
                </div>
                <p className="text-xs text-muted-foreground">{project?.name}</p>
                <div className="flex flex-wrap items-center gap-2">
                  {t.subtasks.length ? (
                    <>
                      <Owners ids={t.derived.ownerIds} names={names} />
                      <span className="text-xs text-muted-foreground">{t.subtasks.length} subtareas</span>
                    </>
                  ) : manage ? (
                    <div className="w-44">
                      <Select label={`Owner de ${t.title}`} size="sm" value={t.assigneeUserId} emptyLabel="Sin asignar" options={board.people.filter((p) => p.teamId === project?.team.id).map((p) => ({ value: p.id, label: p.name }))} onValueChange={(v) => void run(() => api.updateTask(t.id, { assigneeUserId: v }))} />
                    </div>
                  ) : (
                    <Owners ids={t.derived.ownerIds} names={names} />
                  )}
                  {manage && (
                    <div className="w-56">
                      <Select label={`Asignar ${t.title} a sprint`} size="sm" value={null} disabled={!open.length} placeholder={open.length ? "Asignar a sprint…" : "Sin sprints abiertos"} options={open.map((s) => ({ value: s.id, label: sprintLabel(s) }))} onValueChange={(v) => v && void assign(t, v)} />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </section>

        <div className="space-y-4">
          {!sprints.length && <p className="rounded-2xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">No hay sprints para este filtro. Créalos desde Tasks.</p>}
          {sprints.map((s) => {
            const project = projectOf.get(s.projectId);
            const st = sprintState(s, board.tasks, today);
            const cap = sprintCapacity(board, s);
            const pct = cap.capacity ? (cap.planned / cap.capacity) * 100 : 0;
            const over = cap.planned > cap.capacity;
            return (
              <section key={s.id} aria-label={sprintLabel(s)} className="space-y-3 rounded-2xl border border-border bg-card p-4">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <b>{sprintLabel(s)}</b>
                  <StatusBadge tone={SPRINT_STATE[st].tone}>{SPRINT_STATE[st].label}</StatusBadge>
                  <span className="text-xs text-muted-foreground">
                    {project?.name} · {formatDate(s.startDate)} → {formatDate(s.endDate)}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={`Capacidad usada de ${sprintLabel(s)}`} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
                  <div className={cn("h-full rounded-full", over ? "bg-danger" : pct > 85 ? "bg-warn" : "bg-ok")} style={{ width: `${Math.min(100, pct)}%` }} />
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>
                    {hoursLabel(cap.planned)} planificadas / {hoursLabel(cap.capacity)} de capacidad ({cap.days} días hábiles)
                  </span>
                  {over && <StatusBadge tone="danger">Sobrecargado +{hoursLabel(cap.planned - cap.capacity)}</StatusBadge>}
                </div>
                {cap.load.size > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {[...cap.load.entries()].map(([who, h]) => (
                      <StatusBadge key={who ?? "none"} tone={!who ? "warn" : h > cap.perPerson ? "danger" : "neutral"}>
                        {who ? names.get(who) : "Sin asignar"} · {hoursLabel(h)}
                        {who ? ` / ${hoursLabel(cap.perPerson)}` : ""}
                      </StatusBadge>
                    ))}
                  </div>
                )}
                {!cap.tasks.length && <p className="text-sm text-muted-foreground">Sin tareas. Asigna tareas desde el backlog.</p>}
                {cap.tasks.map((t) => (
                  <div key={t.id} className="flex items-center gap-3 border-t border-border pt-2">
                    <button type="button" className="min-w-0 flex-1 truncate text-left font-medium hover:underline" onClick={() => setDetail({ taskId: t.id, subId: null })}>
                      {t.title}
                    </button>
                    {!t.derived.ownerIds.length && <StatusBadge tone="warn">Sin owner</StatusBadge>}
                    <Owners ids={t.derived.ownerIds} names={names} />
                    <span className="w-12 text-right font-semibold tabular-nums">{hoursLabel(t.derived.estimatedHours)}</span>
                    {project?.canManage && (
                      <Button size="sm" variant="ghost" title="Devolver al backlog" onClick={() => void toBacklog(t)}>
                        <Undo2 /> Backlog
                      </Button>
                    )}
                  </div>
                ))}
              </section>
            );
          })}
        </div>
      </div>
      <TaskDetail board={board} taskId={detail?.taskId ?? null} subId={detail?.subId ?? null} onClose={() => setDetail(null)} onOpen={(taskId, subId) => setDetail({ taskId, subId: subId ?? null })} />
    </div>
  );
}
