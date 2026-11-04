import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ConfirmProvider } from "@/components/ui/confirm-provider";
import { Toaster } from "@/components/ui/toaster";
import type { SessionUser } from "@/features/auth/auth";
import SitesPage from "@/features/sites/SitesPage";
import { withSession } from "./session";

const COMMERCIAL: SessionUser = { id: "u-com", username: "marta", name: "Marta", role: "commercial", teamId: null, mustChangeCredentials: false };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const site = { id: "a".repeat(24), name: "demo-manpersa", url: "https://demo-manpersa.sites.whatever.tech", status: "live", homepage: "index.html", files: [{ path: "index.html", size: 10 }], totalSize: 10, access: { mode: "public" }, domain: "ready", createdAt: "2026-10-29T10:00:00Z", updatedAt: "2026-10-29T10:00:00Z", deletedAt: null, proposalId: "p1", lead: { id: "l1", name: "Manpersa SAC" }, project: null };

function renderPage(configured = true) {
  const calls: { url: string; method: string; body?: BodyInit | null }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body });
    if (url === "/api/sites/config") return json(configured ? { configured: true, sitesSuffix: ".sites.whatever.tech", maxUploadMb: 50 } : { configured: false });
    if (url.startsWith("/api/sites/name-availability")) return json({ available: true });
    if (url.startsWith("/api/sites?status=live")) return json({ items: [site], counts: { live: 1, archived: 0, deleted: 2 }, canWrite: true });
    if (url.includes("/stats")) return json({ series: [{ day: "2026-11-03", people: 2, visits: 3, views: 4 }], period: { people: 2, visits: 3, views: 4 }, allTime: { people: 9, views: 20 }, log: [{ visitor: "v1", start: new Date().toISOString(), end: new Date().toISOString(), pages: 2, device: "desktop", os: "macOS", browser: "Chrome", referrer: null }] });
    if (url.startsWith("/api/sales/leads")) return json({ rows: [{ id: "l1", title: "Manpersa SAC" }], total: 1, page: 1, pageSize: 100, facets: {}, totals: {} });
    if (url.startsWith("/api/sites?") && init?.method === "POST") return json({ site }, 201);
    return json({});
  }) as typeof fetch;
  const queryClient = withSession(new QueryClient({ defaultOptions: { queries: { retry: false } } }), COMMERCIAL);
  render(
    <QueryClientProvider client={queryClient}>
      <Toaster>
        <ConfirmProvider>
          <MemoryRouter>
            <SitesPage />
          </MemoryRouter>
        </ConfirmProvider>
      </Toaster>
    </QueryClientProvider>,
  );
  return calls;
}

describe("Propuestas (sitios en WTProposalPlatform)", () => {
  it("cada propuesta es una tarjeta con su enlace, el lead y las acciones del prototipo", async () => {
    renderPage();
    const card = within((await screen.findByRole("link", { name: "demo-manpersa.sites.whatever.tech" })).closest("li")!);
    expect(card.getByText(/Manpersa SAC/)).toBeTruthy();
    for (const name of [/Actualizar/, /Abrir demo-manpersa/, /Estadísticas de/, /Copiar enlace de/, /Más acciones de/]) expect(card.getByRole("button", { name })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Papelera/ }).textContent).toContain("2");
  });

  it("subir: el código pegado va como multipart con el nombre y el lead elegido", async () => {
    const calls = renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Subir propuesta/ }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Nombre del enlace"), { target: { value: "propuesta-andina" } });
    expect(await dialog.findByText("Disponible")).toBeTruthy();
    fireEvent.click(dialog.getByRole("tab", { name: /Pegar código/ }));
    fireEvent.change(dialog.getByLabelText("Código HTML"), { target: { value: "<h1>Hola</h1>" } });
    fireEvent.click(dialog.getByRole("button", { name: "Publicar" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.startsWith("/api/sites?"))).toBe(true));
    const form = calls.find((c) => c.method === "POST")!.body as FormData;
    expect(form.get("name")).toBe("propuesta-andina");
    expect(form.get("html")).toBe("<h1>Hola</h1>");
  });

  it("estadísticas: personas, visitas y páginas del periodo, y el registro de visitas", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Estadísticas de/ }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(await dialog.findByText("Registro de visitas")).toBeTruthy();
    expect(dialog.getByText("Visitante 1")).toBeTruthy();
    expect(dialog.getByText(/macOS · Chrome · desde Directo/)).toBeTruthy();
    expect(dialog.getByText("Histórico: 9 · dispositivos distintos que lo abrieron")).toBeTruthy();
  });

  it("sin la plataforma configurada lo explica en lugar de la lista", async () => {
    renderPage(false);
    expect(await screen.findByText(/aún no está conectada a WTProposalPlatform/)).toBeTruthy();
  });
});
