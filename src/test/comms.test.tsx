import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ConfirmProvider } from "@/components/ui/confirm-provider";
import CommsPage from "@/features/communications/CommsPage";
import { followUp, type Communication } from "@/features/communications/api";
import type { SessionUser } from "@/features/auth/auth";
import { withSession } from "./session";

const COMMERCIAL: SessionUser = { id: "u-com", username: "marta", name: "Marta", role: "commercial", teamId: null, mustChangeCredentials: false };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const ago = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const comm = (id: string, extra: Partial<Communication>): Communication => ({ id, kind: "email", direction: "sent", subject: "", body: "", owner: { id: "u-com", name: "Marta" }, contactName: "Lucía", date: ago(1), project: null, lead: null, followUpDate: null, followUpDone: false, ...extra });
const list = [
  comm("c1", { subject: "Propuesta enviada", lead: { id: "l1", name: "Acme" }, followUpDate: ago(2), body: "Quedó en revisar." }),
  comm("c2", { kind: "call", direction: "received", subject: "Revisión de avances", project: { id: "p1", name: "Portal" } }),
  comm("c3", { kind: "whatsapp", subject: "Recordatorio", project: { id: "p1", name: "Portal" } }),
];

function renderPage() {
  const calls: { url: string; method: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/api/communications") return json({ communications: list, canCreate: true, people: [{ id: "u-com", name: "Marta" }] });
    if (url === "/api/communications/summary") return json({ cold: [{ kind: "project", id: "p9", name: "Refyt", days: 12, since: "contact" }, { kind: "lead", id: "l2", name: "Nueva SAC", days: 4, since: "arrival" }], followUpsDue: 1, lastWeek: 3 });
    return json({ rows: [], total: 0, page: 1, pageSize: 100, facets: {}, totals: {}, ok: true });
  }) as typeof fetch;
  render(
    <QueryClientProvider client={withSession(new QueryClient({ defaultOptions: { queries: { retry: false } } }), COMMERCIAL)}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={["/comercial/comunicaciones"]}>
          <Routes>
            <Route path="/comercial/comunicaciones" element={<CommsPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
  return calls;
}

describe("Comunicaciones", () => {
  it("seguimiento: vencido, hoy o ninguno si ya se hizo", () => {
    const today = "2026-11-10";
    expect(followUp({ followUpDate: "2026-11-08", followUpDone: false }, today)).toMatchObject({ text: "Seguimiento vencido 2 d", tone: "danger" });
    expect(followUp({ followUpDate: today, followUpDone: false }, today)).toMatchObject({ tone: "warn" });
    expect(followUp({ followUpDate: "2026-11-08", followUpDone: true }, today)).toBeNull();
  });

  it("avisa de los que no tienen contacto reciente y filtra por tipo y búsqueda", async () => {
    renderPage();
    const alert = await screen.findByRole("region", { name: "Sin comunicación reciente" });
    expect(within(alert).getByText("Sin contacto hace 12 d")).toBeTruthy();
    expect(within(alert).getByText("Sin respuesta desde que llegó hace 4 d")).toBeTruthy();
    expect(screen.getByText("Seguimiento vencido 2 d")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Llamadas/ }));
    expect(screen.getByText("Revisión de avances")).toBeTruthy();
    expect(screen.queryByText("Propuesta enviada")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Todas/ }));
    fireEvent.change(screen.getByLabelText("Buscar comunicación"), { target: { value: "recordatorio" } });
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });

  it("marcar el seguimiento hecho desde el detalle", async () => {
    const calls = renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Ver detalle de Propuesta enviada" }));
    fireEvent.click(screen.getByRole("button", { name: "Marcar seguimiento hecho" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.url === "/api/communications/c1" && (c.body as { followUpDone: boolean }).followUpDone)).toBe(true));
  });
});
