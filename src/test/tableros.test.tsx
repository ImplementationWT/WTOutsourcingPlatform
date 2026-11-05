import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ConfirmProvider } from "@/components/ui/confirm-provider";
import { CommercialDashboard, FinancialDashboard, OperationalDashboard } from "@/features/tableros/DashboardPages";
import type { Invoice } from "@/features/finance/api";
import type { SessionUser } from "@/features/auth/auth";
import { BOSS, LEAD, withSession } from "./session";

const DEV: SessionUser = { ...LEAD, id: "u-dev", role: "developer" };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const month = new Date().toISOString().slice(0, 7);
const inv = (id: string, lead: string, stage: Invoice["stage"], totalCents: number, m = month): Invoice => ({
  id, number: id, month: m, stage, effectiveStage: stage, invoicedDate: null, paidDate: null, sustained: false, project: { id: "p1", name: "P" }, deal: null, lead: { id: lead, name: lead },
  paymentType: null, hours: 0, rateCents: 0, grossCents: totalCents, feeCents: 0, totalCents, currency: "USD",
});

function renderWith(node: React.ReactNode, user: SessionUser, routes: Record<string, unknown>) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    return json(key ? routes[key] : {});
  }) as typeof fetch;
  render(
    <QueryClientProvider client={withSession(new QueryClient({ defaultOptions: { queries: { retry: false } } }), user)}>
      <ConfirmProvider>
        <MemoryRouter>{node}</MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
  return calls;
}

describe("Dashboards", () => {
  it("Financiero: KPIs del mes y monto por stage, con vista de tabla", async () => {
    renderWith(<FinancialDashboard />, BOSS, { "/api/invoices": { invoices: [inv("a", "Manuel", "paid", 300_000), inv("b", "Ariana", "overdue", 120_000), inv("c", "Manuel", "invoiced", 50_000)], projects: [] } });
    expect((await screen.findByText("Total cobrado")).closest("div")!.parentElement!.textContent).toMatch(/3,000\.00/);
    expect(screen.getByText("Total pendiente de cobro").closest("div")!.parentElement!.textContent).toMatch(/1,700\.00/);
    const stage = screen.getByRole("region", { name: "Monto por stage" });
    fireEvent.click(within(stage).getByRole("button", { name: "Ver como tabla" }));
    const row = within(within(stage).getByRole("table")).getByText("Overdue").closest("tr")!;
    expect(row.textContent).toMatch(/1,200\.00/);
    expect(screen.getByRole("region", { name: "Invoices abiertas por team leader" }).textContent).toContain("Ariana");
  });

  it("Financiero sin acceso a Invoices no pide los datos", async () => {
    const calls = renderWith(<FinancialDashboard />, DEV, {});
    expect(await screen.findByText(/Tu rol no tiene acceso a Invoices/)).toBeTruthy();
    expect(calls.some((c) => c.startsWith("/api/invoices"))).toBe(false);
  });

  it("Comercial: leads por estado y temperatura, sin el pipeline de deals", async () => {
    renderWith(<CommercialDashboard />, BOSS, {
      "/api/tableros/comercial": { leads: 11, meetings: 4, proposals: 3, byStatus: [{ key: "new", count: 6 }, { key: "won", count: 5 }], byTemperature: [{ key: "hot", count: 7 }, { key: "warm", count: 4 }], byFunnel: [], bySource: [{ key: "LinkedIn", count: 11 }] },
    });
    expect((await screen.findByText("7 en Hot"))).toBeTruthy();
    expect(screen.queryByText(/Pipeline abierto/, { selector: "p.text-caps-label" })).toBeNull();
    expect(screen.getByText(/queda fuera hasta decidir/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Leads por temperatura" }).textContent).toMatch(/Hot.*63\.6%/);
  });

  it("Comercial: Propuestas es lo publicado en el tablero Propuestas (sin archivadas ni papelera)", async () => {
    renderWith(<CommercialDashboard />, BOSS, {
      "/api/tableros/comercial": { leads: 1, meetings: 0, proposals: 9, byStatus: [], byTemperature: [], byFunnel: [], bySource: [] },
      "/api/sites/config": { configured: true },
      "/api/sites?status=live": { items: [], counts: { live: 4, archived: 2, deleted: 3 }, canWrite: true },
    });
    const kpi = (await screen.findByText("Publicadas")).closest("div")!.parentElement!;
    expect(kpi.textContent).toContain("4");
    expect(kpi.textContent).not.toContain("9");
  });

  it("Operativo: KPIs de tareas y proyectos atascados", async () => {
    const task = (id: string, status: "done" | "stuck" | null) => ({ id, projectId: "p1", parentTaskId: null, sprintId: null, dealId: null, title: id, status: "todo", assigneeUserId: null, startDate: null, dueDate: null, estimatedHours: 4, investedHours: 2, billableHours: 1, details: "", updates: 0, subtasks: [], derived: { status, statusCounts: {}, ownerIds: [], startDate: null, dueDate: null, estimatedHours: 4, investedHours: 2, billableHours: 1 } });
    renderWith(<OperationalDashboard />, LEAD, {
      "/api/tasks/board": { me: "u-lead", projects: [{ id: "p1", name: "Portal", stage: "kickoff", team: { id: "t-1", name: "A" }, leadUserId: null, developerUserIds: [], soldHours: 0, canManage: true, canWork: true }], sprints: [], people: [], tasks: [task("a", "done"), task("b", "stuck"), task("c", null)] },
      "/api/ops/projects": { rows: [{ id: "p1", name: "Portal", stage: "kickoff", stageSince: "2020-01-01" }], total: 1, page: 1, pageSize: 100, facets: {}, totals: {}, stuck: [{ id: "p1", name: "Portal", stage: "kickoff", days: 99, sla: 7 }], sla: { kickoff: 7, structure: 30, automation_layer: 21, stabilization: 14, maintenance: 60, no_pending_items: 14, completed: null }, canCreate: true },
    });
    expect((await screen.findByText("Tareas completadas")).closest("div")!.parentElement!.textContent).toContain("33%");
    expect(screen.getByText("Proyectos atascados").closest("div")!.parentElement!.textContent).toContain("1");
    expect(screen.getByText("Horas invertidas").closest("div")!.parentElement!.textContent).toContain("6h");
  });

  it("Operativo: los proyectos se cuentan sobre todos, no sobre la primera página de la tabla", async () => {
    const proj = (i: number) => ({ id: `p${i}`, name: `P${i}`, stage: i % 2 ? "kickoff" : "completed", team: { id: "t-1", name: "A" }, leadUserId: null, developerUserIds: [], soldHours: 0, canManage: true, canWork: true });
    renderWith(<OperationalDashboard />, LEAD, {
      "/api/tasks/board": { me: "u-lead", projects: Array.from({ length: 130 }, (_, i) => proj(i)), sprints: [], people: [], tasks: [] },
      "/api/ops/projects": { rows: [], total: 130, page: 1, pageSize: 100, facets: {}, totals: {}, stuck: [], sla: {}, canCreate: true },
    });
    const kpi = (await screen.findByText("Proyectos activos")).closest("div")!.parentElement!;
    expect(kpi.textContent).toContain("65");
    expect(kpi.textContent).toContain("130 en total");
  });
});
