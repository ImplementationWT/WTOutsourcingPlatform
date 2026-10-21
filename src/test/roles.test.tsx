import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import AppSidebar from "@/components/layout/AppSidebar";
import CostsPage from "@/features/costs/CostsPage";
import { formatUsd } from "@/features/costs/api";
import { BOSS, LEAD, withSession } from "./session";

function renderWith(ui: React.ReactNode, user = LEAD, fetchImpl?: typeof fetch) {
  if (fetchImpl) globalThis.fetch = fetchImpl;
  const queryClient = withSession(new QueryClient({ defaultOptions: { queries: { retry: false } } }), user);
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const summary = (scope: string) => ({
  scope,
  currency: "USD",
  listPrice: true,
  totals: { costCents: 123456, sessions: 4, mergedPrs: 2, costPerMergedPrCents: 61728 },
  byMonth: [{ month: "2026-09", costCents: 123456, sessions: 4, mergedPrs: 2, costPerMergedPrCents: 61728 }],
  byTeam: [{ teamId: "t-1", name: "Equipo A", costCents: 123456, sessions: 4, mergedPrs: 2, costPerMergedPrCents: 61728 }],
  byProject: [{ clientId: "acme", name: "Acme", teamName: "Equipo A", costCents: 123456, sessions: 4, mergedPrs: 2, costPerMergedPrCents: 61728 }],
  byPerson: [{ name: "Diego", username: "dev", costCents: 123456, sessions: 4, mergedPrs: 2, costPerMergedPrCents: 61728 }],
});

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

describe("menú por rol", () => {
  it("Usuarios solo para jefes; Costos para todos", () => {
    renderWith(<AppSidebar />, LEAD);
    expect(screen.getByText("Costos")).toBeTruthy();
    expect(screen.queryByText("Usuarios")).toBeNull();
  });

  it("el jefe ve Usuarios", () => {
    renderWith(<AppSidebar />, BOSS);
    expect(screen.getByText("Usuarios")).toBeTruthy();
  });
});

describe("Costos", () => {
  it("USD con 2 decimales", () => {
    expect(formatUsd(123456)).toMatch(/1.?234,56/);
    expect(formatUsd(5)).toMatch(/0,05/);
    expect(formatUsd(null)).toBe("—");
  });

  it("jefe: tarjetas por equipo, aviso de precio de lista y exportación con el rango", async () => {
    const urls: string[] = [];
    renderWith(<CostsPage />, BOSS, (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return json(summary("boss"));
    }) as typeof fetch);
    expect(await screen.findByText("Equipo A", { selector: "p" })).toBeTruthy();
    expect(screen.getByText(/Precio de lista/)).toBeTruthy();
    expect(screen.getByText("Proyectos más caros")).toBeTruthy();
    expect(urls[0]).toMatch(/^\/api\/costs\/summary\?from=\d{4}-\d{2}-01&to=\d{4}-\d{2}-\d{2}$/);
    const link = screen.getByText("Exportar CSV").closest("a")!;
    expect(link.getAttribute("href")).toMatch(/^\/api\/costs\/export\.csv\?from=/);
  });

  it("developer: sus sesiones", async () => {
    renderWith(<CostsPage />, { ...LEAD, role: "developer" }, (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/costs/sessions")) {
        return json({
          sessions: [
            { id: "s1", createdAt: "2026-09-02T10:00:00Z", month: "2026-09", clientId: "acme", project: "Acme", team: "Equipo A", person: "Diego", username: "dev", title: "Arreglar login", status: "merged", merged: true, pullRequest: 7, costCents: 250, deleted: false },
          ],
        });
      }
      return json(summary("developer"));
    }) as typeof fetch);
    expect(await screen.findByText("Arreglar login")).toBeTruthy();
    expect(screen.getByText("Tus sesiones")).toBeTruthy();
    expect(screen.getByText(/PR #7/)).toBeTruthy();
  });
});
