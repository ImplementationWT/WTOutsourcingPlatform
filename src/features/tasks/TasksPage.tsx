import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Plus, Search } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kpi, KpiRow } from "@/components/ui/kpi";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";
import { api, hoursLabel, sprintLabel, statusOf, TASK_STATUS_LABELS, TASK_STATUSES, useBoard, useBoardAction, type Board, type TaskStatus } from "./api";
import { filterTasks, nextSprintDates, workItems, type TaskFilters } from "./filters";
import { TaskBoard, type BoardView } from "./TaskBoard";
import { TaskDetail } from "./TaskDetail";

type Tab = "all" | "mine" | "sprints" | "hours" | "notimeline";
const TABS: { id: Tab; label: string }[] = [
  { id: "all", label: "Todas" },
  { id: "mine", label: "Mis tareas" },
  { id: "sprints", label: "Sprints" },
  { id: "hours", label: "Horas" },
  { id: "notimeline", label: "Sin timeline" },
];

/** Crear tarea y sprint con valores razonables, y abrir la tarea nueva. */
function useCreators(board: Board | undefined, open: (id: string) => void) {
  const run = useBoardAction();
  const target = (projectId?: string) => board?.projects.find((p) => p.id === projectId && p.canManage) ?? board?.projects.find((p) => p.canManage);
  return {
    canCreate: Boolean(board?.projects.some((p) => p.canManage)),
    async task({ projectId, sprintId, ownerId }: { projectId?: string; sprintId?: string; ownerId?: string }) {
      const project = target(projectId);
      if (!board || !project) return;
      const today = new Date().toISOString().slice(0, 10);
      const sprints = board.sprints.filter((s) => s.projectId === project.id);
      const sprint = sprints.find((s) => s.id === sprintId) ?? sprints.find((s) => s.startDate <= today && today <= s.endDate) ?? null;
      const owner = ownerId && board.people.some((p) => p.id === ownerId && p.teamId === project.team.id) ? ownerId : (project.developerUserIds[0] ?? project.leadUserId);
      const created = await run(() => api.createTask({ projectId: project.id, title: "Nueva tarea", sprintId: sprint?.id ?? null, assigneeUserId: owner ?? null }));
      if (created) open(created.task.id);
    },
    async sprint(projectId?: string) {
      const project = target(projectId);
      if (!board || !project) return;
      const n = board.sprints.filter((s) => s.projectId === project.id).length + 1;
      await run(() => api.createSprint({ projectId: project.id, name: n === 1 ? "Kick-Off" : "Nuevo sprint", ...nextSprintDates(board, project.id) }));
    },
  };
}

function HoursView({ board, projectId }: { board: Board; projectId?: string }) {
  const tasks = board.tasks.filter((t) => !projectId || t.projectId === projectId);
  const items = workItems(tasks);
  const sum = (list: typeof items, k: "p" | "i" | "b") => list.reduce((n, x) => n + x[k], 0);
  const bar = (base: number, used: number) => (
    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
      <div className={cn("h-full rounded-full", base > 0 && used > base ? "bg-danger" : "bg-ok")} style={{ width: `${base > 0 ? Math.min(100, (used / base) * 100) : used > 0 ? 100 : 0}%` }} />
    </div>
  );
  const people = board.people
    .map((p) => {
      const mine = items.filter((x) => x.owner === p.id);
      return { ...p, n: mine.length, pr: sum(mine, "p"), inv: sum(mine, "i"), bill: sum(mine, "b") };
    })
    .filter((p) => p.n > 0);
  const projects = board.projects
    .filter((p) => !projectId || p.id === projectId)
    .map((p) => {
      const mine = items.filter((x) => x.task.projectId === p.id);
      return { ...p, pr: sum(mine, "p"), inv: sum(mine, "i"), bill: sum(mine, "b") };
    });
  const teamName = new Map(board.projects.map((p) => [p.team.id, p.team.name]));
  const table = "w-full min-w-[34rem] text-sm";
  const th = "text-caps-label px-3 py-2 text-left font-semibold";
  return (
    <div className="grid gap-4 2xl:grid-cols-2">
      <section className="overflow-x-auto rounded-2xl border border-border bg-card p-4">
        <h2 className="font-semibold">Horas por persona</h2>
        <p className="mb-3 text-xs text-muted-foreground">Suma de tareas y subtareas asignadas.</p>
        <table className={table}>
          <caption className="sr-only">Horas por persona</caption>
          <thead>
            <tr>{["Persona", "Ítems", "Proyectadas", "Invertidas", "Facturables", "Desvío"].map((h) => <th key={h} className={th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.id} className="border-t border-border">
                <td className="px-3 py-2.5">
                  <b className="block">{p.name}</b>
                  <span className="text-xs text-muted-foreground">{teamName.get(p.teamId) ?? ""}</span>
                  {bar(p.pr, p.inv)}
                </td>
                <td className="px-3 tabular-nums">{p.n}</td>
                <td className="px-3 tabular-nums">{hoursLabel(p.pr)}</td>
                <td className="px-3 tabular-nums">{hoursLabel(p.inv)}</td>
                <td className="px-3 tabular-nums">{hoursLabel(p.bill)}</td>
                <td className="px-3">
                  <StatusBadge tone={p.inv > p.pr ? "danger" : "ok"}>{(p.inv - p.pr > 0 ? "+" : p.inv - p.pr < 0 ? "−" : "") + hoursLabel(Math.abs(p.inv - p.pr))}</StatusBadge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!people.length && <p className="py-6 text-center text-sm text-muted-foreground">Nadie tiene horas asignadas.</p>}
      </section>
      <section className="overflow-x-auto rounded-2xl border border-border bg-card p-4">
        <h2 className="font-semibold">Horas por proyecto</h2>
        <p className="mb-3 text-xs text-muted-foreground">Vendidas (deals aprobados en adelante) vs. horas invertidas en tareas.</p>
        <table className={table}>
          <caption className="sr-only">Horas por proyecto</caption>
          <thead>
            <tr>{["Proyecto", "Vendidas", "Proyectadas", "Invertidas", "Facturables", "Uso"].map((h) => <th key={h} className={th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id} className="border-t border-border">
                <td className="px-3 py-2.5">
                  <b className="block">{p.name}</b>
                  <span className="text-xs text-muted-foreground">{p.team.name}</span>
                  {bar(p.soldHours, p.inv)}
                </td>
                <td className="px-3 tabular-nums">{hoursLabel(p.soldHours)}</td>
                <td className="px-3 tabular-nums">{hoursLabel(p.pr)}</td>
                <td className="px-3 tabular-nums">{hoursLabel(p.inv)}</td>
                <td className="px-3 tabular-nums">{hoursLabel(p.bill)}</td>
                <td className="px-3">
                  <StatusBadge tone={p.soldHours && p.inv > p.soldHours ? "danger" : "ok"}>{p.soldHours ? `${Math.round((p.inv / p.soldHours) * 100)}% usado` : "—"}</StatusBadge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function useDetail() {
  const [detail, setDetail] = useState<{ taskId: string; subId: string | null } | null>(null);
  return { detail, open: (taskId: string, subId?: string) => setDetail({ taskId, subId: subId ?? null }), close: () => setDetail(null) };
}

/** Pestaña Tasks del proyecto: la misma tabla, filtrada por el proyecto, con vistas «Por sprint» y «Lista». */
export function ProjectTasksPanel({ projectId }: { projectId: string }) {
  const { data: board } = useBoard();
  const { detail, open, close } = useDetail();
  const create = useCreators(board, (id) => open(id));
  const [view, setView] = useState<BoardView>("sprints");
  if (!board) return <Skeleton className="h-48 w-full" />;
  const project = board.projects.find((p) => p.id === projectId);
  const tasks = board.tasks.filter((t) => t.projectId === projectId);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Vista de tareas" className="inline-flex rounded-xl bg-muted p-1">
          {(["sprints", "list"] as const).map((v) => (
            <button key={v} role="tab" type="button" aria-selected={view === v} onClick={() => setView(v)} className={cn("h-8 rounded-lg px-3 text-sm font-medium", view === v ? "bg-card font-semibold shadow-sm" : "text-muted-foreground")}>
              {v === "sprints" ? "Por sprint" : "Lista"}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to={`/operativa/tasks?project=${projectId}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Ver en Tasks →
          </Link>
          {project?.canManage && (
            <>
              <Button size="sm" variant="outline" onClick={() => void create.sprint(projectId)}>
                <Plus /> Nuevo sprint
              </Button>
              <Button size="sm" onClick={() => void create.task({ projectId })}>
                <Plus /> Nueva tarea
              </Button>
            </>
          )}
        </div>
      </div>
      <TaskBoard board={board} tasks={tasks} view={view} showProject={false} projectId={projectId} onOpen={open} />
      <TaskDetail board={board} taskId={detail?.taskId ?? null} subId={detail?.subId ?? null} onClose={close} onOpen={open} />
    </div>
  );
}

/** Tasks: tablero de tareas de developers y team leaders (proyecto, sprint, subtareas y horas). */
export default function TasksPage() {
  const { data: board, isLoading, error } = useBoard();
  const [params, setParams] = useSearchParams();
  const { detail, open, close } = useDetail();
  const create = useCreators(board, (id) => open(id));
  const get = (k: string) => params.get(k) ?? undefined;
  const set = (k: string, v: string | null | undefined) =>
    setParams(
      (cur) => {
        const next = new URLSearchParams(cur);
        if (v) next.set(k, v);
        else next.delete(k);
        if (k === "project") next.delete("sprint");
        return next;
      },
      { replace: true },
    );
  const tab = (TABS.find((t) => t.id === get("tab"))?.id ?? "all") as Tab;
  const me = get("as") ?? board?.me ?? "";
  const filters: TaskFilters = { q: get("q"), projectId: get("project"), sprintId: get("sprint"), ownerId: get("owner"), status: get("status") as TaskStatus | undefined, mineOf: tab === "mine" ? me : undefined, noTimeline: tab === "notimeline" };

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error || !board) return <p role="alert" className="text-sm text-destructive">{error instanceof Error ? error.message : "No se pudo cargar Tasks."}</p>;

  const tasks = filterTasks(board, filters);
  const sumH = (k: "estimatedHours" | "investedHours") => tasks.reduce((n, t) => n + t.derived[k], 0);
  const count = (s: TaskStatus) => tasks.filter((t) => statusOf(t) === s).length;
  const counts: Record<Tab, number | null> = {
    all: board.tasks.length,
    mine: filterTasks(board, { mineOf: me }).length,
    sprints: board.sprints.length,
    hours: null,
    notimeline: filterTasks(board, { noTimeline: true }).length,
  };
  const narrowed = Boolean(filters.q || filters.ownerId || filters.status || filters.sprintId || filters.mineOf || filters.noTimeline);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tasks"
        description={<span className="max-sm:hidden">Tareas de developers y team leaders: cada una en un proyecto, con su sprint, subtareas y horas.</span>}
        actions={
          create.canCreate ? (
            <div className="flex gap-2">
              <Button size="lg" variant="outline" onClick={() => void create.sprint(filters.projectId)}>
                <Plus /> Nuevo <span className="max-sm:hidden">sprint</span>
              </Button>
              <Button size="lg" onClick={() => void create.task({ projectId: filters.projectId, sprintId: filters.sprintId, ownerId: tab === "mine" ? me : undefined })}>
                <Plus /> Nueva <span className="max-sm:hidden">tarea</span>
              </Button>
            </div>
          ) : undefined
        }
      />

      <KpiRow label="Resumen de tareas">
        <Kpi label="Tareas" value={tasks.length} />
        <Kpi label="Completadas" value={count("done")} />
        <Kpi label="En curso" value={count("in_progress")} />
        <Kpi label="Bloqueadas" value={count("stuck")} />
        <Kpi label="Horas proyectadas" value={hoursLabel(sumH("estimatedHours"))} />
        <Kpi label="Horas invertidas" value={hoursLabel(sumH("investedHours"))} />
      </KpiRow>

      <div role="tablist" aria-label="Vistas de Tasks" className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((t) => (
          <button key={t.id} role="tab" type="button" aria-selected={tab === t.id} onClick={() => set("tab", t.id === "all" ? null : t.id)} className={cn("-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-semibold", tab === t.id ? "border-primary" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {t.label}
            {counts[t.id] !== null && <span className="rounded-full bg-muted px-1.5 text-xs">{counts[t.id]}</span>}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex h-control w-full items-center gap-2 rounded-lg border border-input bg-card px-3 sm:w-64 dark:bg-white/[0.03]">
          <Search className="size-4 text-muted-foreground" aria-hidden />
          <Input className="h-auto border-0 bg-transparent p-0 focus-visible:ring-0 dark:bg-transparent" aria-label="Buscar tarea" placeholder="Buscar tarea o subtarea" value={get("q") ?? ""} onChange={(e) => set("q", e.target.value)} />
        </label>
        {tab === "mine" && (
          <div className="w-48">
            <Select label="Ver como" value={me} options={board.people.map((p) => ({ value: p.id, label: p.name }))} onValueChange={(v) => set("as", v === board.me ? null : v)} />
          </div>
        )}
        <div className="w-52">
          <Select label="Filtrar por proyecto" value={filters.projectId ?? null} emptyLabel="Todos los proyectos" options={board.projects.map((p) => ({ value: p.id, label: p.name }))} onValueChange={(v) => set("project", v)} />
        </div>
        <div className="w-60">
          <Select
            label="Filtrar por sprint"
            value={filters.sprintId ?? null}
            emptyLabel="Todos los sprints"
            options={board.sprints.filter((s) => !filters.projectId || s.projectId === filters.projectId).map((s) => ({ value: s.id, label: (filters.projectId ? "" : `${board.projects.find((p) => p.id === s.projectId)?.name} · `) + sprintLabel(s) }))}
            onValueChange={(v) => set("sprint", v)}
          />
        </div>
        <div className="w-44">
          <Select label="Filtrar por owner" value={filters.ownerId ?? null} emptyLabel="Todos los owners" options={board.people.map((p) => ({ value: p.id, label: p.name }))} onValueChange={(v) => set("owner", v)} />
        </div>
        <div className="w-44">
          <Select label="Filtrar por status" value={filters.status ?? null} emptyLabel="Todos los status" options={TASK_STATUSES.map((s) => ({ value: s, label: TASK_STATUS_LABELS[s] }))} onValueChange={(v) => set("status", v)} />
        </div>
      </div>

      {tab === "hours" ? (
        <HoursView board={board} projectId={filters.projectId} />
      ) : (
        <TaskBoard board={board} tasks={tasks} view={tab === "sprints" ? "sprints" : "list"} showProject projectId={filters.projectId} narrowed={narrowed} onOpen={open} />
      )}
      <TaskDetail board={board} taskId={detail?.taskId ?? null} subId={detail?.subId ?? null} onClose={close} onOpen={open} />
    </div>
  );
}
