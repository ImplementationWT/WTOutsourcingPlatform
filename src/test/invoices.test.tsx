import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ConfirmProvider } from "@/components/ui/confirm-provider";
import InvoicesPage from "@/features/finance/InvoicesPage";
import type { Invoice } from "@/features/finance/api";
import type { SessionUser } from "@/features/auth/auth";
import { pick } from "./pick";
import { withSession } from "./session";

const FINANCE: SessionUser = { id: "u-fin", username: "fede", name: "Fede", role: "finance", teamId: null, mustChangeCredentials: false };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const inv = (id: string, number: string, stage: Invoice["stage"], effectiveStage: Invoice["stage"], hours: number, feeCents = 0): Invoice => ({
  id, number, month: "2026-10", stage, effectiveStage, invoicedDate: null, paidDate: null, sustained: false,
  project: { id: "p1", name: "Arzuman Brothers" }, deal: { id: "d1", code: "DL-0002", title: "Warranty Services Apps" }, lead: { id: "u1", name: "Manuel" }, paymentType: "stripe",
  hours, rateCents: 5000, grossCents: hours * 5000, feeCents, totalCents: hours * 5000 + feeCents, currency: "USD",
});
const data = {
  invoices: [inv("i1", "INV-0001", "paid", "paid", 60, 9000), inv("i2", "INV-0002", "overdue", "overdue", 48), inv("i3", "INV-0003", "pending", "upcoming", 10)],
  projects: [{ id: "p1", name: "Arzuman Brothers", deals: [{ id: "d1", code: "DL-0002", title: "Warranty Services Apps", rateCents: 5000 }] }],
};

function renderPage() {
  const calls: { url: string; method: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (init?.method === "POST") return json({ invoice: inv("i4", "INV-0004", "pending", "pending", 0) }, 201);
    return json(data);
  }) as typeof fetch;
  render(
    <QueryClientProvider client={withSession(new QueryClient({ defaultOptions: { queries: { retry: false } } }), FINANCE)}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={["/financiera/invoices"]}>
          <Routes>
            <Route path="/financiera/invoices" element={<InvoicesPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
  return calls;
}

describe("Invoices", () => {
  it("agrupa por stage (Pending de un mes futuro va a Upcoming) y muestra bruto = horas × rate y total = bruto + fee", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: "Invoices" });
    const groups = within(table).getAllByText(/^(Overdue|Upcoming|Paid)$/, { selector: "b" }).map((n) => n.textContent);
    expect(groups).toEqual(["Overdue", "Upcoming", "Paid"]);
    const paid = within(within(table).getByRole("button", { name: "INV-0001" }).closest("tr")!);
    expect(paid.getByText(/3,000\.00/)).toBeTruthy();
    expect(paid.getByText(/3,090\.00/)).toBeTruthy();
    expect(screen.getByText("Vencido").closest("div")!.parentElement!.textContent).toMatch(/2,400\.00/);
  });

  it("cambiar el stage y crear una invoice", async () => {
    const calls = renderPage();
    await pick(await screen.findByRole("combobox", { name: "Stage de INV-0002" }), "Paid");
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.url === "/api/invoices/i2" && (c.body as { stage: string }).stage === "paid")).toBe(true));
    screen.getByRole("button", { name: /Nueva/ }).click();
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && (c.body as { projectId: string }).projectId === "p1")).toBe(true));
  });
});
