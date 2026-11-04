import { useSearchParams } from "react-router-dom";
import { PageHeader } from "@/components/layout/PageHeader";
import { Kpi, KpiRow } from "@/components/ui/kpi";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { api, hoursLabel, sprintLabel, useBoard, useBoardAction } from "./api";
import { workItems, type WorkItem } from "./filters";
import { due, myWork, type MyWorkGroups } from "./planning";
import { HoursInput, StatusSelect } from "./TaskBoard";
import { TaskDetail } from "./TaskDetail";

const GROUPS: { key: keyof MyWorkGroups; label: string; dot: string }[] = [
  { key: "overdue", label: "Vencidas", dot: "bg-danger" },
  { key: "week", label: "Esta semana", dot: "bg-warn" },
  { key: "later", label: "Próximas", dot: "bg-info" },
  { key: "noDate", label: "Sin fecha", dot: "bg-muted-foreground" },
  { key: "done", label: "Completadas", dot: "bg-ok" },
];

/**
 * Mi trabajo: las tareas y subtareas abiertas de una persona, por fecha de entrega. Cambia el status
 * y registra horas aquí mismo (lo que la API permita según el rol).
 */
export default function MyWorkPage() {
  const { data: board, isLoading, error } = useBoard();
  const run = useBoardAction();
  const [params, setParams] = useSearchParams();
  const [detail, setDetail] = useState<{ taskId: string; subId: string | null } | null>(null);
  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error || !board) return <p role="alert" className="text-sm text-destructive">{error instanceof Error ? error.message : "No se pudo cargar tu trabajo."}</p>;

  const today = new Date().toISOString().slice(0, 10);
  const asked = params.get("as");
  const person = board.people.find((p) => p.id === asked) ?? board.people.find((p) => p.id === board.me) ?? board.people[0];
  const groups = person ? myWork(board, person.id, today) : null;
  const openItems = groups ? [...groups.overdue, ...groups.week, ...groups.later, ...groups.noDate] : [];
  const all = person ? workItems(board.tasks).filter((x) => x.owner === person.id) : [];
  const projected = all.reduce((n, x) => n + x.p, 0);
  const invested = all.reduce((n, x) => n + x.i, 0);
  const projectOf = new Map(board.projects.map((p) => [p.id, p]));
  const sprintOf = new Map(board.sprints.map((s) => [s.id, s]));
  const canEdit = (x: WorkItem) => {
    const p = projectOf.get(x.task.projectId);
    return Boolean(p?.canManage || (p?.canWork && x.owner === board.me));
  };

  return (
    <div className="space-y-6">
      <PageHeader
        stackOnMobile
        title="Mi trabajo"
        description={<span className="max-sm:hidden">Tus tareas y subtareas abiertas, por fecha de entrega. Actualiza el status y registra tus horas desde aquí.</span>}
        actions={
          board.people.length > 0 ? (
            <div className="w-52">
              <Select label="Ver como" value={person?.id ?? null} options={board.people.map((p) => ({ value: p.id, label: p.name, description: p.role === "lead" ? "Team Leader" : "Developer" }))} onValueChange={(v) => setParams(v && v !== board.me ? { as: v } : {}, { replace: true })} />
            </div>
          ) : undefined
        }
      />

      {!person || !groups ? (
        <p className="rounded-2xl border border-border bg-card p-10 text-center text-sm text-muted-foreground">Aún no hay personas en los equipos que ves.</p>
      ) : (
        <>
          <KpiRow label="Indicadores">
            <Kpi label="Tareas abiertas" value={openItems.length} sub={`Asignadas a ${person.name}`} />
            <Kpi label="Vencidas" value={groups.overdue.length} sub="Con fecha pasada" />
            <Kpi label="Esta semana" value={groups.week.length} sub="Vencen en 7 días" />
            <Kpi label="Horas por hacer" value={hoursLabel(openItems.reduce((n, x) => n + Math.max(0, x.p - x.i), 0))} sub="Proyectadas − invertidas" />
          </KpiRow>

          <section aria-label="Horas" className="space-y-2 rounded-2xl border border-border bg-card p-4">
            <div className="flex flex-wrap justify-between gap-2 text-sm">
              <b>Horas</b>
              <span className="text-muted-foreground">
                {hoursLabel(invested)} invertidas de {hoursLabel(projected)} proyectadas
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Horas invertidas" aria-valuenow={Math.round(projected ? (invested / projected) * 100 : 0)} aria-valuemin={0} aria-valuemax={100}>
              <div className={cn("h-full rounded-full", invested > projected ? "bg-danger" : "bg-ok")} style={{ width: `${projected ? Math.min(100, (invested / projected) * 100) : 0}%` }} />
            </div>
          </section>

          {!openItems.length && (
            <p className="rounded-2xl border border-border bg-card p-10 text-center text-sm text-muted-foreground">
              <b className="block text-foreground">No hay tareas abiertas</b>
              Avisa a tu team leader para que te asigne trabajo.
            </p>
          )}

          {GROUPS.filter((g) => groups[g.key].length).map((g) => (
            <section key={g.key} aria-label={g.label} className="rounded-2xl border border-border bg-card px-4 pb-2">
              <h2 className="flex items-center gap-2 py-3 font-semibold">
                <span aria-hidden className={cn("size-2 rounded-full", g.dot)} />
                {g.label}
                <span className="text-sm font-normal text-muted-foreground">
                  {groups[g.key].length} {groups[g.key].length === 1 ? "tarea" : "tareas"}
                </span>
              </h2>
              {groups[g.key].map((x) => {
                const project = projectOf.get(x.task.projectId);
                const sprint = x.task.sprintId ? sprintOf.get(x.task.sprintId) : undefined;
                const d = due(x, today);
                const id = x.sub?.id ?? x.task.id;
                const editable = canEdit(x);
                return (
                  <div key={id} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border py-3">
                    <div className="min-w-60 flex-1">
                      <button type="button" className="text-left font-semibold hover:underline" onClick={() => setDetail({ taskId: x.task.id, subId: x.sub?.id ?? null })}>
                        {x.title}
                      </button>
                      <p className="text-xs text-muted-foreground">{[x.sub ? x.task.title : null, project?.name, sprint ? sprintLabel(sprint).split(":")[0] : null].filter(Boolean).join(" · ")}</p>
                    </div>
                    <StatusBadge tone={d.tone}>{d.text}</StatusBadge>
                    <div className="w-40">
                      {x.sub ? (
                        <StatusSelect label={`Status de ${x.title}`} value={x.sub.status} disabled={!editable} onSave={(status) => void run(() => api.updateTask(id, { status }))} />
                      ) : (
                        <span title="Esta tarea no tiene subtareas: ábrela para agregarlas">
                          <StatusBadge tone="neutral">Sin subtareas</StatusBadge>
                        </span>
                      )}
                    </div>
                    <span className="flex items-center gap-2 text-sm">
                      <HoursInput label={`Horas invertidas de ${x.title}`} value={x.i} disabled={!editable} onSave={(investedHours) => void run(() => api.updateTask(id, { investedHours }))} />
                      <span className="whitespace-nowrap text-muted-foreground">de {hoursLabel(x.p)}</span>
                    </span>
                  </div>
                );
              })}
            </section>
          ))}
        </>
      )}
      <TaskDetail board={board} taskId={detail?.taskId ?? null} subId={detail?.subId ?? null} onClose={() => setDetail(null)} onOpen={(taskId, subId) => setDetail({ taskId, subId: subId ?? null })} />
    </div>
  );
}
