import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { api, sprintLabel, useBoardAction, type Board, type Subtask, type Task, type TaskPatch } from "./api";
import { HoursInput, NameEdit, Owners, StatusBar, StatusSelect } from "./TaskBoard";

function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <p className="text-caps-label">{label}</p>
      <div className="flex min-h-control items-center text-sm">{children}</div>
    </div>
  );
}

/** Detalles en texto: guarda al salir del campo. */
function DetailsText({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Textarea
      aria-label="Detalles"
      rows={5}
      disabled={disabled}
      placeholder="Haz clic aquí para agregar texto"
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== value) onSave(draft);
        setDraft(null);
      }}
    />
  );
}

function Updates({ taskId, canWrite }: { taskId: string; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const run = useBoardAction();
  const key = ["tasks", "updates", taskId];
  const { data } = useQuery({ queryKey: key, queryFn: async () => (await api.updates(taskId)).updates });
  const [text, setText] = useState("");
  const publish = async () => {
    const body = text.trim();
    if (!body) return;
    if (await run(() => api.addUpdate(taskId, body), "No se pudo publicar.")) {
      setText("");
      await queryClient.invalidateQueries({ queryKey: key });
    }
  };
  return (
    <div className="space-y-4">
      {canWrite && (
        <div className="space-y-2">
          <Textarea aria-label="Nueva actualización" rows={3} placeholder="Escribe una actualización…" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="flex justify-end">
            <Button size="sm" disabled={!text.trim()} onClick={() => void publish()}>
              Publicar
            </Button>
          </div>
        </div>
      )}
      {!data?.length && <p className="py-8 text-center text-sm text-muted-foreground">Sin actualizaciones. Comparte avances, bloqueos o dudas sobre esta tarea.</p>}
      {data?.map((u) => (
        <article key={u.id} className="space-y-1.5 rounded-xl border border-border p-4">
          <p className="text-sm">
            <b>{u.authorName}</b> <span className="text-muted-foreground">· {formatDateTime(u.createdAt)}</span>
          </p>
          <p className="text-sm whitespace-pre-line">{u.body}</p>
        </article>
      ))}
    </div>
  );
}

/** Panel lateral con el detalle de una tarea o subtarea. */
export function TaskDetail({ board, taskId, subId, onClose, onOpen }: { board: Board; taskId: string | null; subId: string | null; onClose: () => void; onOpen: (taskId: string, subId?: string) => void }) {
  const run = useBoardAction();
  const [tab, setTab] = useState<"overview" | "updates">("overview");
  const task = board.tasks.find((t) => t.id === taskId) ?? null;
  const sub = task && subId ? (task.subtasks.find((s) => s.id === subId) ?? null) : null;
  const project = task ? board.projects.find((p) => p.id === task.projectId) : undefined;
  const names = new Map(board.people.map((p) => [p.id, p.name]));
  const people = board.people.filter((p) => p.teamId === project?.team.id);
  const manage = Boolean(project?.canManage);
  const entity: Task | Subtask | null = sub ?? task;
  const own = Boolean(project?.canWork && entity?.assigneeUserId === board.me);
  const save = (id: string, patch: TaskPatch) => void run(() => api.updateTask(id, patch));
  const sprint = board.sprints.find((s) => s.id === task?.sprintId);

  return (
    <Sheet open={Boolean(entity)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" showCloseButton={false} className="w-full max-w-xl gap-0 bg-card p-0 sm:max-w-xl">
        {task && entity && (
          <div className="flex h-full flex-col">
            <div className="space-y-2 border-b border-border px-6 pt-5">
              <div className="flex items-center justify-between gap-3">
                <p className="truncate text-sm text-muted-foreground">
                  {[project?.name, sprint ? sprintLabel(sprint) : "Sin sprint", sub ? task.title : null].filter(Boolean).join(" · ")}
                </p>
                <Button size="icon-sm" variant="ghost" aria-label="Cerrar detalle" onClick={onClose}>
                  <X />
                </Button>
              </div>
              <SheetTitle className="sr-only">{entity.title}</SheetTitle>
              {manage ? <NameEdit className="text-xl" value={entity.title} label={sub ? "Nombre de la subtarea" : "Nombre de la tarea"} onSave={(title) => save(entity.id, { title })} /> : <h2 className="text-xl font-bold">{entity.title}</h2>}
              <div role="tablist" className="-mb-px flex gap-1">
                {(["overview", "updates"] as const).map((t) => (
                  <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)} className={cn("border-b-2 px-3 py-2.5 text-sm font-semibold", tab === t ? "border-primary" : "border-transparent text-muted-foreground hover:text-foreground")}>
                    {t === "overview" ? "Overview" : "Actualizaciones"}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
              {tab === "updates" ? (
                <Updates taskId={entity.id} canWrite={Boolean(project?.canWork)} />
              ) : sub ? (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Proyecto">{project?.name}</Field>
                    <Field label="Tarea padre">
                      <button type="button" className="truncate font-medium hover:underline" onClick={() => onOpen(task.id)}>
                        {task.title}
                      </button>
                    </Field>
                    <Field label="Owner">
                      {manage ? (
                        <Select label="Owner" value={sub.assigneeUserId} emptyLabel="Sin asignar" options={people.map((p) => ({ value: p.id, label: p.name }))} onValueChange={(v) => save(sub.id, { assigneeUserId: v })} />
                      ) : (
                        <Owners ids={sub.assigneeUserId ? [sub.assigneeUserId] : []} names={names} />
                      )}
                    </Field>
                    <Field label="Status">
                      <StatusSelect label="Status" value={sub.status} disabled={!manage && !own} onSave={(status) => save(sub.id, { status })} />
                    </Field>
                    <Field label="Inicio">
                      <DatePicker label="Inicio" value={sub.startDate} max={sub.dueDate ?? undefined} disabled={!manage} onValueChange={(v) => save(sub.id, { startDate: v })} />
                    </Field>
                    <Field label="Fin">
                      <DatePicker label="Fin" value={sub.dueDate} min={sub.startDate ?? undefined} disabled={!manage} onValueChange={(v) => save(sub.id, { dueDate: v })} />
                    </Field>
                    <Field label="Horas proyectadas">
                      <HoursInput label="Horas proyectadas" value={sub.estimatedHours} disabled={!manage} onSave={(v) => save(sub.id, { estimatedHours: v })} />
                    </Field>
                    <Field label="Horas invertidas">
                      <HoursInput label="Horas invertidas" value={sub.investedHours} disabled={!manage && !own} onSave={(v) => save(sub.id, { investedHours: v })} />
                    </Field>
                    <Field label="Horas facturables">
                      <HoursInput label="Horas facturables" value={sub.billableHours} disabled={!manage && !own} onSave={(v) => save(sub.id, { billableHours: v })} />
                    </Field>
                  </div>
                  <Field label="Task details" className="[&>div]:block">
                    <DetailsText value={sub.details} disabled={!manage} onSave={(details) => save(sub.id, { details })} />
                  </Field>
                </>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Proyecto">
                      {manage ? (
                        <Select label="Proyecto" value={task.projectId} options={board.projects.filter((p) => p.canManage).map((p) => ({ value: p.id, label: p.name }))} onValueChange={(v) => v && v !== task.projectId && save(task.id, { projectId: v })} />
                      ) : (
                        project?.name
                      )}
                    </Field>
                    <Field label="Sprint">
                      {manage ? (
                        <Select label="Sprint" value={task.sprintId} emptyLabel="Sin sprint" options={board.sprints.filter((s) => s.projectId === task.projectId).map((s) => ({ value: s.id, label: sprintLabel(s) }))} onValueChange={(v) => save(task.id, { sprintId: v })} />
                      ) : (
                        (sprint && sprintLabel(sprint)) || "Sin sprint"
                      )}
                    </Field>
                    <Field label="Owner">
                      {!task.subtasks.length && manage ? (
                        <Select label="Owner" value={task.assigneeUserId} emptyLabel="Sin asignar" options={people.map((p) => ({ value: p.id, label: p.name }))} onValueChange={(v) => save(task.id, { assigneeUserId: v })} />
                      ) : (
                        <span title={task.subtasks.length ? "Calculado desde las subtareas" : undefined}>
                          <Owners ids={task.derived.ownerIds} names={names} />
                        </span>
                      )}
                    </Field>
                    <Field label="Status">
                      <StatusBar task={task} />
                    </Field>
                    <Field label="Inicio">
                      <DatePicker label="Inicio" value={task.derived.startDate} disabled={!manage || task.subtasks.length > 0} onValueChange={(v) => save(task.id, { startDate: v })} />
                    </Field>
                    <Field label="Fin">
                      <DatePicker label="Fin" value={task.derived.dueDate} disabled={!manage || task.subtasks.length > 0} onValueChange={(v) => save(task.id, { dueDate: v })} />
                    </Field>
                    {(["estimatedHours", "investedHours", "billableHours"] as const).map((k) => (
                      <Field key={k} label={k === "estimatedHours" ? "Horas proyectadas" : k === "investedHours" ? "Horas invertidas" : "Horas facturables"}>
                        <HoursInput label={k === "estimatedHours" ? "Horas proyectadas" : k === "investedHours" ? "Horas invertidas" : "Horas facturables"} value={task.derived[k]} disabled={task.subtasks.length > 0 || (k === "estimatedHours" ? !manage : !manage && !own)} onSave={(v) => save(task.id, { [k]: v })} />
                      </Field>
                    ))}
                    <Field label="Team">
                      <StatusBadge tone="outline">{project?.team.name ?? "Sin equipo"}</StatusBadge>
                    </Field>
                  </div>
                  <Field label="Task details" className="[&>div]:block">
                    <DetailsText value={task.details} disabled={!manage} onSave={(details) => save(task.id, { details })} />
                  </Field>
                  <section className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-caps-label">
                        Subtareas · {task.subtasks.filter((s) => s.status === "done").length}/{task.subtasks.length} completadas
                      </p>
                      {manage && (
                        <Button size="sm" variant="outline" onClick={() => void run(() => api.createTask({ projectId: task.projectId, parentTaskId: task.id, title: "Nueva subtarea", assigneeUserId: task.derived.ownerIds[0] ?? null }))}>
                          <Plus /> Agregar subtarea
                        </Button>
                      )}
                    </div>
                    {task.subtasks.map((s) => (
                      <div key={s.id} className="flex items-center gap-3 rounded-xl border border-border px-3 py-2">
                        <button type="button" className="min-w-0 flex-1 truncate text-left font-medium hover:underline" onClick={() => onOpen(task.id, s.id)}>
                          {s.title}
                        </button>
                        <Owners ids={s.assigneeUserId ? [s.assigneeUserId] : []} names={names} />
                        <div className="w-40">
                          <StatusSelect label={`Status de ${s.title}`} value={s.status} disabled={!manage && !(project?.canWork && s.assigneeUserId === board.me)} onSave={(status) => save(s.id, { status })} />
                        </div>
                      </div>
                    ))}
                  </section>
                </>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
