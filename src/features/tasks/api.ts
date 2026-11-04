import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Tone } from "@/components/ui/tones";
import { apiFetch } from "@/lib/api-client";
import { errorText, toast } from "@/lib/toast";
import type { Stage } from "@/features/ops/api";

export const TASK_STATUSES = ["todo", "in_progress", "review", "stuck", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = { todo: "Pending", in_progress: "Working on it", review: "In Review", stuck: "Stuck", done: "Completed" };
export const TASK_STATUS_TONE: Record<TaskStatus, Tone> = { todo: "neutral", in_progress: "warn", review: "accent", stuck: "danger", done: "ok" };
/** Texto de una tarea sin subtareas: su status vive en las subtareas. */
export const NO_SUBTASKS = "Sin tareas";

interface TaskBase {
  id: string;
  projectId: string;
  parentTaskId: string | null;
  sprintId: string | null;
  dealId: string | null;
  title: string;
  status: TaskStatus;
  assigneeUserId: string | null;
  startDate: string | null;
  dueDate: string | null;
  estimatedHours: number;
  investedHours: number;
  billableHours: number;
  details: string;
  updates: number;
}
export type Subtask = TaskBase;

/** Lo que se muestra de la tarea: con subtareas se calcula desde ellas. */
export interface Derived {
  status: TaskStatus | null;
  statusCounts: Partial<Record<TaskStatus, number>>;
  ownerIds: string[];
  startDate: string | null;
  dueDate: string | null;
  estimatedHours: number;
  investedHours: number;
  billableHours: number;
}
export interface Task extends TaskBase {
  derived: Derived;
  subtasks: Subtask[];
}
export interface Sprint {
  id: string;
  projectId: string;
  number: number;
  name: string;
  startDate: string;
  endDate: string;
}
export interface BoardProject {
  id: string;
  name: string;
  stage: Stage;
  team: { id: string; name: string | null };
  leadUserId: string | null;
  developerUserIds: string[];
  /** Horas vendidas (deals aprobados en adelante). */
  soldHours: number;
  canManage: boolean;
  canWork: boolean;
}
export interface Person {
  id: string;
  name: string;
  role: "lead" | "developer";
  teamId: string;
}
export interface Board {
  projects: BoardProject[];
  sprints: Sprint[];
  people: Person[];
  tasks: Task[];
  me: string;
}

export const boardKey = ["tasks", "board"] as const;

/** Todo el tablero visible (tareas, sprints, proyectos y personas); se filtra en el navegador. */
export function useBoard() {
  return useQuery({ queryKey: boardKey, queryFn: () => apiFetch<Board>("/api/tasks/board") });
}

const send = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

export type TaskPatch = Partial<Pick<TaskBase, "title" | "sprintId" | "assigneeUserId" | "status" | "startDate" | "dueDate" | "estimatedHours" | "investedHours" | "billableHours" | "details" | "projectId">>;
export type TaskInput = TaskPatch & { projectId: string; title: string; parentTaskId?: string | null };

export const api = {
  createTask: (input: TaskInput) => apiFetch<{ task: Subtask }>("/api/tasks", send("POST", input)),
  updateTask: (id: string, patch: TaskPatch) => apiFetch<{ task: Subtask }>(`/api/tasks/${id}`, send("PATCH", patch)),
  deleteTask: (id: string) => apiFetch<{ ok: true }>(`/api/tasks/${id}`, send("DELETE")),
  restoreTask: (id: string) => apiFetch<{ ok: true }>(`/api/tasks/${id}/restore`, send("POST")),
  createSprint: (input: { projectId: string; name: string; startDate: string; endDate: string }) => apiFetch<{ sprint: Sprint }>("/api/sprints", send("POST", input)),
  updateSprint: (id: string, patch: Partial<Pick<Sprint, "name" | "startDate" | "endDate">>) => apiFetch<{ sprint: Sprint }>(`/api/sprints/${id}`, send("PATCH", patch)),
  deleteSprint: (id: string) => apiFetch<{ ok: true; detached: number }>(`/api/sprints/${id}`, send("DELETE")),
  restoreSprint: (id: string) => apiFetch<{ ok: true }>(`/api/sprints/${id}/restore`, send("POST")),
  updates: (id: string) => apiFetch<{ updates: { id: string; body: string; authorName: string; createdAt: string }[] }>(`/api/tasks/${id}/updates`),
  addUpdate: (id: string, body: string) => apiFetch(`/api/tasks/${id}/updates`, send("POST", { body })),
};

/** Ejecuta una acción y refresca el tablero (y los proyectos, que suman horas y avance). */
export function useBoardAction() {
  const queryClient = useQueryClient();
  return async <T,>(action: () => Promise<T>, failure = "No se pudo guardar el cambio.") => {
    try {
      const result = await action();
      // Tablero, contador del backlog y proyectos (que suman horas y avance).
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["tasks"] }), queryClient.invalidateQueries({ queryKey: ["ops"] })]);
      return result;
    } catch (err) {
      toast.error(failure, { description: errorText(err, "Inténtalo de nuevo.") });
      return null;
    }
  };
}

/** Horas con la «h» pegada: 2h, 1.5h. */
export const hoursLabel = (h: number) => `${Math.round(h * 10) / 10}h`;

/** «Sprint N: nombre» (el número no se edita). */
export const sprintLabel = (s: Pick<Sprint, "number" | "name">) => `Sprint ${s.number}: ${s.name}`;

export type SprintState = "upcoming" | "active" | "closed" | "done";
export const SPRINT_STATE: Record<SprintState, { label: string; tone: Tone }> = {
  upcoming: { label: "Upcoming", tone: "accent" },
  active: { label: "Activo", tone: "info" },
  closed: { label: "Cerrado", tone: "neutral" },
  done: { label: "Completado", tone: "ok" },
};
export function sprintState(sprint: Sprint, tasks: Task[], today = new Date().toISOString().slice(0, 10)): SprintState {
  const mine = tasks.filter((t) => t.sprintId === sprint.id);
  if (mine.length && mine.every((t) => statusOf(t) === "done")) return "done";
  if (today < sprint.startDate) return "upcoming";
  if (today > sprint.endDate) return "closed";
  return "active";
}

/** Status mostrado: el calculado o, en tareas sin subtareas, el propio (tareas anteriores). */
export const statusOf = (t: Task): TaskStatus | null => t.derived.status ?? (t.status === "done" ? "done" : null);
