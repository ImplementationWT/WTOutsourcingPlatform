import type { Board, Subtask, Task, TaskStatus } from "./api";
import { statusOf } from "./api";

export interface TaskFilters {
  q?: string;
  projectId?: string;
  sprintId?: string;
  ownerId?: string;
  status?: TaskStatus;
  /** «Mis tareas»: tareas de esta persona (propias o con subtareas suyas). */
  mineOf?: string;
  /** «Sin timeline»: sin inicio o sin fin. */
  noTimeline?: boolean;
}

const owns = (t: Task, who: string) => t.assigneeUserId === who || t.derived.ownerIds.includes(who) || t.subtasks.some((s) => s.assigneeUserId === who);

/** Filtra las tareas del tablero (las subtareas viajan con su tarea). */
export function filterTasks(board: Board, f: TaskFilters) {
  const q = f.q?.trim().toLowerCase();
  return board.tasks.filter((t) => {
    if (f.projectId && t.projectId !== f.projectId) return false;
    if (f.sprintId && t.sprintId !== f.sprintId) return false;
    if (f.ownerId && !owns(t, f.ownerId)) return false;
    if (f.mineOf && !owns(t, f.mineOf)) return false;
    if (f.status && statusOf(t) !== f.status) return false;
    if (f.noTimeline && t.derived.startDate && t.derived.dueDate) return false;
    if (q && ![t.title, ...t.subtasks.map((s) => s.title)].some((x) => x.toLowerCase().includes(q))) return false;
    return true;
  });
}

/** Algo con horas y owner: una subtarea, o la tarea si no tiene subtareas. */
export interface WorkItem {
  task: Task;
  sub: Subtask | null;
  owner: string | null;
  status: TaskStatus | null;
  title: string;
  start: string | null;
  end: string | null;
  p: number;
  i: number;
  b: number;
}

/** Ítems con horas: cada subtarea, o la tarea si no tiene subtareas. */
export function workItems(tasks: Task[]): WorkItem[] {
  return tasks.flatMap((t): WorkItem[] =>
    t.subtasks.length
      ? t.subtasks.map((s) => ({ task: t, sub: s, owner: s.assigneeUserId, status: s.status, title: s.title, start: s.startDate, end: s.dueDate, p: s.estimatedHours, i: s.investedHours, b: s.billableHours }))
      : [{ task: t, sub: null, owner: t.assigneeUserId, status: null, title: t.title, start: t.startDate, end: t.dueDate, p: t.estimatedHours, i: t.investedHours, b: t.billableHours }],
  );
}

/** Siguiente sprint: empieza el día después del último del proyecto (o hoy) y dura dos semanas. */
export function nextSprintDates(board: Board, projectId: string, today = new Date().toISOString().slice(0, 10)) {
  const last = board.sprints.filter((s) => s.projectId === projectId).map((s) => s.endDate).sort().at(-1);
  const add = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const start = last && last >= today ? add(last, 1) : today;
  return { startDate: start, endDate: add(start, 13) };
}
