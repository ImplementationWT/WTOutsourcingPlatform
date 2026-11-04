import type { OpsTaskDoc } from "./models.js";
import { deriveTask, subtasksByParent } from "./tasks.js";

const DAY = 86_400_000;
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`);

/**
 * Horas invertidas y facturables de cada owner dentro de un mes. Cada ítem (subtarea, o la tarea si
 * no tiene subtareas) reparte sus horas por igual entre los días de su timeline; sin fechas no cuenta.
 * Son referenciales: no cambian ningún monto.
 */
export function hoursByOwnerInMonth(tasks: OpsTaskDoc[], month: string) {
  const start = utc(`${month}-01`);
  const [y, m] = month.split("-").map(Number);
  const end = Date.UTC(y, m, 0);
  const out = new Map<string, { invested: number; billable: number }>();
  const subs = subtasksByParent(tasks);
  for (const task of tasks.filter((t) => !t.parentTaskId)) {
    const children = subs.get(task._id) ?? [];
    const range = deriveTask(task, children);
    for (const item of children.length ? children : [task]) {
      const owner = item.assigneeUserId;
      // Una subtarea sin fechas usa el timeline de su tarea.
      const a = item.startDate ?? (children.length ? range.startDate : null);
      const b = item.dueDate ?? (children.length ? range.dueDate : null);
      if (!owner || !a || !b) continue;
      const lo = utc(a);
      const hi = utc(b);
      if (hi < lo) continue;
      const days = Math.round((hi - lo) / DAY) + 1;
      const inMonth = Math.max(0, Math.round((Math.min(hi, end) - Math.max(lo, start)) / DAY) + 1);
      if (!inMonth) continue;
      const share = inMonth / days;
      const row = out.get(owner) ?? { invested: 0, billable: 0 };
      row.invested += (item.investedHours ?? 0) * share;
      row.billable += (item.billableHours ?? 0) * share;
      out.set(owner, row);
    }
  }
  for (const row of out.values()) {
    row.invested = Math.round(row.invested * 10) / 10;
    row.billable = Math.round(row.billable * 10) / 10;
  }
  return out;
}
