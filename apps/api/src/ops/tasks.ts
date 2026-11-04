import type { OpsTaskDoc, TaskStatus } from "./models.js";

/** Lo que muestra una tarea: con subtareas, todo se calcula desde ellas (la tarea padre es de solo lectura). */
export interface DerivedTask {
  /** null: tarea sin subtareas («Sin tareas»). */
  status: TaskStatus | null;
  /** Cuántas subtareas hay en cada status (para la barra segmentada). */
  statusCounts: Partial<Record<TaskStatus, number>>;
  ownerIds: string[];
  startDate: string | null;
  dueDate: string | null;
  estimatedHours: number;
  investedHours: number;
  billableHours: number;
}

/** Status de la tarea padre desde sus subtareas (mismo orden de prioridad que el prototipo). */
export function parentStatus(statuses: TaskStatus[]): TaskStatus {
  if (statuses.every((s) => s === "done")) return "done";
  if (statuses.includes("stuck")) return "stuck";
  if (statuses.includes("in_progress")) return "in_progress";
  if (statuses.includes("review")) return "review";
  if (statuses.includes("done")) return "in_progress";
  return "todo";
}

const sum = (items: Pick<OpsTaskDoc, "estimatedHours" | "investedHours" | "billableHours">[], key: "estimatedHours" | "investedHours" | "billableHours") =>
  Math.round(items.reduce((n, t) => n + (Number(t[key]) || 0), 0) * 100) / 100;

export function deriveTask(task: OpsTaskDoc, subtasks: OpsTaskDoc[]): DerivedTask {
  if (!subtasks.length) {
    return {
      status: null,
      statusCounts: {},
      ownerIds: task.assigneeUserId ? [task.assigneeUserId] : [],
      startDate: task.startDate ?? null,
      dueDate: task.dueDate ?? null,
      estimatedHours: task.estimatedHours ?? 0,
      investedHours: task.investedHours ?? 0,
      billableHours: task.billableHours ?? 0
    };
  }
  const statusCounts: Partial<Record<TaskStatus, number>> = {};
  for (const s of subtasks) statusCounts[s.status] = (statusCounts[s.status] ?? 0) + 1;
  const dates = subtasks.flatMap((s) => [s.startDate, s.dueDate]).filter((d): d is string => Boolean(d)).sort();
  return {
    status: parentStatus(subtasks.map((s) => s.status)),
    statusCounts,
    ownerIds: [...new Set(subtasks.map((s) => s.assigneeUserId).filter((v): v is string => Boolean(v)))],
    startDate: dates[0] ?? null,
    dueDate: dates.at(-1) ?? null,
    estimatedHours: sum(subtasks, "estimatedHours"),
    investedHours: sum(subtasks, "investedHours"),
    billableHours: sum(subtasks, "billableHours")
  };
}

/** Agrupa las subtareas por su tarea padre. */
export function subtasksByParent(tasks: OpsTaskDoc[]) {
  const map = new Map<string, OpsTaskDoc[]>();
  for (const t of tasks) {
    if (!t.parentTaskId) continue;
    const list = map.get(t.parentTaskId) ?? [];
    list.push(t);
    map.set(t.parentTaskId, list);
  }
  return map;
}

/** Campos que en una tarea con subtareas se calculan y no se escriben. */
export const DERIVED_FIELDS = ["assigneeUserId", "status", "startDate", "dueDate", "estimatedHours", "investedHours", "billableHours"] as const;
