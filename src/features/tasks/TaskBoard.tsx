import { Fragment, useState, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { ChevronRight, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-context";
import { DatePicker } from "@/components/ui/date-picker";
import { Select } from "@/components/ui/select";
import { StatusBadge } from "@/components/ui/status-badge";
import { AvatarStack, PersonAvatar } from "@/components/ui/person-avatar";
import { formatDate } from "@/lib/format";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  api,
  hoursLabel,
  NO_SUBTASKS,
  SPRINT_STATE,
  sprintLabel,
  sprintState,
  statusOf,
  TASK_STATUS_COLOR,
  TASK_STATUS_LABELS,
  TASK_STATUSES,
  useBoardAction,
  type Board,
  type BoardProject,
  type Sprint,
  type Subtask,
  type Task,
  type TaskPatch,
  type TaskStatus,
} from "./api";

// ---- piezas pequeñas ---------------------------------------------------------------

/** Tooltip solo con CSS: aparece al pasar el mouse o con foco y nunca se queda pegado. */
export function HoverTip({ tip, children, className, style }: { tip: string; children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <span className={cn("group/tip relative inline-flex", className)} style={style} tabIndex={0} aria-label={tip}>
      {children}
      <span role="tooltip" className="pointer-events-none absolute bottom-[calc(100%+6px)] left-1/2 z-30 hidden -translate-x-1/2 rounded-lg bg-foreground px-2.5 py-1.5 text-xs font-semibold whitespace-nowrap text-background shadow-popover group-hover/tip:block group-focus-visible/tip:block">
        {tip}
      </span>
    </span>
  );
}


/** Avatares apilados de los owners (con su nombre al pasar el mouse). */
export function Owners({ ids, names }: { ids: string[]; names: Map<string, string> }) {
  return (
    <span className="flex h-10 w-full items-center justify-center rounded-[10px] border border-border bg-muted px-2">
      {ids.length ? <AvatarStack people={ids.map((id) => ({ id, name: names.get(id) ?? "—" }))} size={26} /> : <span className="text-sm text-muted-foreground">Sin asignar</span>}
    </span>
  );
}

/** Owner editable de una tarea o subtarea: avatar + nombre en una caja blanca (prototipo). */
function OwnerSelect({ value, people, label, onSave }: { value: string | null; people: { id: string; name: string }[]; label: string; onSave: (v: string | null) => void }) {
  const current = people.find((p) => p.id === value);
  return (
    <span className="flex h-10 w-full min-w-0 items-center gap-2 rounded-[10px] border border-border bg-card pr-1 pl-2.5 hover:border-line-strong">
      {current && <PersonAvatar person={current} size={22} />}
      <select aria-label={label} value={value ?? ""} onChange={(e) => (e.target.value || null) !== value && onSave(e.target.value || null)} className="native-caret h-full min-w-0 flex-1 cursor-pointer truncate bg-transparent text-sm font-semibold outline-none">
        <option value="">Sin asignar</option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </span>
  );
}

/** Status calculado de una tarea con subtareas: barra segmentada con el conteo en el tooltip. */
export function StatusBar({ task }: { task: Task }) {
  const total = task.subtasks.length;
  if (!total) return <span className="flex h-10 w-full min-w-32 items-center justify-center rounded-[10px] px-3 text-sm font-semibold whitespace-nowrap text-white" style={{ backgroundColor: TASK_STATUS_COLOR.todo }}>{NO_SUBTASKS}</span>;
  const parts = TASK_STATUSES.filter((s) => task.derived.statusCounts[s]).map((s) => ({ s, n: task.derived.statusCounts[s]! }));
  return (
    <div role="img" className="flex h-10 w-full min-w-32 overflow-visible rounded-[10px] bg-muted" aria-label={`Status: ${parts.map((p) => `${TASK_STATUS_LABELS[p.s]} ${p.n}`).join(", ")}`}>
      {parts.map((p, i) => (
        <HoverTip key={p.s} tip={`${TASK_STATUS_LABELS[p.s]} · ${p.n} ${p.n === 1 ? "subtarea" : "subtareas"}`} className="h-full" style={{ width: `${(p.n / total) * 100}%` }}>
          <span className={cn("flex h-full w-full items-center justify-center overflow-hidden text-sm font-semibold whitespace-nowrap text-white transition-[filter] hover:brightness-110", i === 0 && "rounded-l-[10px]", i === parts.length - 1 && "rounded-r-[10px]")} style={{ backgroundColor: TASK_STATUS_COLOR[p.s] }}>
            {parts.length === 1 ? TASK_STATUS_LABELS[p.s] : ""}
          </span>
        </HoverTip>
      ))}
    </div>
  );
}

/** Status editable de una subtarea, con el color de su estado. */
export function StatusSelect({ value, disabled, onSave, label }: { value: TaskStatus; disabled?: boolean; onSave: (v: TaskStatus) => void; label: string }) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => e.target.value !== value && onSave(e.target.value as TaskStatus)}
      className={cn("h-10 w-full min-w-0 rounded-[10px] border-0 pl-3 text-sm font-semibold text-white outline-none", disabled ? "cursor-default appearance-none" : "native-caret cursor-pointer")}
      style={{ backgroundColor: TASK_STATUS_COLOR[value] }}
    >
      {TASK_STATUSES.map((st) => (
        <option key={st} value={st} className="bg-card text-foreground">
          {TASK_STATUS_LABELS[st]}
        </option>
      ))}
    </select>
  );
}

/** Horas con la «h» pegada; guarda al salir o con Enter. Seleccionar todo al hacer clic. */
export function HoursInput({ value, label, disabled, onSave }: { value: number; label: string; disabled?: boolean; onSave: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const n = Math.max(0, Number(draft.replace(",", ".")) || 0);
    setDraft(null);
    if (n !== value) onSave(Math.round(n * 100) / 100);
  };
  if (disabled) return <span className="inline-flex h-10 min-w-14 items-center justify-end rounded-[10px] bg-muted/60 px-2.5 text-sm text-muted-foreground tabular-nums">{hoursLabel(value)}</span>;
  return (
    <span className="inline-flex h-10 min-w-14 items-center justify-end rounded-[10px] border border-border bg-muted px-2.5 text-sm tabular-nums focus-within:border-foreground">
      <input
        aria-label={label}
        inputMode="decimal"
        autoComplete="off"
        className="w-[var(--w)] min-w-[1.5ch] bg-transparent text-right outline-none"
        style={{ "--w": `${Math.max(1, (draft ?? String(value)).length) + 0.5}ch` } as React.CSSProperties}
        value={draft ?? String(value)}
        onClick={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9.,]/g, ""))}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
      <span className="text-muted-foreground">h</span>
    </span>
  );
}

const timelineText = (start: string | null, end: string | null) => {
  const f = (d: string) => formatDate(d).replace(/\s\d{4}$/, "").replace(/ de /g, " ");
  if (start && end) return start === end ? f(start) : `${f(start)} – ${f(end)}`;
  if (start || end) return f((start ?? end)!);
  return "Sin fecha";
};

/** Píldora del timeline; si se puede editar abre un panel con inicio y fin. */
export function Timeline({ start, end, status, editable, onSave, label }: { start: string | null; end: string | null; status: TaskStatus | null; editable: boolean; onSave: (p: { startDate?: string | null; dueDate?: string | null }) => void; label: string }) {
  const empty = !start && !end;
  const pill = cn("inline-flex h-10 w-full items-center justify-center rounded-full px-3 text-sm font-semibold whitespace-nowrap", empty ? "border border-dashed border-line-strong bg-muted text-muted-foreground" : "text-white");
  const color = empty ? undefined : { backgroundColor: TASK_STATUS_COLOR[status ?? "todo"] };
  if (!editable) return <span className={pill} style={color} title={empty ? undefined : "Calculado desde las subtareas"}>{timelineText(start, end)}</span>;
  return (
    <Popover.Root>
      <Popover.Trigger aria-label={label} className={cn(pill, "transition-[filter] hover:brightness-110")} style={color}>
        {timelineText(start, end)}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} className="z-50">
          <Popover.Popup className="w-72 space-y-3 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-popover outline-none">
            <Popover.Title className="text-caps-label">{label}</Popover.Title>
            <div className="grid grid-cols-2 gap-2">
              <DatePicker size="sm" label="Inicio" value={start} max={end ?? undefined} onValueChange={(v) => onSave({ startDate: v, ...(v && end && v > end ? { dueDate: v } : {}) })} />
              <DatePicker size="sm" label="Fin" value={end} min={start ?? undefined} onValueChange={(v) => onSave({ dueDate: v, ...(v && start && v < start ? { startDate: v } : {}) })} />
            </div>
            <div className="flex justify-between">
              <Button size="sm" variant="ghost" onClick={() => onSave({ startDate: null, dueDate: null })}>
                Quitar fechas
              </Button>
              <Popover.Close render={<Button size="sm" />}>Listo</Popover.Close>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Nombre editable en línea: se puede borrar todo mientras se escribe; vacío vuelve al anterior. */
export function NameEdit({ value, onSave, label, className, prefix }: { value: string; onSave: (v: string) => void; label: string; className?: string; prefix?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    if (next && next !== value) onSave(next);
  };
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      {prefix && (
        <span className="shrink-0 font-bold select-none" title="El número del sprint no se puede editar">
          {prefix}
        </span>
      )}
      <input
        aria-label={label}
        className="h-8 w-full min-w-0 rounded-md border border-transparent bg-transparent px-1.5 font-semibold outline-none hover:bg-muted focus:border-ring focus:bg-card"
        value={draft ?? value}
        maxLength={160}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setDraft(null);
        }}
      />
    </span>
  );
}

// ---- tablero -----------------------------------------------------------------------

export type BoardView = "sprints" | "list";

interface Group {
  key: string;
  label: string;
  meta?: string;
  sprint?: Sprint;
  project?: BoardProject;
  tasks: Task[];
}

const cell = "px-2 py-1.5 align-middle";
const FILL = "__fill";
/** Columnas del panel de subtareas (prototipo): nombre, owner, status, timeline, horas y borrar. */
const SUB_COLS = "grid grid-cols-[minmax(14rem,2.4fr)_minmax(9rem,1.1fr)_minmax(8.5rem,1fr)_minmax(10rem,1.2fr)_4.5rem_4.5rem_4.5rem_2rem] items-center gap-2";
const head = "text-caps-label sticky top-0 z-10 bg-card px-2 py-2.5 text-left font-semibold whitespace-nowrap";

/**
 * Tabla de tareas estilo Monday: agrupada por sprint o por proyecto, con subtareas desplegables.
 * La tarea padre con subtareas es de solo lectura (owners, status, timeline y horas salen de
 * ellas). Borrar un sprint o una tarea pide confirmación y deja «Deshacer».
 */
export function TaskBoard({
  board,
  tasks,
  view,
  showProject,
  onOpen,
  projectId,
  narrowed,
}: {
  board: Board;
  tasks: Task[];
  view: BoardView;
  showProject: boolean;
  onOpen: (taskId: string, subId?: string) => void;
  /** Proyecto filtrado: sus sprints se muestran aunque estén vacíos. */
  projectId?: string;
  /** Hay búsqueda u otros filtros: solo se muestran los sprints con tareas que coinciden. */
  narrowed?: boolean;
}) {
  const run = useBoardAction();
  const confirm = useConfirm();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const names = new Map(board.people.map((p) => [p.id, p.name]));
  const projectOf = new Map(board.projects.map((p) => [p.id, p]));
  const today = new Date().toISOString().slice(0, 10);

  const save = (id: string, patch: TaskPatch) => void run(() => api.updateTask(id, patch));
  const peopleOf = (projectId: string) => board.people.filter((p) => p.teamId === projectOf.get(projectId)?.team.id);
  const canEditOwn = (project: BoardProject | undefined, item: Subtask) => Boolean(project?.canManage || (project?.canWork && item.assigneeUserId === board.me));

  const removeTask = async (task: Task) => {
    const n = task.subtasks.length;
    const ok = await confirm({ title: `¿Eliminar «${task.title}»?`, description: n ? `También se eliminan sus ${n} ${n === 1 ? "subtarea" : "subtareas"}. Podrás deshacerlo desde el aviso.` : "Podrás deshacerlo desde el aviso.", confirmLabel: "Eliminar tarea", tone: "danger" });
    if (ok && (await run(() => api.deleteTask(task.id)))) toast.success("Tarea eliminada", { undo: () => run(() => api.restoreTask(task.id)) });
  };
  const removeSub = async (sub: Subtask) => {
    if (await run(() => api.deleteTask(sub.id))) toast.success("Subtarea eliminada", { undo: () => run(() => api.restoreTask(sub.id)) });
  };
  const removeSprint = async (sprint: Sprint) => {
    const n = board.tasks.filter((t) => t.sprintId === sprint.id).length;
    const ok = await confirm({ title: `¿Eliminar «${sprintLabel(sprint)}»?`, description: `${n ? (n === 1 ? "Su tarea quedará" : `Sus ${n} tareas quedarán`) + " sin sprint." : "No tiene tareas asignadas."} Podrás deshacerlo desde el aviso.`, confirmLabel: "Eliminar sprint", tone: "danger" });
    if (ok && (await run(() => api.deleteSprint(sprint.id)))) toast.success("Sprint eliminado · sus tareas quedaron sin sprint", { undo: () => run(() => api.restoreSprint(sprint.id)) });
  };
  const addSub = async (task: Task) => {
    const created = await run(() => api.createTask({ projectId: task.projectId, parentTaskId: task.id, title: "Nueva subtarea", assigneeUserId: task.derived.ownerIds[0] ?? task.assigneeUserId ?? null }));
    if (created) setOpen((o) => ({ ...o, [task.id]: true }));
  };

  // Grupos: por sprint (con «Sin sprint» al final) o por proyecto.
  const visibleIds = new Set(tasks.map((t) => t.id));
  let groups: Group[];
  if (view === "sprints") {
    const sprints = board.sprints
      .filter((s) => !projectId || s.projectId === projectId)
      .sort((a, b) => board.projects.findIndex((p) => p.id === a.projectId) - board.projects.findIndex((p) => p.id === b.projectId) || a.startDate.localeCompare(b.startDate));
    groups = sprints
      .map((s) => ({ key: s.id, label: sprintLabel(s), sprint: s, project: projectOf.get(s.projectId), tasks: tasks.filter((t) => t.sprintId === s.id) }))
      .filter((g) => !narrowed || g.tasks.length);
    const none = tasks.filter((t) => !t.sprintId);
    if (none.length) groups.push({ key: "none", label: "Sin sprint", meta: "Tareas sin sprint asignado", tasks: none });
  } else {
    groups = board.projects.map((p) => ({ key: p.id, label: p.name, meta: `${p.team.name ?? "Sin equipo"}`, project: p, tasks: tasks.filter((t) => t.projectId === p.id) })).filter((g) => g.tasks.length);
  }

  // La última columna vacía se queda con el ancho que sobra: así el nombre de la tarea queda junto a
  // sus columnas en lugar de estirarse.
  const columns = ["", "Tarea", ...(showProject ? ["Proyecto"] : []), "Sprint", "Owners", "Status", "Timeline", "Proj. hrs", "Invested", "Billable", "", FILL];
  return (
    <div className="proto-form max-h-[70vh] overflow-auto rounded-2xl border border-border bg-card">
      <table className="w-full min-w-[78rem] border-separate border-spacing-0 text-sm">
        <caption className="sr-only">Tareas</caption>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i} scope="col" aria-hidden={c === FILL || undefined} className={cn(head, "border-b border-border", c === "" && "w-10", c === "Tarea" && "w-[20rem] min-w-[16rem]", c === FILL && "w-full p-0")}>
                {c === FILL ? null : c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const st = g.sprint ? sprintState(g.sprint, board.tasks, today) : null;
            const all = g.sprint ? board.tasks.filter((t) => t.sprintId === g.sprint!.id) : g.tasks;
            const done = all.filter((t) => statusOf(t) === "done").length;
            return (
              <Fragment key={g.key}>
                <tr>
                  <td colSpan={columns.length} className="px-3 pt-5 pb-2">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      {g.sprint && g.project?.canManage ? (
                        <NameEdit className="w-80 text-base text-[var(--viz-1)] [&_input]:text-[var(--viz-1)]" prefix={`Sprint ${g.sprint.number}:`} value={g.sprint.name} label="Nombre del sprint" onSave={(name) => void run(() => api.updateSprint(g.sprint!.id, { name }))} />
                      ) : (
                        <b className={cn("text-base", g.sprint && "text-[var(--viz-1)]")}>{g.label}</b>
                      )}
                      {st && <StatusBadge tone={SPRINT_STATE[st].tone}>{SPRINT_STATE[st].label}</StatusBadge>}
                      {g.sprint && (
                        <span className="text-xs text-muted-foreground">
                          {g.project && !showProject ? "" : `${g.project?.name} · `}
                          {formatDate(g.sprint.startDate)} → {formatDate(g.sprint.endDate)} · {all.length ? `${Math.round((done / all.length) * 100)}% · ${done}/${all.length}` : "Sin tareas"}
                        </span>
                      )}
                      {g.meta && <span className="text-xs text-muted-foreground">{g.meta}</span>}
                      <span className="text-xs text-muted-foreground">
                        · {g.tasks.length} {g.tasks.length === 1 ? "tarea" : "tareas"}
                      </span>
                      {g.sprint && g.project?.canManage && (
                        <Button size="sm" variant="ghost" className="ml-auto text-destructive" onClick={() => void removeSprint(g.sprint!)}>
                          <Trash2 /> Eliminar
                        </Button>
                      )}
                    </div>
                    {g.sprint && !g.tasks.length && <p className="mt-2 pl-4 text-sm text-muted-foreground">Este sprint aún no tiene tareas. Asígnalas desde el campo Sprint de cada tarea.</p>}
                  </td>
                </tr>
                {g.tasks.filter((t) => visibleIds.has(t.id)).map((t) => {
                  const project = projectOf.get(t.projectId);
                  const manage = Boolean(project?.canManage);
                  const hasSubs = t.subtasks.length > 0;
                  const expanded = Boolean(open[t.id]);
                  const people = peopleOf(t.projectId);
                  const sprintOpts = board.sprints.filter((s) => s.projectId === t.projectId).map((s) => ({ value: s.id, label: sprintLabel(s) }));
                  const ownEditable = !hasSubs && canEditOwn(project, t);
                  return (
                    <Fragment key={t.id}>
                      <tr className="group/row hover:bg-muted/40">
                        <td className={cn(cell, "border-t border-l-[3px] border-t-border border-l-[var(--viz-1)]")}>
                          <button type="button" aria-label={`${expanded ? "Ocultar" : "Mostrar"} subtareas de ${t.title}`} aria-expanded={expanded} onClick={() => setOpen((o) => ({ ...o, [t.id]: !expanded }))} className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent">
                            <ChevronRight className={cn("size-4 transition-transform", expanded && "rotate-90")} />
                          </button>
                        </td>
                        <td className={cn(cell, "border-t border-border")}>
                          <button type="button" onClick={() => onOpen(t.id)} className="max-w-[22rem] truncate text-left font-semibold hover:underline" title="Abrir detalle de la tarea">
                            {t.title}
                          </button>
                          {hasSubs && <span className="ml-2 text-xs text-muted-foreground">{t.subtasks.filter((s) => s.status === "done").length}/{t.subtasks.length}</span>}
                        </td>
                        {showProject && (
                          <td className={cn(cell, "w-48 border-t border-border")}>
                            {manage ? (
                              <Select label={`Proyecto de ${t.title}`} size="sm" value={t.projectId} options={board.projects.filter((p) => p.canManage).map((p) => ({ value: p.id, label: p.name }))} onValueChange={(v) => v && v !== t.projectId && save(t.id, { projectId: v })} />
                            ) : (
                              project?.name
                            )}
                          </td>
                        )}
                        <td className={cn(cell, "w-52 border-t border-border")}>
                          {manage ? (
                            <Select label={`Sprint de ${t.title}`} size="sm" value={t.sprintId} emptyLabel="Sin sprint" options={sprintOpts} onValueChange={(v) => v !== t.sprintId && save(t.id, { sprintId: v })} />
                          ) : (
                            <span className="text-muted-foreground">{board.sprints.find((s) => s.id === t.sprintId) ? sprintLabel(board.sprints.find((s) => s.id === t.sprintId)!) : "Sin sprint"}</span>
                          )}
                        </td>
                        <td className={cn(cell, "w-44 border-t border-border")}>
                          {!hasSubs && manage ? (
                            <OwnerSelect label={`Owner de ${t.title}`} value={t.assigneeUserId} people={people} onSave={(v) => save(t.id, { assigneeUserId: v })} />
                          ) : (
                            <span title={hasSubs ? "Calculado desde las subtareas" : undefined}>
                              <Owners ids={t.derived.ownerIds} names={names} />
                            </span>
                          )}
                        </td>
                        <td className={cn(cell, "w-40 border-t border-border")}>
                          <StatusBar task={t} />
                        </td>
                        <td className={cn(cell, "w-44 border-t border-border")}>
                          <Timeline label={`Timeline de ${t.title}`} start={t.derived.startDate} end={t.derived.dueDate} status={t.derived.status} editable={!hasSubs && manage} onSave={(p) => save(t.id, p)} />
                        </td>
                        {(["estimatedHours", "investedHours", "billableHours"] as const).map((k) => (
                          <td key={k} className={cn(cell, "w-24 border-t border-border")}>
                            <HoursInput label={`${k === "estimatedHours" ? "Horas proyectadas" : k === "investedHours" ? "Horas invertidas" : "Horas facturables"} de ${t.title}`} value={t.derived[k]} disabled={hasSubs || (k === "estimatedHours" ? !manage : !ownEditable)} onSave={(v) => save(t.id, { [k]: v })} />
                          </td>
                        ))}
                        <td className={cn(cell, "border-t border-border text-center")}>
                          {manage && (
                            <button type="button" aria-label={`Borrar ${t.title}`} title="Borrar tarea" onClick={() => void removeTask(t)} className="inline-flex size-8 items-center justify-center rounded-lg text-destructive opacity-70 hover:bg-destructive/10 hover:opacity-100">
                              <Trash2 className="size-4" />
                            </button>
                          )}
                        </td>
                        <td aria-hidden className="border-t border-border" />
                      </tr>
                      {expanded && (
                        <tr>
                          <td className="border-l-[3px] border-l-[var(--viz-1)]" />
                          <td colSpan={columns.length - 1} className="px-2 pb-3">
                            <div role="table" aria-label={`Subtareas de ${t.title}`} className="rounded-xl bg-muted/70 p-2.5">
                              <div role="row" className={cn(SUB_COLS, "border-b border-border px-1 pb-2 text-[10.5px] font-semibold tracking-[0.06em] text-muted-foreground uppercase")}>
                                {["Subtarea", "Owner", "Status", "Timeline", "Proj. hrs", "Invested", "Billable", ""].map((h, i) => (
                                  <span key={i} role="columnheader">
                                    {h}
                                  </span>
                                ))}
                              </div>
                              {t.subtasks.map((s) => {
                                const editable = canEditOwn(project, s);
                                return (
                                  <div key={s.id} role="row" className={cn(SUB_COLS, "border-b border-border px-1 py-1.5 last:border-0")}>
                                    {manage ? <NameEdit value={s.title} label="Nombre de la subtarea" onSave={(title) => save(s.id, { title })} /> : <span className="truncate px-1.5 font-medium">{s.title}</span>}
                                    {manage ? <OwnerSelect label={`Owner de ${s.title}`} value={s.assigneeUserId} people={people} onSave={(v) => save(s.id, { assigneeUserId: v })} /> : <Owners ids={s.assigneeUserId ? [s.assigneeUserId] : []} names={names} />}
                                    <StatusSelect label={`Status de ${s.title}`} value={s.status} disabled={!editable} onSave={(status) => save(s.id, { status })} />
                                    <Timeline label={`Timeline de ${s.title}`} start={s.startDate} end={s.dueDate} status={s.status} editable={manage} onSave={(p) => save(s.id, p)} />
                                    {(["estimatedHours", "investedHours", "billableHours"] as const).map((k) => (
                                      <HoursInput key={k} label={`${k === "estimatedHours" ? "Horas proyectadas" : k === "investedHours" ? "Horas invertidas" : "Horas facturables"} de ${s.title}`} value={s[k]} disabled={k === "estimatedHours" ? !manage : !editable} onSave={(v) => save(s.id, { [k]: v })} />
                                    ))}
                                    {manage ? (
                                      <button type="button" aria-label={`Borrar ${s.title}`} title="Borrar subtarea" onClick={() => void removeSub(s)} className="inline-flex size-8 items-center justify-center rounded-lg text-destructive opacity-70 hover:bg-destructive/10 hover:opacity-100">
                                        <Trash2 className="size-4" />
                                      </button>
                                    ) : (
                                      <span />
                                    )}
                                  </div>
                                );
                              })}
                              {manage && (
                                <button type="button" onClick={() => void addSub(t)} className="mt-1.5 inline-flex items-center gap-1.5 px-2 py-1 text-sm font-medium text-muted-foreground hover:text-foreground">
                                  <Plus className="size-4" /> Agregar subtarea
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {!groups.length && <p className="p-10 text-center text-sm text-muted-foreground">No hay tareas que coincidan con esta vista. Crea una con «Nueva tarea».</p>}
    </div>
  );
}
