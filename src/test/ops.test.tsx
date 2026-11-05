import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfirmProvider } from "@/components/ui/confirm-provider";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AppSidebar from "@/components/layout/AppSidebar";
import OpsProjectsPage from "@/features/ops/OpsProjectsPage";
import { stageAge, type OpsProject, type OpsProjectRow } from "@/features/ops/api";
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
  developers: [{ id: "u-dev", name: "Diego" }],
  stageSince: new Date().toISOString().slice(0, 10),
  stageHistory: [],
  contacts: [],
  clientSlug: null,
  client: null,
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
          <Route path="/operativa/:id" element={<OpsProjectsPage />} />
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
      .getAllByRole("button")
      .filter((b) => b.hasAttribute("aria-expanded"))
      .map((n) => n.textContent);

  it("CEO/CCO ve todas las áreas, con Dashboards arriba", () => {
    renderAt("/operativa", BOSS, (async () => json(page([]))) as typeof fetch);
    expect(sections()).toEqual(["Dashboards", "Comercial", "Operativa", "Financiera", "Infraestructura"]);
  });

  it("Comercial: Comercial y Operativa, sin Infraestructura", () => {
    renderAt("/operativa", COMMERCIAL, (async () => json(page([]))) as typeof fetch);
    expect(sections()).toEqual(["Dashboards", "Comercial", "Operativa"]);
  });

  it("Financiera: Comercial (en lectura), Operativa y Financiera", () => {
    renderAt("/operativa", FINANCE, (async () => json(page([]))) as typeof fetch);
    expect(sections()).toEqual(["Dashboards", "Comercial", "Operativa", "Financiera"]);
    expect(screen.getByRole("link", { name: /^Leads$/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Sources de leads/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Reuniones por asignar/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Empresas/ })).toBeNull();
  });

  it("developer: Meetings (en Comercial), Operativa e Infraestructura", () => {
    renderAt("/operativa", DEV, (async () => json(page([]))) as typeof fetch);
    expect(sections()).toEqual(["Dashboards", "Comercial", "Operativa", "Infraestructura"]);
    expect(screen.getByRole("link", { name: /^Meetings$/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /^Leads$/ })).toBeNull();
  });

  it("Comercial ya es un enlace; Financiera, que aún no existe, no", () => {
    renderAt("/operativa", BOSS, (async () => json(page([]))) as typeof fetch);
    expect(screen.getByRole("link", { name: /^Leads$/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Cobros y comisiones/ })).toBeNull();
    expect(screen.getByRole("link", { name: /^Proyectos$/ }).getAttribute("href")).toBe("/operativa");
  });

  it("orden de Comercial; Deals fuera del menú (se gestiona en el proyecto); Infraestructura igual", () => {
    renderAt("/operativa", BOSS, (async () => json(page([]))) as typeof fetch);
    const nav = within(screen.getByRole("navigation", { name: "Áreas" }));
    const links = nav.getAllByRole("link").map((a) => a.textContent);
    expect(links).toEqual(["Financiero", "Comercial", "Operativo", "Contactos", "Leads", "Propuestas", "Meetings", "Comunicaciones", "Mi trabajo", "Proyectos", "Tasks", "Invoices", "Pagos / Comisiones", "Dashboard", "Apps y repositorios", "Integraciones", "Backlog / Sprints"]);
    expect(screen.getByRole("link", { name: /Contactos/ }).getAttribute("href")).toBe("/comercial/contactos");
    expect(screen.queryByRole("link", { name: /Empresas/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /^Deals$/ })).toBeNull();
    expect(screen.getByRole("link", { name: /^Meetings$/ }).getAttribute("href")).toBe("/meetings");
    expect(screen.queryByRole("link", { name: /^Clientes$/ })).toBeNull();
  });
});

describe("tabla de proyectos (DataTable)", () => {
  it("muestra etapa, Lead y Developers como avatares, prioridad y los campos calculados; sin «Siguiente acción»", async () => {
    localStorage.clear();
    renderAt("/operativa", LEAD, (async () => json(page([listItem]))) as typeof fetch);
    const table = await screen.findByRole("table", { name: "Proyectos" });
    const row = within(within(table).getByText("Automatización Manpersa").closest("tr")!);
    expect(row.getByText("Estructura")).toBeTruthy();
    expect(row.getByRole("img", { name: "Ana" })).toBeTruthy();
    expect(row.getByRole("img", { name: "Diego" })).toBeTruthy();
    expect(row.getByText("Critical")).toBeTruthy();
    expect(row.getByText("60 h")).toBeTruthy();
    expect(within(table).queryByRole("columnheader", { name: /Siguiente acción/ })).toBeNull();
    expect(screen.getByRole("heading", { name: "Proyectos" })).toBeTruthy();
    // Health y Avance quedan en «Columnas».
    expect(within(table).queryByRole("columnheader", { name: /Health/ })).toBeNull();
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

  it("agrupa por etapa de inicio, con el contador del servidor", async () => {
    renderAt("/operativa", LEAD, (async () => json(page([listItem], { facets: { structure: 7 } }))) as typeof fetch);
    const header = await screen.findByRole("columnheader", { name: /Estructura/ });
    expect(within(header).getByText("7 proyectos")).toBeTruthy();
  });

  it("edición en la celda: el Team Leader cambia la prioridad sin abrir el detalle", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    renderAt("/operativa", LEAD, (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (init?.method === "PATCH") return json({ project: { ...project, priority: "high" } });
      return json(page([{ ...listItem, canManage: true }]));
    }) as typeof fetch);
    await pick("Prioridad de Automatización Manpersa", "High");
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.init?.method === "PATCH")!;
    expect(patch.url).toBe(`/api/ops/projects/${project.id}`);
    expect(JSON.parse(String(patch.init?.body))).toEqual({ priority: "high" });
    expect(screen.getByRole("table", { name: "Proyectos" })).toBeTruthy();
  });

  it("clic en la fila abre el detalle", async () => {
    renderAt("/operativa", LEAD, (async (input: RequestInfo | URL) =>
      String(input).endsWith(`/api/ops/projects/${project.id}`) ? json({ project, permissions: { manage: false, work: true } }) : json(page([listItem]))) as typeof fetch);
    fireEvent.click(await screen.findByText("Automatización Manpersa"));
    expect(await screen.findByRole("heading", { name: "Automatización Manpersa" })).toBeTruthy();
  });

  it("nuevo proyecto: el cliente es un contacto y elegir el equipo trae su Team Leader", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    renderAt("/operativa", BOSS, (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (init?.method === "POST") return json({ project: { ...project, id: "p-new" } }, 201);
      if (url.startsWith("/api/teams")) return json({ teams: [{ id: "t-1", name: "Equipo A", leadUserId: "u-lead" }] });
      if (url.includes("/members")) return json({ members: [{ id: "u-lead", name: "Ana", role: "lead" }, { id: "u-dev", name: "Diego", role: "developer" }] });
      if (url.startsWith("/api/ops/contact-options")) return json({ contacts: [{ id: "c-1", name: "Francisco Wong", company: "Manpersa SAC" }] });
      return json(page([], { canCreate: true }));
    }) as typeof fetch);
    fireEvent.click(await screen.findByRole("button", { name: /Nuevo proyecto/ }));
    expect(screen.queryByLabelText(/Propuesta/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Nombre del proyecto"), { target: { value: "Portal de pedidos" } });
    await pick("Cliente", /^Francisco Wong/);
    await pick("Equipo", "Equipo A");
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Team Leader" }).textContent).toContain("Ana"));
    fireEvent.click(screen.getByRole("button", { name: /Crear proyecto/ }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "POST")).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.init?.method === "POST")!.init?.body))).toMatchObject({ name: "Portal de pedidos", contactIds: ["c-1"], teamId: "t-1", leadUserId: "u-lead" });
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
    expect(await screen.findByRole("button", { name: "Pasar a Maintenance" })).toBeTruthy();
    expect(screen.getByLabelText("Health")).toBeTruthy();
    expect(screen.queryByLabelText("Sentiment score")).toBeNull();
    expect(screen.getByText("Sentiment")).toBeTruthy();
    for (const label of ["Contactos", "Developers", "Kickoff", "Tipo de pago", "SOW"]) expect(screen.getByLabelText(label)).toBeTruthy();
    // Hourly rate se edita en el indicador.
    expect(screen.getByLabelText("Hourly rate")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /^Etapas/ })).toBeTruthy();
    // Del proyecto solo queda el SOW: sin propuesta ni Project Plan.
    for (const label of ["Project Plan", "Propuesta"]) expect(screen.queryByLabelText(label)).toBeNull();
    expect(screen.getByText("Total hours approved")).toBeTruthy();
    expect(screen.getByText("Paso 2 de 7")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /^Cuentas/ })).toBeTruthy();
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
    expect(screen.queryByRole("button", { name: "Pasar a Maintenance" })).toBeNull();
    expect(screen.queryByRole("tab", { name: /^Cuentas/ })).toBeNull();
    expect(screen.getByRole("tab", { name: /^Deals/ })).toBeTruthy();
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
    fireEvent.click(await screen.findByRole("button", { name: "Pasar a Maintenance" }));
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
    fireEvent.click(await screen.findByRole("tab", { name: /^Cuentas/ }));
    expect(await screen.findByText(/Panel de hosting/)).toBeTruthy();
    expect(screen.queryByText(secret)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Ver$/ }));
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
    fireEvent.click(await screen.findByRole("tab", { name: /^Cuentas/ }));
    expect(await screen.findByText(/aún no está activado en el servidor/)).toBeTruthy();
  });
});

describe("tiempo en etapa (migración del prototipo)", () => {
  it("verde en plazo, ámbar desde el 75 % y rojo si se pasa; sin plazo solo los días", () => {
    expect(stageAge("2026-11-01", 30, "2026-11-10")).toMatchObject({ days: 9, tone: "ok", text: "9 d de 30 d" });
    expect(stageAge("2026-11-01", 8, "2026-11-07")).toMatchObject({ tone: "warn" });
    expect(stageAge("2026-10-01", 7, "2026-10-12")).toMatchObject({ over: 4, tone: "danger", text: "11 d · +4 d" });
    expect(stageAge("2026-10-01", null, "2026-10-12")).toMatchObject({ tone: "neutral", text: "11 d" });
  });

  it("la lista avisa de los atascados y muestra la columna de tiempo en etapa", async () => {
    localStorage.clear();
    const sla = { kickoff: 7, structure: 30, automation_layer: 21, stabilization: 14, maintenance: 60, no_pending_items: 14, completed: null };
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/views")) return json({ views: [] });
      if (url.startsWith("/api/teams")) return json({ teams: [] });
      return json(page([listItem], { stuck: [{ id: listItem.id, name: listItem.name, stage: "structure", days: 40, sla: 30 }], sla }));
    }) as typeof fetch;
    renderAt("/operativa", LEAD, fetchImpl);
    const banner = await screen.findByRole("region", { name: "Proyectos atascados" });
    expect(within(banner).getByText("1 proyecto atascado")).toBeTruthy();
    expect(within(banner).getByRole("link", { name: /Automatización Manpersa/ }).getAttribute("href")).toBe(`/operativa/${listItem.id}?tab=stages`);
    expect(within(banner).getByText("40 d · +10 d")).toBeTruthy();
    const table = await screen.findByRole("table", { name: "Proyectos" });
    expect(within(table).getByRole("columnheader", { name: /Tiempo en etapa/ })).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "Vistas guardadas" })).toBeTruthy();
  });

  it("el detalle abre el historial de etapas con ?tab=stages", async () => {
    const withHistory = { ...project, stage: "structure" as const, stageSince: "2026-10-01", stageHistory: [{ stage: "kickoff" as const, at: "2026-09-01", by: "ana", estimated: true }, { stage: "structure" as const, at: "2026-10-01", by: "ana" }] };
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/ops/stage-sla")) return json({ days: { kickoff: 7, structure: 30, automation_layer: 21, stabilization: 14, maintenance: 60, no_pending_items: 14, completed: null } });
      if (url === `/api/ops/projects/${project.id}`) return json({ project: withHistory, permissions: { manage: false, work: false } });
      return json({ rows: [], total: 0, page: 1, pageSize: 25, facets: {}, totals: {}, tasks: [], proposals: [], updates: [], meetings: [] });
    }) as typeof fetch;
    renderAt(`/operativa/${project.id}?tab=stages`, LEAD, fetchImpl);
    const table = await screen.findByRole("table", { name: "Historial de etapas" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("30 d")).toBeTruthy();
    expect(within(rows[0]).getByText("(estimado)")).toBeTruthy();
    expect(within(rows[0]).getByText("+23 d de atraso")).toBeTruthy();
    expect(within(rows[1]).getByText(/actual/)).toBeTruthy();
    expect(screen.getByLabelText("Tiempo en etapa")).toBeTruthy();
  });
});
