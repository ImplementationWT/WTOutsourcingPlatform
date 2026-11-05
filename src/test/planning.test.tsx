import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ConfirmProvider } from "@/components/ui/confirm-provider";
import BacklogPage from "@/features/tasks/BacklogPage";
import MyWorkPage from "@/features/tasks/MyWorkPage";
import type { Board, Task } from "@/features/tasks/api";
import { myWork, sprintCapacity, workdays } from "@/features/tasks/planning";
import { LEAD, withSession } from "./session";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const today = new Date().toISOString().slice(0, 10);
const plus = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const base = { dealId: null, details: "", updates: 0, estimatedHours: 0, investedHours: 0, billableHours: 0, startDate: null, dueDate: null, sprintId: null, parentTaskId: null, assigneeUserId: null, status: "todo" } as const;
const derived = (extra: Partial<Task["derived"]> = {}): Task["derived"] => ({ status: null, statusCounts: {}, ownerIds: [], startDate: null, dueDate: null, estimatedHours: 0, investedHours: 0, billableHours: 0, ...extra });
const subtask = (id: string, title: string, dueDate: string | null, status: Task["status"], extra: Partial<Task> = {}) => ({ ...base, id, projectId: "p1", parentTaskId: "t1", title, dueDate, status, assigneeUserId: "u-dev", estimatedHours: 4, investedHours: 1, ...extra });
const withSubs: Task = {
  ...base,
  id: "t1",
  projectId: "p1",
  sprintId: "s1",
  title: "API de órdenes",
  derived: derived({ status: "in_progress", ownerIds: ["u-dev"], estimatedHours: 12, investedHours: 3 }),
  subtasks: [subtask("a", "Endpoint vencido", plus(-2), "in_progress"), subtask("b", "Endpoint de la semana", plus(3), "todo"), subtask("c", "Endpoint lejano", plus(20), "review"), subtask("d", "Ya hecho", plus(-5), "done")],
};
const backlogTask: Task = { ...base, id: "t2", projectId: "p1", title: "Notificaciones push", estimatedHours: 12, derived: derived({ estimatedHours: 12 }), subtasks: [] };
const board: Board = {
  me: "u-lead",
  projects: [{ id: "p1", name: "Manpersa Field Service", stage: "structure", team: { id: "t-1", name: "Equipo A" }, leadUserId: "u-lead", developerUserIds: ["u-dev"], soldHours: 0, canManage: true, canWork: true }],
  sprints: [{ id: "s1", projectId: "p1", number: 1, name: "MVP", startDate: "2026-11-02", endDate: "2026-11-06" }],
  people: [
    { id: "u-lead", name: "Ana Líder", role: "lead", teamId: "t-1" },
    { id: "u-dev", name: "Diego Dev", role: "developer", teamId: "t-1" },
    { id: "u-dev2", name: "Dora Dev", role: "developer", teamId: "t-1" },
  ],
  tasks: [withSubs, backlogTask],
};

function renderAt(path: string) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return String(input) === "/api/tasks/board" ? json(board) : json({ ok: true });
  }) as typeof fetch;
  render(
    <QueryClientProvider client={withSession(new QueryClient({ defaultOptions: { queries: { retry: false } } }), LEAD)}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/operativa/mi-trabajo" element={<MyWorkPage />} />
            <Route path="/operativa/backlog" element={<BacklogPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
  return calls;
}

describe("planificación", () => {
  it("días hábiles y capacidad: 6 h por día hábil por developer, con la carga por persona", () => {
    expect(workdays("2026-11-02", "2026-11-08")).toBe(5);
    const cap = sprintCapacity(board, board.sprints[0]);
    expect(cap).toMatchObject({ days: 5, perPerson: 30, capacity: 30, planned: 12 });
    expect(cap.load.get("u-dev")).toBe(16);
  });

  it("Mi trabajo agrupa por entrega y deja las completadas al final", () => {
    const g = myWork(board, "u-dev", today);
    expect(g.overdue.map((x) => x.title)).toEqual(["Endpoint vencido"]);
    expect(g.week.map((x) => x.title)).toEqual(["Endpoint de la semana"]);
    expect(g.later.map((x) => x.title)).toEqual(["Endpoint lejano"]);
    expect(g.done.map((x) => x.title)).toEqual(["Ya hecho"]);
  });

  it("Mi trabajo: «Ver como» otra persona y cambiar el status de una subtarea", async () => {
    const calls = renderAt("/operativa/mi-trabajo?as=u-dev");
    const overdue = await screen.findByRole("region", { name: "Vencidas" });
    expect(within(overdue).getByText("Vencida hace 2 d")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Esta semana" })).toBeTruthy();
    fireEvent.change(within(overdue).getByRole("combobox", { name: "Status de Endpoint vencido" }), { target: { value: "stuck" } });
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.url === "/api/tasks/a" && (c.body as { status: string }).status === "stuck")).toBe(true));
  });

  it("Backlog: tareas sin sprint, developers sin tareas primero y asignar a un sprint", async () => {
    renderAt("/operativa/backlog");
    const backlog = await screen.findByRole("region", { name: "Backlog" });
    expect(within(backlog).getByText("Notificaciones push")).toBeTruthy();
    const devs = within(screen.getByRole("region", { name: "Disponibilidad de developers" })).getAllByRole("link");
    expect(devs[0].textContent).toContain("Dora Dev");
    expect(devs[0].textContent).toContain("Sin tareas");
    expect(within(screen.getByRole("region", { name: "Sprint 1: MVP" })).getByText(/12h planificadas \/ 30h de capacidad/)).toBeTruthy();
  });
});
