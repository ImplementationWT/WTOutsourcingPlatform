import type { Tone } from "@/components/ui/tones";
import type { Board, Sprint } from "./api";
import { workItems, type WorkItem } from "./filters";

const DAY = 86_400_000;
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysTo = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

/** Texto y tono de la fecha de entrega. */
export function due(item: WorkItem, today: string): { text: string; tone: Tone } {
  if (item.status === "done") return { text: "Completada", tone: "neutral" };
  if (!item.end) return { text: "Sin fecha", tone: "neutral" };
  const d = daysTo(today, item.end);
  if (d < 0) return { text: `Vencida hace ${-d} d`, tone: "danger" };
  if (d === 0) return { text: "Vence hoy", tone: "warn" };
  return { text: `Vence en ${d} d`, tone: d <= 7 ? "warn" : "neutral" };
}

export interface MyWorkGroups {
  overdue: WorkItem[];
  week: WorkItem[];
  later: WorkItem[];
  noDate: WorkItem[];
  done: WorkItem[];
}

/** Lo de una persona agrupado por entrega (las completadas: las 5 más recientes). */
export function myWork(board: Board, personId: string, today = new Date().toISOString().slice(0, 10)): MyWorkGroups {
  const mine = workItems(board.tasks).filter((x) => x.owner === personId);
  const open = mine.filter((x) => x.status !== "done");
  const week = addDays(today, 7);
  const byEnd = (a: WorkItem, b: WorkItem) => (a.end ?? "9999").localeCompare(b.end ?? "9999");
  return {
    overdue: open.filter((x) => x.end && x.end < today).sort(byEnd),
    week: open.filter((x) => x.end && x.end >= today && x.end <= week).sort(byEnd),
    later: open.filter((x) => x.end && x.end > week).sort(byEnd),
    noDate: open.filter((x) => !x.end),
    done: mine.filter((x) => x.status === "done").sort(byEnd).reverse().slice(0, 5),
  };
}

/** Horas de trabajo por día hábil y por developer para calcular la capacidad de un sprint. */
export const HOURS_PER_DAY = 6;

/** Días hábiles (lunes a viernes) entre dos fechas, ambas incluidas. */
export function workdays(start: string, end: string) {
  let n = 0;
  for (let d = Date.parse(`${start}T00:00:00Z`); d <= Date.parse(`${end}T00:00:00Z`); d += 86_400_000) {
    const w = new Date(d).getUTCDay();
    if (w !== 0 && w !== 6) n += 1;
  }
  return n;
}

/** Capacidad del sprint (developers del proyecto × días hábiles × 6 h), lo planificado y la carga por persona. */
export function sprintCapacity(board: Board, sprint: Sprint) {
  const project = board.projects.find((p) => p.id === sprint.projectId);
  const days = workdays(sprint.startDate, sprint.endDate);
  const perPerson = days * HOURS_PER_DAY;
  const capacity = (project?.developerUserIds.length ?? 0) * perPerson;
  const tasks = board.tasks.filter((t) => t.sprintId === sprint.id);
  const planned = tasks.reduce((n, t) => n + t.derived.estimatedHours, 0);
  const load = new Map<string | null, number>();
  for (const x of workItems(tasks)) load.set(x.owner, (load.get(x.owner) ?? 0) + x.p);
  return { days, perPerson, capacity, planned, load, tasks };
}

