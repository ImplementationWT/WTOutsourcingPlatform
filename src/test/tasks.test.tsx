import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ConfirmProvider } from "@/components/ui/confirm-provider";
import TasksPage from "@/features/tasks/TasksPage";
import type { Board, Task } from "@/features/tasks/api";
import { filterTasks } from "@/features/tasks/filters";
import { LEAD, withSession } from "./session";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const base = { dealId: null, details: "", updates: 0, estimatedHours: 0, investedHours: 0, billableHours: 0, startDate: null, dueDate: null, sprintId: null, parentTaskId: null } as const;
const sub = (id: string, title: string, status: Task["status"], assigneeUserId: string, extra: Partial<Task> = {}) => ({ ...base, id, projectId: "p1", parentTaskId: "t1", title, status, assigneeUserId, ...extra });
const parent: Task = {
  ...base,
  id: "t1",
  projectId: "p1",
  sprintId: "s1",
  title: "Checklist Item Engine",
  status: "todo",
  assigneeUserId: null,
  derived: { status: "stuck", statusCounts: { done: 1, stuck: 1 }, ownerIds: ["u-dev", "u-lead"], startDate: "2026-11-02", dueDate: "2026-11-09", estimatedHours: 5, investedHours: 5, billableHours: 3 },
  subtasks: [sub("st1", "Plantillas", "done", "u-dev", { estimatedHours: 3, investedHours: 4, billableHours: 3 }), sub("st2", "Recordatorios", "stuck", "u-lead", { estimatedHours: 2, investedHours: 1 })],
};
const lonely: Task = { ...base, id: "t2", projectId: "p1", title: "Slack Channel Automation", status: "todo", assigneeUserId: "u-dev", estimatedHours: 3, derived: { status: null, statusCounts: {}, ownerIds: ["u-dev"], startDate: null, dueDate: null, estimatedHours: 3, investedHours: 0, billableHours: 0 }, subtasks: [] };
const board: Board = {
  me: "u-lead",
  projects: [{ id: "p1", name: "Arzuman Brothers", stage: "structure", team: { id: "t-1", name: "Equipo A" }, leadUserId: "u-lead", developerUserIds: ["u-dev"], soldHours: 40, canManage: true, canWork: true }],
  sprints: [{ id: "s1", projectId: "p1", number: 2, name: "Automation Layer", startDate: "2026-11-01", endDate: "2026-11-15" }],
  people: [
    { id: "u-lead", name: "Ana Líder", role: "lead", teamId: "t-1" },
    { id: "u-dev", name: "Diego Dev", role: "developer", teamId: "t-1" },
  ],
  tasks: [parent, lonely],
};

function renderTasks(path = "/operativa/tasks") {
  const calls: { url: string; method: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/api/tasks/board") return json(board);
    return json({ ok: true });
  }) as typeof fetch;
  const queryClient = withSession(new QueryClient({ defaultOptions: { queries: { retry: false } } }), LEAD);
  render(
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/operativa/tasks" element={<TasksPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
  return calls;
}

describe("Tasks", () => {
  it("la tarea padre se calcula desde sus subtareas; sin subtareas dice «Sin tareas»", async () => {
    renderTasks();
    const table = await screen.findByRole("table", { name: "Tareas" });
    const row = within(within(table).getByRole("button", { name: "Checklist Item Engine" }).closest("tr")!);
    expect(row.getByRole("img", { name: "Status: Stuck 1, Completed 1" })).toBeTruthy();
    // Horas de la tarea padre: solo lectura, con la «h» pegada.
    expect(row.getAllByText("5h")).toHaveLength(2);
    expect(row.getByText("3h")).toBeTruthy();
    expect(row.queryByLabelText(/Horas proyectadas de Checklist/)).toBeNull();
    const other = within(within(table).getByRole("button", { name: "Slack Channel Automation" }).closest("tr")!);
    expect(other.getByText("Sin tareas")).toBeTruthy();
    expect(other.getByLabelText("Horas proyectadas de Slack Channel Automation")).toBeTruthy();
  });

  it("KPIs y pestañas; «Mis tareas» y la búsqueda filtran", () => {
    expect(filterTasks(board, { mineOf: "u-lead" }).map((t) => t.id)).toEqual(["t1"]);
    expect(filterTasks(board, { q: "plantillas" }).map((t) => t.id)).toEqual(["t1"]);
    expect(filterTasks(board, { noTimeline: true }).map((t) => t.id)).toEqual(["t2"]);
    expect(filterTasks(board, { status: "stuck" }).map((t) => t.id)).toEqual(["t1"]);
  });

  it("la vista por sprint muestra el prefijo fijo «Sprint N:» y solo se edita el resto", async () => {
    renderTasks("/operativa/tasks?tab=sprints");
    const name = await screen.findByLabelText("Nombre del sprint");
    expect(screen.getByText("Sprint 2:")).toBeTruthy();
    expect((name as HTMLInputElement).value).toBe("Automation Layer");
    expect(screen.getAllByText("Sin sprint").length).toBeGreaterThan(0);
  });

  it("las horas se guardan al salir del campo y un nombre se puede vaciar mientras se escribe", async () => {
    const calls = renderTasks();
    const hours = await screen.findByLabelText("Horas proyectadas de Slack Channel Automation");
    fireEvent.change(hours, { target: { value: "4.5" } });
    fireEvent.blur(hours);
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.url === "/api/tasks/t2" && (c.body as { estimatedHours: number }).estimatedHours === 4.5)).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: /Mostrar subtareas de Checklist/ }));
    const subName = screen.getAllByLabelText("Nombre de la subtarea")[0] as HTMLInputElement;
    fireEvent.change(subName, { target: { value: "" } });
    expect(subName.value).toBe("");
    fireEvent.change(subName, { target: { value: "lantillas" } });
    fireEvent.blur(subName);
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.url === "/api/tasks/st1" && (c.body as { title: string }).title === "lantillas")).toBe(true));
  });

  it("borrar una tarea padre pide confirmación antes", async () => {
    const calls = renderTasks();
    fireEvent.click(await screen.findByRole("button", { name: "Borrar Checklist Item Engine" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/sus 2 subtareas/)).toBeTruthy();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Eliminar tarea" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/tasks/t1")).toBe(true));
  });
});
