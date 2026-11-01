import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfirmProvider } from "@/components/ui/confirm-provider";
import { Toaster } from "@/components/ui/toaster";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AppSidebar from "@/components/layout/AppSidebar";
import type { SessionUser } from "@/features/auth/auth";
import OpsProjectDetailPage from "@/features/ops/OpsProjectDetailPage";
import type { OpsProject } from "@/features/ops/api";
import LeadDetailPage from "@/features/sales/LeadDetailPage";
import LeadsPage from "@/features/sales/LeadsPage";
import type { Lead, LeadDetail } from "@/features/sales/api";
import { optionLabels, pick } from "./pick";
import { LEAD } from "./session";

const COMMERCIAL: SessionUser = { id: "u-com", username: "marta", name: "Marta", role: "commercial", teamId: null, mustChangeCredentials: false };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; init?: RequestInit };

const lead: LeadDetail = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Manpersa SAC",
  company: "Manpersa SAC",
  contactName: "Francisco Wong",
  email: "francisco@manpersa.pe",
  phone: null,
  notes: "",
  status: "demo",
  source: "Meta Ads",
  setter: { id: "u-com", name: "Marta" },
  closer: null,
  funnel: "upwork",
  temperature: "hot",
  submittedAt: "2026-10-20",
  meetingAt: "2026-10-23",
  responseDays: 3,
  proposalUrl: null,
  contactRef: null,
  deal: null,
  lostReason: null,
  contactId: null,
  dealId: null,
  projectId: null,
  createdAt: "2026-10-20T10:00:00Z",
  updatedAt: "2026-10-28T10:00:00Z",
  fields: [
    { key: "form.campaign", value: "octubre" },
    { key: "answers.0.value", value: "5000" },
  ],
  rawJson: '{"form":{"campaign":"octubre"}}',
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
      <Toaster>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[path]}>
        <AppSidebar />
        <Routes>
          <Route path="/comercial" element={<LeadsPage />} />
          <Route path="/comercial/leads/:id" element={<LeadDetailPage />} />
          <Route path="/operativa/:id" element={<OpsProjectDetailPage />} />
          <Route path="/deals/:id" element={<p>Deal abierto</p>} />
        </Routes>
      </MemoryRouter>
      </ConfirmProvider>
      </Toaster>
    </QueryClientProvider>,
  );
  return { calls, queryClient };
}

describe("menú de Comercial", () => {
  it("Comercial ve sus enlaces y no Infraestructura", () => {
    renderAt("/comercial", COMMERCIAL, () => json({ rows: [], total: 0, page: 1, pageSize: 25, facets: {}, totals: {}, counts: {}, canWrite: true, sources: [] }));
    const nav = within(screen.getByRole("navigation", { name: "Áreas" }));
    expect(nav.getByRole("link", { name: /^Leads$/ })).toBeTruthy();
    for (const name of [/Actividades/, /Demos/, /Propuestas/, /Contactos/, /^Deals$/, /^Meetings$/]) expect(nav.getByRole("link", { name })).toBeTruthy();
    for (const name of [/Partners/, /Catálogo/, /Reuniones por asignar/, /Sources de leads/, /Empresas/]) expect(nav.queryByRole("link", { name })).toBeNull();
    expect(nav.queryByText("Infraestructura")).toBeNull();
  });
});

describe("leads", () => {
  const listed: Lead = { ...lead };
  const counts = { new: 3, contacted: 1, demo: 1, proposal_sent: 0, won: 2, lost: 0, nurturing: 4, unqualified: 0 };
  const page = (extra: Record<string, unknown> = {}) => ({ rows: [listed], total: 1, page: 1, pageSize: 25, facets: { demo: 1 }, totals: {}, counts, canWrite: true, ...extra });
  const route = (url: string) => (url.startsWith("/api/sales/owners") ? json({ owners: [{ id: "u-com", name: "Marta", role: "commercial" }] }) : json(page()));

  it("tabla de leads: funnel y temperatura a la vista; las píldoras del embudo cuentan y filtran por estado", async () => {
    localStorage.clear();
    const { calls } = renderAt("/comercial", COMMERCIAL, route);
    const table = await screen.findByRole("table", { name: "Leads" });
    const row = within(within(table).getByText("Manpersa SAC").closest("tr")!);
    expect(row.getByText("Upwork")).toBeTruthy();
    expect(row.getByRole("combobox", { name: "Temperatura de Manpersa SAC" }).textContent).toContain("Hot");
    const funnel = within(screen.getByRole("group", { name: "Embudo" }));
    expect(funnel.getByRole("button", { name: /Todos/ }).textContent).toContain("11");
    fireEvent.click(funnel.getByRole("button", { name: /Ganado/ }));
    await waitFor(() => expect(calls.some((c) => c.url.includes("status=won"))).toBe(true));
  });

  it("«Columnas» muestra las ocultas (origen, respuesta) y un clic en la fila abre la vista rápida", async () => {
    localStorage.clear();
    renderAt("/comercial", COMMERCIAL, route);
    const table = await screen.findByRole("table", { name: "Leads" });
    expect(within(table).queryByText("Meta Ads")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Columnas" }));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Origen" }));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Respuesta" }));
    await waitFor(() => expect(within(table).getByText("Meta Ads")).toBeTruthy());
    expect(within(table).getByText("3 d")).toBeTruthy();
    fireEvent.click(within(table).getByText("Upwork"));
    const open = await screen.findByRole("link", { name: "Abrir completo" });
    expect(open.getAttribute("href")).toBe(`/comercial/leads/${lead.id}`);
  });

  it("filtros en el panel «Filtros»: la vista va a la API y queda como chip que se puede quitar", async () => {
    const { calls } = renderAt("/comercial", COMMERCIAL, route);
    fireEvent.click(await screen.findByRole("button", { name: /^Filtros/ }));
    await pick("Filtrar por vista", "Fríos");
    await waitFor(() => expect(calls.some((c) => c.url.includes("view=cold"))).toBe(true));
    expect(screen.getByRole("button", { name: /^Filtros · 1/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Quitar filtro Vista" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Quitar filtro Vista" })).toBeNull());
  });

  it("editar el Closer en la celda guarda solo ese campo", async () => {
    const { calls } = renderAt("/comercial", COMMERCIAL, (url, init) => (init?.method === "PATCH" ? json({ lead }) : route(url)));
    await waitFor(async () => expect(await optionLabels("Closer de Manpersa SAC")).toEqual(["Sin asignar", "Marta"]));
    await pick("Closer de Manpersa SAC", "Marta");
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PATCH")).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.init?.method === "PATCH")!.init?.body))).toEqual({ closerUserId: "u-com" });
  });

  it("Financiera ve los leads en lectura: sin crear ni editar", async () => {
    const FINANCE: SessionUser = { id: "u-fin", username: "fede", name: "Fede", role: "finance", teamId: null, mustChangeCredentials: false };
    renderAt("/comercial", FINANCE, () => json(page({ canWrite: false })));
    await screen.findByRole("table", { name: "Leads" });
    expect(screen.queryByRole("button", { name: /Nuevo lead/ })).toBeNull();
    expect(screen.queryByLabelText("Estado de Manpersa SAC")).toBeNull();
  });

  const detailRoute = (extra: Record<string, unknown> = {}) => (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") return json({ lead });
    if (init?.method === "POST" && url === "/api/deals") return json({ deal: { id: "d1", dealCode: "DL-0001" } }, 201);
    if (url === `/api/sales/leads/${lead.id}`) return json({ lead, demos: [], proposals: [], project: null, deals: [], pendingActivities: 2, canWrite: true, ...extra });
    if (url.startsWith("/api/sales/owners")) return json({ owners: [{ id: "u-com", name: "Marta", role: "commercial" }] });
    if (url.startsWith("/api/contacts")) return json(page({ rows: [] }));
    return json({ meetings: [], updates: [], processingAvailable: true, rows: [], total: 0, page: 1, pageSize: 25, facets: {}, totals: {} });
  };
  const patches = (calls: Call[]) => calls.filter((c) => c.init?.method === "PATCH").map((c) => JSON.parse(String(c.init?.body)));

  it("detalle: respuesta y pendientes, «Ganado» se elige a mano, sin «Convertir en cliente», y los datos del source tal cual", async () => {
    renderAt(`/comercial/leads/${lead.id}`, COMMERCIAL, detailRoute());
    expect(await screen.findByRole("heading", { name: "Manpersa SAC" })).toBeTruthy();
    expect(screen.getByText("3 d")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Actividades/ }).textContent).toContain("2");
    expect(screen.queryByRole("button", { name: /Convertir en cliente/ })).toBeNull();
    expect(await optionLabels("Estado del lead")).toContain("Ganado");
    fireEvent.click(screen.getByRole("tab", { name: "Datos del source" }));
    expect(screen.getByText("form.campaign")).toBeTruthy();
    expect(screen.getByText("octubre")).toBeTruthy();
  });

  it("se edita en el lugar: guarda al salir del campo y «Deshacer» vuelve al valor anterior", async () => {
    const { calls } = renderAt(`/comercial/leads/${lead.id}`, COMMERCIAL, detailRoute());
    const company = await screen.findByLabelText("Empresa");
    fireEvent.change(company, { target: { value: "Manpersa Perú SAC" } });
    fireEvent.blur(company);
    await waitFor(() => expect(patches(calls)).toEqual([{ company: "Manpersa Perú SAC" }]));
    fireEvent.click(await screen.findByRole("button", { name: "Deshacer" }));
    await waitFor(() => expect(patches(calls)).toEqual([{ company: "Manpersa Perú SAC" }, { company: "Manpersa SAC" }]));
  });

  it("el correo es un enlace mailto con botón de copiar", async () => {
    renderAt(`/comercial/leads/${lead.id}`, COMMERCIAL, detailRoute());
    const mail = await screen.findByRole("link", { name: "francisco@manpersa.pe" });
    expect(mail.getAttribute("href")).toBe("mailto:francisco@manpersa.pe");
    expect(screen.getByRole("button", { name: "Copiar Correo" })).toBeTruthy();
  });

  it("«Crear deal» del encabezado lo liga al lead y lo abre", async () => {
    const { calls } = renderAt(`/comercial/leads/${lead.id}`, COMMERCIAL, detailRoute());
    await screen.findByRole("heading", { name: "Manpersa SAC" });
    fireEvent.click(screen.getAllByRole("button", { name: /Crear deal/ })[0]);
    expect(await screen.findByText("Deal abierto")).toBeTruthy();
    const post = calls.find((c) => c.init?.method === "POST" && c.url === "/api/deals")!;
    expect(JSON.parse(String(post.init?.body))).toMatchObject({ leadId: lead.id, title: "Manpersa SAC" });
  });

  it("Financiera lee el detalle sin controles", async () => {
    const FINANCE: SessionUser = { id: "u-fin", username: "fede", name: "Fede", role: "finance", teamId: null, mustChangeCredentials: false };
    renderAt(`/comercial/leads/${lead.id}`, FINANCE, detailRoute({ canWrite: false }));
    await screen.findByRole("heading", { name: "Manpersa SAC" });
    expect(screen.queryByRole("button", { name: "Más acciones" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Crear deal/ })).toBeNull();
    expect((screen.getByLabelText("Empresa") as HTMLInputElement).disabled).toBe(true);
  });
});

describe("reuniones procesadas en Operativa", () => {
  const project: OpsProject = {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Proyecto Acme",
    customerName: "Acme",
    team: { id: "t-1", name: "Equipo A" },
    lead: null,
    developer: null,
    contacts: [],
    clientSlug: null,
    proposalUrl: null,
    projectPlanUrl: null,
    sowUrl: null,
    kickoffDate: null,
    leadId: null,
    stage: "kickoff",
    health: "neutral",
    sentimentScore: 55,
    priority: "medium",
    paymentType: null,
    nextAction: null,
    summary: { deals: 0, amountCents: 0, soldHours: 0, billableHours: 0, billableVsSold: 0, tasks: 0, tasksDone: 0, progress: 0 },
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-28T10:00:00Z",
  };
  const item = (id: string, text: string, kind: string) => ({ id, text, kind, ownerName: "Ana", owner: null, projectedHours: 6, phase: null, status: "proposed", taskId: null, changeOrderId: null, activityId: null });
  const meeting = {
    id: "m1",
    title: "Revisión semanal",
    heldAt: "2026-10-28T15:00:00Z",
    source: "read_ai",
    kind: "sprint_review",
    durationMinutes: 45,
    url: "https://app.read.ai/analytics/meetings/S1",
    deal: null,
    attendees: [{ id: "c-1", name: "Lucía Pérez" }],
    participants: [{ name: "Lucía Pérez", email: "lucia@acme.pe" }],
    status: "processed",
    reviewStatus: "new",
    summary: "Se revisó el avance.",
    feedback: ["Quieren reportes semanales."],
    actionItems: [item("a1", "Enviar el plan del proyecto", "internal_work"), item("a2", "Agregar exportación", "scope_risk")],
    clientSentiment: "good",
    readAi: { summary: "Resumen de Read.ai.", actionItems: [], topics: [], keyQuestions: [] },
    processingError: null,
    processedAt: "2026-10-28T16:00:00Z",
    transcriptLength: 120,
  };
  const dealRow = { id: "d1", dealCode: "DL-0001", title: "Reportes" };
  const route = (calls: Call[]) => (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && url.includes("/convert")) return json({ created: { id: "x", label: "tarea" }, meeting }, 201);
    if (init?.method === "PATCH") return json({ meeting });
    if (url === `/api/ops/projects/${project.id}`) return json({ project, permissions: { manage: true, work: true } });
    if (url.endsWith("/meetings")) return json({ meetings: [meeting], processingAvailable: true, conversions: ["task", "change_order"] });
    if (url.startsWith("/api/deals")) return json({ rows: [dealRow], total: 1, page: 1, pageSize: 100, facets: {}, totals: {} });
    void calls;
    return json({ members: [], rows: [], tasks: [], updates: [] });
  };

  it("muestra lo que propone Claude (sentimiento, tipo, action items tipados) y el Team Leader los convierte; el Health no cambia", async () => {
    const holder: Call[] = [];
    const { calls } = renderAt(`/operativa/${project.id}`, LEAD, route(holder));
    fireEvent.click(await screen.findByRole("tab", { name: "Reuniones" }));
    expect(await screen.findByText("Quieren reportes semanales.")).toBeTruthy();
    expect(screen.getByText("Bien")).toBeTruthy();
    expect(screen.getByText(/Asistentes: Lucía Pérez/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Read.ai/ }).getAttribute("href")).toBe("https://app.read.ai/analytics/meetings/S1");
    expect(screen.getByText(/Trabajo interno · Ana · 6 h/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Aplicar al proyecto" })).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: /Crear tarea/ })[0]);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/action-items/a1/convert"))).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith("/a1/convert"))!.init?.body))).toEqual({ to: "task" });

    // Sin deal en la reunión, el change order pide elegirlo.
    const changeOrder = screen.getAllByRole("button", { name: /Crear change order/ })[1];
    expect((changeOrder as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(screen.getAllByRole("combobox", { name: /Deal del change order/ }).length).toBe(2));
    await pick(screen.getAllByRole("combobox", { name: /Deal del change order/ })[1], /DL-0001/);
    fireEvent.click(changeOrder);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/action-items/a2/convert"))).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith("/a2/convert"))!.init?.body))).toEqual({ to: "change_order", dealId: "d1" });

    await pick("Estado de proceso de «Revisión semanal»", "Revisada");
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PATCH" && c.url.endsWith("/meetings/m1"))).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.init?.method === "PATCH")!.init?.body))).toEqual({ reviewStatus: "reviewed" });
    expect(calls.some((c) => c.init?.method === "PATCH" && c.url === `/api/ops/projects/${project.id}`)).toBe(false);
  });
});
