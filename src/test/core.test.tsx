import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfirmProvider } from "@/components/ui/confirm-provider";
import { MemoryRouter, Navigate, Route, Routes } from "react-router-dom";
import type { SessionUser } from "@/features/auth/auth";
import type { CompanyRow, Contact, Deal } from "@/features/core/api";
import CompaniesPage from "@/features/core/CompaniesPage";
import ContactDetailPage from "@/features/core/ContactDetailPage";
import DealDetailPage from "@/features/core/DealDetailPage";
import DealsPage from "@/features/core/DealsPage";
import { optionLabels } from "./pick";
import { BOSS, LEAD } from "./session";

const COMMERCIAL: SessionUser = { id: "u-com", username: "marta", name: "Marta", role: "commercial", teamId: null, mustChangeCredentials: false };
const FINANCE: SessionUser = { id: "u-fin", username: "fede", name: "Fede", role: "finance", teamId: null, mustChangeCredentials: false };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; init?: RequestInit };

const page = <T,>(rows: T[], extra: Record<string, unknown> = {}) => ({ rows, total: rows.length, page: 1, pageSize: 25, facets: {}, totals: {}, ...extra });

const deal: Deal = {
  id: "44444444-4444-4444-8444-444444444444",
  dealCode: "DL-0007",
  title: "Módulo de pedidos",
  description: "",
  project: { id: "p-1", name: "Automatización Manpersa", customerName: "Manpersa SAC" },
  lead: null,
  contacts: [{ id: "c-1", name: "Lucía Pérez" }],
  owner: null,
  partner: null,
  salesStage: "proposal",
  status: "draft",
  hours: 40,
  rateCents: 2_500,
  amountCents: 100_000,
  probability: 50,
  projectedCents: 50_000,
  currency: "USD",
  expectedCloseDate: null,
  actualCloseDate: null,
  saleType: null,
  product: null,
  channel: null,
  lostReason: null,
  partnerCommissionPct: null,
  partnerCommissionCents: 0,
  proposalUrl: null,
  sowUrl: null,
  paidAt: null,
  updatedAt: "2026-10-28T10:00:00Z",
  canEdit: true,
  changeOrders: [],
};

function renderAt(path: string, user: SessionUser, fetchImpl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return fetchImpl(String(input), init);
  }) as typeof fetch;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(["session"], user);
  render(
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/comercial/deals" element={<DealsPage />} />
          <Route path="/deals/:id" element={<DealDetailPage />} />
          <Route path="/comercial/empresas" element={<CompaniesPage />} />
          <Route path="/comercial/empresas/:id" element={<p>Detalle de empresa</p>} />
          <Route path="/comercial/contactos/:id" element={<ContactDetailPage />} />
          <Route path="/comercial/clientes" element={<Navigate to="/comercial/empresas" replace />} />
        </Routes>
      </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
  return { calls };
}

const originalMatchMedia = window.matchMedia;
afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe("Deals", () => {
  it("tabla con código, relaciones, totales al pie del servidor y valor proyectado", async () => {
    renderAt("/comercial/deals", BOSS, () => json(page([deal], { totals: { hours: 120, amountCents: 300_000, projectedCents: 150_000 }, canCreate: true })));
    const table = await screen.findByRole("table", { name: "Deals" });
    expect(within(table).getByText("DL-0007")).toBeTruthy();
    expect(within(table).getByRole("link", { name: "Automatización Manpersa" }).getAttribute("href")).toBe("/operativa/p-1");
    expect(within(table).getByRole("link", { name: "Lucía Pérez" }).getAttribute("href")).toBe("/comercial/contactos/c-1");
    const foot = within(table.querySelector("tfoot")!);
    expect(foot.getByText("120 h")).toBeTruthy();
    expect(foot.getByText(/3,000\.00/)).toBeTruthy();
    expect(foot.getByText(/1,500\.00/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Nuevo deal/ })).toBeTruthy();
  });

  it("Comercial solo elige estados hasta «Propuesto» en la celda", async () => {
    renderAt("/comercial/deals", COMMERCIAL, () => json(page([deal], { canCreate: true })));
    expect(await optionLabels("Estado de Módulo de pedidos")).toEqual(["Borrador", "Propuesto"]);
  });

  it("editar las horas en la celda guarda solo ese campo", async () => {
    const { calls } = renderAt("/comercial/deals", BOSS, (_url, init) => (init?.method === "PATCH" ? json({ deal: { ...deal, hours: 50 } }) : json(page([deal]))));
    const input = await screen.findByLabelText("Horas de Módulo de pedidos");
    fireEvent.change(input, { target: { value: "50" } });
    fireEvent.blur(input);
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.init?.method === "PATCH")!;
    expect(patch.url).toBe(`/api/deals/${deal.id}`);
    expect(JSON.parse(String(patch.init?.body))).toEqual({ hours: 50 });
  });

  it("un deal facturado no deja editar horas (van como change order)", async () => {
    renderAt("/comercial/deals", BOSS, () => json(page([{ ...deal, status: "invoiced" }])));
    await screen.findByRole("table", { name: "Deals" });
    expect(screen.queryByLabelText("Horas de Módulo de pedidos")).toBeNull();
  });

  it("Financiera lee sin controles", async () => {
    renderAt("/comercial/deals", FINANCE, () => json(page([{ ...deal, canEdit: false }], { canCreate: false })));
    await screen.findByRole("table", { name: "Deals" });
    expect(screen.queryByLabelText("Estado de Módulo de pedidos")).toBeNull();
    expect(screen.queryByRole("button", { name: /Nuevo deal/ })).toBeNull();
  });

  it("en el celular cada fila es una tarjeta", async () => {
    window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
    renderAt("/comercial/deals", FINANCE, () => json(page([{ ...deal, canEdit: false }], { totals: { hours: 40, amountCents: 100_000, projectedCents: 50_000 } })));
    const card = await screen.findByRole("link", { name: /Módulo de pedidos/ });
    expect(screen.queryByRole("table")).toBeNull();
    expect(within(card).getByText("Valor")).toBeTruthy();
    expect(within(screen.getByLabelText("Totales")).getByText("40 h")).toBeTruthy();
  });

  it("detalle: el Team Leader agrega un change order", async () => {
    const { calls } = renderAt(`/deals/${deal.id}`, LEAD, (url, init) => {
      if (url.endsWith("/change-orders") && init?.method === "POST") return json({ changeOrder: {} }, 201);
      return json({ deal });
    });
    expect(await screen.findByRole("heading", { name: "Módulo de pedidos" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Cambio"), { target: { value: "Reporte extra" } });
    fireEvent.change(screen.getByLabelText("Horas", { selector: "#co-hours" }), { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: /Agregar/ }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/change-orders"))).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith("/change-orders"))!.init?.body))).toEqual({ description: "Reporte extra", hours: 8, rateCents: 2_500 });
  });
});

describe("Empresas y Contactos", () => {
  const company: CompanyRow = { id: "co-1", name: "Manpersa SAC", domain: "manpersa.pe", industry: "Logística", size: "51-200", location: "Lima", contacts: 2, projects: 1, createdAt: "", updatedAt: "" };

  it("Clientes redirige a Empresas; la búsqueda va a la URL de la API", async () => {
    const { calls } = renderAt("/comercial/clientes", COMMERCIAL, () => json(page([company])));
    expect(await screen.findByRole("heading", { name: "Empresas" })).toBeTruthy();
    expect(within(await screen.findByRole("table", { name: "Empresas" })).getByText("Manpersa SAC")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Buscar"), { target: { value: "manp" } });
    await waitFor(() => expect(calls.some((c) => c.url.startsWith("/api/companies?") && c.url.includes("q=manp"))).toBe(true));
    expect(screen.getByRole("button", { name: /Nueva empresa/ })).toBeTruthy();
  });

  it("Financiera ve Empresas sin poder crear", async () => {
    renderAt("/comercial/empresas", FINANCE, () => json(page([company])));
    await screen.findByRole("table", { name: "Empresas" });
    expect(screen.queryByRole("button", { name: /Nueva empresa/ })).toBeNull();
  });

  it("clic en la fila abre el detalle", async () => {
    renderAt("/comercial/empresas", COMMERCIAL, () => json(page([company])));
    fireEvent.click(await screen.findByText("Manpersa SAC"));
    expect(await screen.findByText("Detalle de empresa")).toBeTruthy();
  });

  it("detalle del contacto: empresa, leads, deals y proyectos enlazados", async () => {
    const contact: Contact = { id: "c-1", name: "Lucía Pérez", emails: ["lucia@manpersa.pe"], phone: null, title: "Gerente", linkedinUrl: null, company: { id: "co-1", name: "Manpersa SAC" }, createdAt: "", updatedAt: "" };
    renderAt("/comercial/contactos/c-1", COMMERCIAL, () =>
      json({
        contact,
        leads: [{ id: "l-1", title: "Manpersa SAC", status: "won" }],
        deals: [{ id: deal.id, dealCode: "DL-0007", title: "Módulo de pedidos", status: "approved" }],
        projects: [{ id: "p-1", name: "Automatización Manpersa", stage: "kickoff" }],
      }),
    );
    expect(await screen.findByRole("heading", { name: "Lucía Pérez" })).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Manpersa SAC" }).map((a) => a.getAttribute("href"))).toEqual(["/comercial/empresas/co-1", "/comercial/leads/l-1"]);
    expect(screen.getByRole("link", { name: "DL-0007 · Módulo de pedidos" }).getAttribute("href")).toBe(`/deals/${deal.id}`);
    expect(screen.getByRole("link", { name: "Automatización Manpersa" }).getAttribute("href")).toBe("/operativa/p-1");
  });
});
