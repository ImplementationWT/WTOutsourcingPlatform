import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import AppSidebar from "@/components/layout/AppSidebar";
import CostsSection from "@/features/costs/CostsSection";
import UserMenu from "@/components/layout/UserMenu";
import { fireEvent } from "@testing-library/react";
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

describe("menú", () => {
  it("la barra lateral no tiene Costos (está en el Dashboard) ni Usuarios", () => {
    renderWith(<AppSidebar />, BOSS);
    expect(screen.getByText("Dashboard")).toBeTruthy();
    expect(screen.queryByText("Costos")).toBeNull();
    expect(screen.queryByText("Usuarios")).toBeNull();
  });

  it("Usuarios y equipos está en el menú del usuario, solo para CEO/CCO", async () => {
    const teams = (async () => json({ teams: [] })) as typeof fetch;
    renderWith(<UserMenu />, BOSS, teams);
    fireEvent.click(screen.getByText("Jefa"));
    expect(await screen.findByText("Usuarios y equipos")).toBeTruthy();
    expect(screen.getByText("CEO/CCO")).toBeTruthy();
  });

  it("un team leader no ve Usuarios y equipos", async () => {
    renderWith(<UserMenu />, LEAD, (async () => json({ teams: [] })) as typeof fetch);
    fireEvent.click(screen.getByText("Ana"));
    expect(await screen.findByText("Configuración")).toBeTruthy();
    expect(screen.queryByText("Usuarios y equipos")).toBeNull();
  });
});

describe("Costos", () => {
  it("USD con 2 decimales", () => {
    expect(formatUsd(123456)).toMatch(/1.?234,56/);
    expect(formatUsd(5)).toMatch(/0,05/);
    expect(formatUsd(null)).toBe("—");
  });

  it("CEO/CCO: tarjetas por equipo, gráficos, aviso de precio de lista y sin exportar CSV", async () => {
    const urls: string[] = [];
    renderWith(<CostsSection />, BOSS, (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return json(summary("boss"));
    }) as typeof fetch);
    expect(await screen.findByText("Proyectos más caros")).toBeTruthy();
    expect(screen.getByText(/Precio de lista/)).toBeTruthy();
    expect(screen.getByRole("list", { name: "Proyectos más caros" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Gasto por persona" })).toBeTruthy();
    expect(screen.getAllByText("Equipo A").length).toBeGreaterThan(0);
    expect(screen.queryByText("Exportar CSV")).toBeNull();
    expect(urls[0]).toMatch(/^\/api\/costs\/summary\?from=\d{4}-\d{2}-01&to=\d{4}-\d{2}-\d{2}$/);
  });

  it("developer: sus sesiones", async () => {
    renderWith(<CostsSection />, { ...LEAD, role: "developer" }, (async (input: RequestInfo | URL) => {
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
