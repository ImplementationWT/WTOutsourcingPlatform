import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ConfirmProvider } from "@/components/ui/confirm-provider";
import PayoutsPage from "@/features/finance/PayoutsPage";
import type { PayoutsData } from "@/features/finance/api";
import type { SessionUser } from "@/features/auth/auth";
import { pick } from "./pick";
import { BOSS, withSession } from "./session";

const FINANCE: SessionUser = { id: "u-fin", username: "fede", name: "Fede", role: "finance", teamId: null, mustChangeCredentials: false };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const data = (canEditPeople: boolean): PayoutsData => ({
  month: new Date().toISOString().slice(0, 7),
  canEditPeople,
  teams: [{ id: "t1", name: "Team M" }, { id: "t2", name: "Team A" }],
  rows: [
    { user: { id: "u1", name: "Manuel", role: "lead", seniority: null, team: { id: "t1", name: "Team M" } }, basicCents: 220_000, commissionCents: 30_000, totalCents: 250_000, status: "paid", paidDate: "2026-11-05", hours: { invested: 12, billable: 10 } },
    { user: { id: "u2", name: "Caleb", role: "developer", seniority: "semi_senior", team: { id: "t1", name: "Team M" } }, basicCents: 120_000, commissionCents: 18_000, totalCents: 138_000, status: "pending", paidDate: null, hours: { invested: 30.5, billable: 25 } },
  ],
});

function renderAs(user: SessionUser) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (String(input).startsWith("/api/payouts?")) return json(data(user.role === "boss"));
    return json({ ok: true, replacedLead: null, copied: 0, from: "2026-10" });
  }) as typeof fetch;
  render(
    <QueryClientProvider client={withSession(new QueryClient({ defaultOptions: { queries: { retry: false } } }), user)}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={["/financiera/pagos"]}>
          <Routes>
            <Route path="/financiera/pagos" element={<PayoutsPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
  return calls;
}

describe("Pagos / Comisiones", () => {
  it("básico + comisiones = total, horas con «h» y totales al pie; Financiera no edita rol ni team", async () => {
    renderAs(FINANCE);
    const table = await screen.findByRole("table", { name: /Pagos de/ });
    const caleb = within(within(table).getByText("Caleb").closest("tr")!);
    expect(caleb.getByText("Semi Senior Developer")).toBeTruthy();
    expect(caleb.getByText("30.5h")).toBeTruthy();
    expect(caleb.getByText(/1,380\.00/)).toBeTruthy();
    expect(caleb.queryByRole("combobox", { name: "Rol de Caleb" })).toBeNull();
    expect(within(table.querySelector("tfoot")!).getByText(/3,880\.00/)).toBeTruthy();
    expect(screen.getByText(/Rol y team los cambia un CEO\/CCO/)).toBeTruthy();
  });

  it("editar básico y estado guarda en el mes; boss cambia el rol en el usuario", async () => {
    const calls = renderAs(BOSS);
    const basic = await screen.findByLabelText("Básico de Caleb");
    fireEvent.change(basic, { target: { value: "1300" } });
    fireEvent.blur(basic);
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.url.startsWith("/api/payouts/u2/") && (c.body as { basicCents: number }).basicCents === 130_000)).toBe(true));
    await pick(screen.getByRole("combobox", { name: "Estado de pago de Caleb" }), "Pagado");
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && (c.body as { status: string }).status === "paid")).toBe(true));
    await pick(screen.getByRole("combobox", { name: "Rol de Caleb" }), "Senior Developer");
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.url === "/api/payouts/people/u2" && (c.body as { seniority: string }).seniority === "senior")).toBe(true));
  });

  it("pestañas por tipo de persona", async () => {
    renderAs(FINANCE);
    fireEvent.click(await screen.findByRole("tab", { name: /Pendientes/ }));
    expect(screen.queryByText("Manuel")).toBeNull();
    expect(screen.getByText("Caleb")).toBeTruthy();
  });
});
