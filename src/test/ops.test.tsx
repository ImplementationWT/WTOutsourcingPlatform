import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfirmProvider } from "@/components/ui/confirm-provider";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AppSidebar from "@/components/layout/AppSidebar";
import OpsProjectDetailPage from "@/features/ops/OpsProjectDetailPage";
import OpsProjectsPage from "@/features/ops/OpsProjectsPage";
import type { OpsProject, OpsProjectRow } from "@/features/ops/api";
import type { SessionUser } from "@/features/auth/auth";
import { pick } from "./pick";
import { BOSS, LEAD, withSession } from "./session";

const COMMERCIAL: SessionUser = { id: "u-com", username: "marta", name: "Marta", role: "commercial", teamId: null, mustChangeCredentials: false };
const FINANCE: SessionUser = { id: "u-fin", username: "fede", name: "Fede", role: "finance", teamId: null, mustChangeCredentials: false };
const DEV: SessionUser = { ...LEAD, id: "u-dev", username: "dev", name: "Diego", role: "developer" };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const project: OpsProject = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Automatización Manpersa",
  customerName: "Manpersa SAC",
  team: { id: "t-1", name: "Equipo A" },
  lead: { id: "u-lead", name: "Ana" },
  developer: { id: "u-dev", name: "Diego" },
  contacts: [],
  clientSlug: null,
  proposalUrl: "https://demo.example.com/manpersa",
  projectPlanUrl: null,
  sowUrl: null,
  kickoffDate: null,
  leadId: null,
  stage: "structure",
  health: "at_risk",
  sentimentScore: 20,
  priority: "critical",
  paymentType: null,
  nextAction: null,
  summary: { deals: 2, amountCents: 150_000, soldHours: 60, billableHours: 0, billableVsSold: -60, tasks: 4, tasksDone: 1, progress: 25 },
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-28T10:00:00Z",
};
const listItem: OpsProjectRow = { ...project, canManage: false };

/** Respuesta de una tabla paginada en el servidor. */
const page = <T,>(rows: T[], extra: Record<string, unknown> = {}) => ({
  rows,
  total: rows.length,
  page: 1,
  pageSize: 25,
  facets: {},
  totals: { soldHours: 60, billableHours: 0, amountCents: 150_000 },
  canCreate: false,
  ...extra,
});

function renderAt(path: string, user: SessionUser, fetchImpl?: typeof fetch) {
  if (fetchImpl) globalThis.fetch = fetchImpl;
  const queryClient = withSession(new QueryClient({ defaultOptions: { queries: { retry: false } } }), user);
  render(
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[path]}>
        <AppSidebar />
        <Routes>
          <Route path="/operativa" element={<OpsProjectsPage />} />
          <Route path="/operativa/:id" element={<OpsProjectDetailPage />} />
        </Routes>
      </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("menú por áreas", () => {
  // Solo los títulos de grupo de la barra lateral (la página tiene su propio encabezado "Operativa").
  const sections = () =>
    within(screen.getByRole("navigation", { name: "Áreas" }))
      .queryAllByText(/^(Comercial|Operativa|Financiera|Infraestructura)$/)
      .map((n) => n.textContent);

  it("CEO/CCO ve las cuatro áreas (Financiera, que aún no existe, al pie con «Pronto»)", () => {
    renderAt("/operativa", BOSS, (async () => json(page([]))) as typeof fetch);
    expect(sections()).toEqual(["Comercial", "Operativa", "Infraestructura", "Financiera"]);
  });

  it("Comercial: Comercial y Operativa, sin Infraestructura", () => {
    renderAt("/operativa", COMMERCIAL, (async () => json(page([]))) as typeof fetch);
    expect(sections()).toEqual(["Comercial", "Operativa"]);
  });

  it("Financiera: Comercial (en lectura), Operativa y Financiera", () => {
    renderAt("/operativa", FINANCE, (async () => json(page([]))) as typeof fetch);
    expect(sections()).toEqual(["Comercial", "Operativa", "Financiera"]);
    expect(screen.getByRole("link", { name: /^Leads$/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Sources de leads/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Reuniones por asignar/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Empresas/ })).toBeNull();
  });

  it("developer: Operativa e Infraestructura", () => {
    renderAt("/operativa", DEV, (async () => json(page([]))) as typeof fetch);
    expect(sections()).toEqual(["Operativa", "Infraestructura"]);
  });

  it("Comercial ya es un enlace; Financiera, que aún no existe, no", () => {
    renderAt("/operativa", BOSS, (async () => json(page([]))) as typeof fetch);
    expect(screen.getByRole("link", { name: /^Leads$/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Cobros y comisiones/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Proyectos del cliente/ })).toBeTruthy();
  });

  it("Deals y Meetings son generales (un solo tablero); Contactos sigue en Comercial", () => {
    renderAt("/operativa", BOSS, (async () => json(page([]))) as typeof fetch);
    expect(screen.getByRole("link", { name: /Contactos/ }).getAttribute("href")).toBe("/comercial/contactos");
    expect(screen.queryByRole("link", { name: /Empresas/ })).toBeNull();
    expect(screen.getAllByRole("link", { name: /^Deals$/ }).map((a) => a.getAttribute("href"))).toEqual(["/deals"]);
    expect(screen.getByRole("link", { name: /^Meetings$/ }).getAttribute("href")).toBe("/meetings");
    expect(screen.queryByRole("link", { name: /^Clientes$/ })).toBeNull();
  });
});

describe("tabla de proyectos (DataTable)", () => {
  it("muestra etapa, health, prioridad, sentiment derivado y los campos calculados", async () => {
    renderAt("/operativa", LEAD, (async () => json(page([listItem]))) as typeof fetch);
    const table = await screen.findByRole("table", { name: "Proyectos" });
    const row = within(within(table).getByText("Automatización Manpersa").closest("tr")!);
    expect(row.getByText("Estructura")).toBeTruthy();
    expect(row.getByText("At Risk")).toBeTruthy();
    expect(row.getByText("Critical")).toBeTruthy();
    expect(row.getByTitle("Sentiment score: 20/100")).toBeTruthy();
    expect(row.getByText("60 h")).toBeTruthy();
    expect(row.getByText("-60 h")).toBeTruthy();
    expect(row.getByText("25%")).toBeTruthy();
    // Totales al pie, del conjunto filtrado.
    const foot = within(table.querySelector("tfoot")!);
    expect(foot.getByText("60 h")).toBeTruthy();
  });

  it("filtros, búsqueda y orden van a la API y a la URL; cambiar un filtro vuelve a la página 1", async () => {
    const urls: string[] = [];
    renderAt("/operativa?page=3", LEAD, (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return json(page([], { total: 80 }));
    }) as typeof fetch);
    await waitFor(() => expect(urls.some((u) => u.includes("page=3"))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: /^Filtros/ }));
    await pick("Filtrar por health", "At Risk");
    await waitFor(() => expect(urls.some((u) => u.includes("health=at_risk") && u.includes("page=1"))).toBe(true));
    fireEvent.change(screen.getByLabelText("Buscar"), { target: { value: "manpersa" } });
    await waitFor(() => expect(urls.some((u) => u.includes("q=manpersa"))).toBe(true));
  });

  it("ordenar por una columna pide el orden al servidor", async () => {
    const urls: string[] = [];
    renderAt("/operativa", LEAD, (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return json(page([listItem]));
    }) as typeof fetch);
    fireEvent.click(await screen.findByRole("button", { name: /Etapa/ }));
    await waitFor(() => expect(urls.some((u) => u.includes("sort=stage") && u.includes("dir=asc"))).toBe(true));
  });

  it("agrupar por etapa muestra el contador del servidor", async () => {
    renderAt("/operativa?group=1", LEAD, (async () => json(page([listItem], { facets: { structure: 7 } }))) as typeof fetch);
    const header = await screen.findByRole("columnheader", { name: /Estructura/ });
    expect(within(header).getByText("7")).toBeTruthy();
  });

  it("edición en la celda: el Team Leader cambia el health sin abrir el detalle", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    renderAt("/operativa", LEAD, (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (init?.method === "PATCH") return json({ project: { ...project, health: "happy" } });
      return json(page([{ ...listItem, canManage: true }]));
    }) as typeof fetch);
    await pick("Health de Automatización Manpersa", "Happy");
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.init?.method === "PATCH")!;
    expect(patch.url).toBe(`/api/ops/projects/${project.id}`);
    expect(JSON.parse(String(patch.init?.body))).toEqual({ health: "happy" });
    expect(screen.getByRole("table", { name: "Proyectos" })).toBeTruthy();
  });

  it("clic en la fila abre el detalle", async () => {
    renderAt("/operativa", LEAD, (async (input: RequestInfo | URL) =>
      String(input).endsWith(`/api/ops/projects/${project.id}`) ? json({ project, permissions: { manage: false, work: true } }) : json(page([listItem]))) as typeof fetch);
    fireEvent.click(await screen.findByText("Automatización Manpersa"));
    expect(await screen.findByRole("heading", { name: "Automatización Manpersa" })).toBeTruthy();
  });

  it("solo quien puede crear ve el botón (lo indica la API)", async () => {
    renderAt("/operativa", LEAD, (async () => json(page([], { canCreate: true }))) as typeof fetch);
    expect(await screen.findByRole("button", { name: /Nuevo proyecto/ })).toBeTruthy();
  });

  it("comercial, finance y developer no ven el botón de crear", async () => {
    renderAt("/operativa", COMMERCIAL, (async () => json(page([listItem]))) as typeof fetch);
    await screen.findByText("Automatización Manpersa");
    expect(screen.queryByRole("button", { name: /Nuevo proyecto/ })).toBeNull();
  });
});

describe("detalle del proyecto", () => {
  const route = (permissions: { manage: boolean; work: boolean }) =>
    (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/api/ops/projects/${project.id}`)) return json({ project, permissions });
      if (url.startsWith("/api/deals")) return json(page([]));
      return json({ members: [], tasks: [], updates: [], meetings: [], accounts: [], rows: [] });
    }) as typeof fetch;

  it("Team Leader: edita etapa, health y los campos nuevos; el Sentiment se deriva y no se edita", async () => {
    renderAt(`/operativa/${project.id}`, LEAD, route({ manage: true, work: true }));
    expect(await screen.findByRole("button", { name: "Maintenance" })).toBeTruthy();
    expect(screen.getByLabelText("Health")).toBeTruthy();
    expect(screen.queryByLabelText("Sentiment score")).toBeNull();
    expect(screen.getByText("Sentiment (del Health)")).toBeTruthy();
    for (const label of ["Kickoff", "Tipo de pago", "Siguiente acción", "Project Plan", "SOW"]) expect(screen.getByLabelText(label)).toBeTruthy();
    expect(screen.getByText("Horas vendidas")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Cuentas" })).toBeTruthy();
  });

  it("la pestaña Deals es la tabla de Deals filtrada por el proyecto", async () => {
    const urls: string[] = [];
    const base = route({ manage: true, work: true });
    renderAt(`/operativa/${project.id}`, LEAD, (async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      return base(input, init);
    }) as typeof fetch);
    expect(await screen.findByText("Este proyecto aún no tiene deals.")).toBeTruthy();
    expect(urls.some((u) => u.startsWith("/api/deals?") && u.includes(`projectId=${project.id}`))).toBe(true);
  });

  it("Comercial: solo lectura, sin controles ni pestaña de cuentas", async () => {
    renderAt(`/operativa/${project.id}`, COMMERCIAL, route({ manage: false, work: false }));
    expect(await screen.findByRole("heading", { name: "Automatización Manpersa" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Maintenance" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Cuentas" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Deals" })).toBeTruthy();
    expect(screen.queryByLabelText("Deal")).toBeNull();
  });

  it("cambiar la etapa envía solo ese campo", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const base = route({ manage: true, work: true });
    renderAt(`/operativa/${project.id}`, LEAD, (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (init?.method === "PATCH") return json({ project: { ...project, stage: "maintenance" } });
      return base(input, init);
    }) as typeof fetch);
    fireEvent.click(await screen.findByRole("button", { name: "Maintenance" }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.init?.method === "PATCH")!;
    expect(patch.url).toBe(`/api/ops/projects/${project.id}`);
    expect(JSON.parse(String(patch.init?.body))).toEqual({ stage: "maintenance" });
  });

  it("el valor de una cuenta solo se muestra al pedirlo y no queda en la caché", async () => {
    const secret = "Zq9-clave-MUY-secreta-4471";
    const account = { id: "a1", label: "Panel de hosting", kind: "web", url: null, username: "admin@cliente.pe", notes: "", credentialSet: true, rotatedAt: null };
    const base = route({ manage: true, work: true });
    const queryClient = renderAt(`/operativa/${project.id}`, LEAD, (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/accounts/a1/reveal")) return json({ username: "admin@cliente.pe", credential: secret });
      if (url.endsWith("/accounts")) return json({ accounts: [account] });
      return base(input, init);
    }) as typeof fetch);
    fireEvent.click(await screen.findByRole("tab", { name: "Cuentas" }));
    expect(await screen.findByText(/Panel de hosting/)).toBeTruthy();
    expect(screen.queryByText(secret)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Ver/ }));
    expect(await screen.findByText(secret)).toBeTruthy();
    expect(JSON.stringify(queryClient.getQueryCache().getAll().map((q) => q.state.data))).not.toContain(secret);
    fireEvent.click(screen.getByRole("button", { name: /Ocultar/ }));
    await waitFor(() => expect(screen.queryByText(secret)).toBeNull());
  });

  it("si el vault no está activado en el servidor lo explica", async () => {
    const base = route({ manage: true, work: true });
    renderAt(`/operativa/${project.id}`, LEAD, (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/accounts")) return json({ error: "El vault de cuentas no está disponible" }, 503);
      return base(input, init);
    }) as typeof fetch);
    fireEvent.click(await screen.findByRole("tab", { name: "Cuentas" }));
    expect(await screen.findByText(/aún no está activado en el servidor/)).toBeTruthy();
  });
});
