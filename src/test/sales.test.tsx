import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AppSidebar from "@/components/layout/AppSidebar";
import type { SessionUser } from "@/features/auth/auth";
import OpsProjectDetailPage from "@/features/ops/OpsProjectDetailPage";
import type { OpsProject } from "@/features/ops/api";
import LeadDetailPage from "@/features/sales/LeadDetailPage";
import LeadsPage from "@/features/sales/LeadsPage";
import SourcesPage from "@/features/sales/SourcesPage";
import type { Lead, LeadDetail, LeadSource } from "@/features/sales/api";
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
  source: { id: "s1", name: "Meta Ads" },
  setter: { id: "u-com", name: "Marta" },
  closer: null,
  funnel: "upwork",
  temperature: "hot",
  submittedAt: "2026-10-20",
  meetingAt: "2026-10-23",
  responseDays: 3,
  proposalUrl: null,
  contactRef: null,
  companyRef: null,
  deal: null,
  lostReason: null,
  customerId: null,
  companyId: null,
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
      <MemoryRouter initialEntries={[path]}>
        <AppSidebar />
        <Routes>
          <Route path="/comercial" element={<LeadsPage />} />
          <Route path="/comercial/leads/:id" element={<LeadDetailPage />} />
          <Route path="/comercial/sources" element={<SourcesPage />} />
          <Route path="/operativa/:id" element={<OpsProjectDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { calls, queryClient };
}

describe("menú de Comercial", () => {
  it("Comercial ve sus enlaces y no Infraestructura", () => {
    renderAt("/comercial", COMMERCIAL, () => json({ rows: [], total: 0, page: 1, pageSize: 25, facets: {}, totals: {}, counts: {}, canWrite: true, sources: [] }));
    const nav = within(screen.getByRole("navigation", { name: "Áreas" }));
    expect(nav.getByRole("link", { name: /^Leads$/ })).toBeTruthy();
    for (const name of [/Actividades/, /Demos/, /Propuestas/, /Partners/, /Catálogo/, /Reuniones por asignar/]) expect(nav.getByRole("link", { name })).toBeTruthy();
    expect(nav.getByRole("link", { name: /Sources de leads/ })).toBeTruthy();
    for (const name of [/Contactos/, /Empresas/]) expect(nav.getByRole("link", { name })).toBeTruthy();
    expect(nav.queryByText("Infraestructura")).toBeNull();
  });
});

describe("leads", () => {
  const listed: Lead = { ...lead };
  const counts = { new: 3, contacted: 1, demo: 1, proposal_sent: 0, won: 2, lost: 0, nurturing: 4, unqualified: 0 };
  const page = (extra: Record<string, unknown> = {}) => ({ rows: [listed], total: 1, page: 1, pageSize: 25, facets: { demo: 1 }, totals: {}, counts, canWrite: true, ...extra });
  const route = (url: string) => (url.startsWith("/api/sales/sources") ? json({ sources: [] }) : url.startsWith("/api/sales/owners") ? json({ owners: [{ id: "u-com", name: "Marta", role: "commercial" }] }) : json(page()));

  it("tabla de leads: funnel, temperatura, Setter, días de respuesta; el embudo filtra por estado", async () => {
    const { calls } = renderAt("/comercial", COMMERCIAL, route);
    const table = await screen.findByRole("table", { name: "Leads" });
    const row = within(within(table).getByText("Manpersa SAC").closest("tr")!);
    expect(row.getByText("Meta Ads")).toBeTruthy();
    expect(row.getByText("Upwork")).toBeTruthy();
    expect(row.getByText("3 d")).toBeTruthy();
    expect((row.getByLabelText("Temperatura de Manpersa SAC") as HTMLSelectElement).value).toBe("hot");
    const funnel = within(screen.getByRole("group", { name: "Embudo" }));
    fireEvent.click(funnel.getByRole("button", { name: /Ganado/ }));
    await waitFor(() => expect(calls.some((c) => c.url.includes("status=won"))).toBe(true));
  });

  it("vista de leads fríos: el embudo muestra solo sus estados y la vista va a la API", async () => {
    const { calls } = renderAt("/comercial", COMMERCIAL, route);
    fireEvent.click(await screen.findByRole("tab", { name: "Fríos" }));
    await waitFor(() => expect(calls.some((c) => c.url.includes("view=cold"))).toBe(true));
    const funnel = within(screen.getByRole("group", { name: "Embudo" }));
    expect(funnel.getAllByRole("button").map((b) => b.textContent?.replace(/\d+$/, ""))).toEqual(["Nurturing", "No calificado", "Perdido"]);
  });

  it("editar el Closer en la celda guarda solo ese campo", async () => {
    const { calls } = renderAt("/comercial", COMMERCIAL, (url, init) => (init?.method === "PATCH" ? json({ lead }) : route(url)));
    const select = await screen.findByLabelText("Closer de Manpersa SAC");
    await waitFor(() => expect(within(select).getAllByRole("option").length).toBe(2));
    fireEvent.change(select, { target: { value: "u-com" } });
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PATCH")).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.init?.method === "PATCH")!.init?.body))).toEqual({ closerUserId: "u-com" });
  });

  it("Financiera ve los leads en lectura: sin crear ni editar", async () => {
    const FINANCE: SessionUser = { id: "u-fin", username: "fede", name: "Fede", role: "finance", teamId: null, mustChangeCredentials: false };
    renderAt("/comercial", FINANCE, (url) => (url.startsWith("/api/sales/sources") ? json({ error: "No" }, 403) : json(page({ canWrite: false }))));
    await screen.findByRole("table", { name: "Leads" });
    expect(screen.queryByRole("button", { name: /Nuevo lead/ })).toBeNull();
    expect(screen.queryByLabelText("Estado de Manpersa SAC")).toBeNull();
  });

  it("detalle: datos del source tal cual, y sin propuestas no se puede convertir", async () => {
    renderAt(`/comercial/leads/${lead.id}`, COMMERCIAL, (url) => {
      if (url === `/api/sales/leads/${lead.id}`) return json({ lead, demos: [], proposals: [], company: null, project: null, deal: null, canWrite: true });
      if (url.startsWith("/api/teams")) return json({ teams: [] });
      return json({ owners: [], meetings: [], updates: [], processingAvailable: true });
    });
    expect(await screen.findByRole("heading", { name: "Manpersa SAC" })).toBeTruthy();
    expect(screen.getByText(/Primero registra la propuesta/)).toBeTruthy();
    // "Ganado" no se puede elegir a mano.
    expect(within(screen.getByLabelText("Estado del lead")).queryByRole("option", { name: "Ganado" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Datos del source" }));
    expect(screen.getByText("form.campaign")).toBeTruthy();
    expect(screen.getByText("octubre")).toBeTruthy();
  });

  it("convertir pregunta antes de crear; si se cancela no envía nada", async () => {
    const proposal = { id: "22222222-2222-4222-8222-222222222222", leadId: lead.id, projectId: null, dealId: null, title: "Propuesta Manpersa", url: "https://p.example.com/", amountCents: null, currency: "USD", status: "accepted", area: "commercial", sentAt: null, decidedAt: null, createdAt: "2026-10-27T10:00:00Z" };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { calls } = renderAt(`/comercial/leads/${lead.id}`, COMMERCIAL, (url) => {
      if (url === `/api/sales/leads/${lead.id}`) return json({ lead, demos: [], proposals: [proposal], company: null, project: null, deal: null, canWrite: true });
      if (url.startsWith("/api/teams")) return json({ teams: [{ id: "t-1", name: "Equipo A" }] });
      return json({ owners: [], members: [], meetings: [], updates: [], processingAvailable: true });
    });
    await screen.findByRole("option", { name: "Equipo A" });
    fireEvent.change(screen.getByLabelText("Equipo"), { target: { value: "t-1" } });
    fireEvent.click(screen.getByRole("button", { name: /Convertir en cliente/ }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(String(confirm.mock.calls[0][0])).toMatch(/empresa «Manpersa SAC».*\n.*proyecto «Proyecto Manpersa SAC» en Kick Off[\s\S]*deal aprobado/);
    expect(calls.some((c) => c.url.endsWith("/convert"))).toBe(false);
    confirm.mockRestore();
  });

  it("convertir envía equipo, proyecto y propuesta, y abre el proyecto en Operativa", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const proposal = { id: "22222222-2222-4222-8222-222222222222", leadId: lead.id, projectId: null, dealId: null, title: "Propuesta Manpersa", url: "https://p.example.com/", amountCents: null, currency: "USD", status: "accepted", area: "commercial", sentAt: null, decidedAt: null, createdAt: "2026-10-27T10:00:00Z" };
    const { calls } = renderAt(`/comercial/leads/${lead.id}`, COMMERCIAL, (url, init) => {
      if (url.endsWith("/convert") && init?.method === "POST") return json({ company: { id: "c1", name: "Manpersa SAC" }, project: { id: "p1", name: "Proyecto Manpersa SAC" }, deal: { id: "d1", dealCode: "DL-0001" } }, 201);
      if (url === `/api/sales/leads/${lead.id}`) return json({ lead, demos: [], proposals: [proposal], company: null, project: null, deal: null, canWrite: true });
      if (url.startsWith("/api/teams")) return json({ teams: [{ id: "t-1", name: "Equipo A" }] });
      if (url.startsWith("/api/ops/members")) return json({ members: [{ id: "u-lead", name: "Ana", role: "lead" }] });
      if (url.startsWith("/api/ops/projects/p1")) return json({ error: "x" }, 404);
      return json({ owners: [], meetings: [], updates: [], processingAvailable: true });
    });
    await screen.findByRole("option", { name: "Equipo A" });
    fireEvent.change(screen.getByLabelText("Equipo"), { target: { value: "t-1" } });
    fireEvent.click(screen.getByRole("button", { name: /Convertir en cliente/ }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/convert"))).toBe(true));
    const body = JSON.parse(String(calls.find((c) => c.url.endsWith("/convert"))!.init?.body));
    expect(body).toMatchObject({ teamId: "t-1", projectName: "Proyecto Manpersa SAC", proposalId: proposal.id });
    confirm.mockRestore();
  });
});

describe("sources", () => {
  const source: LeadSource = { id: "s1", name: "Meta Ads", kind: "webhook", keyHint: "a1b2", hasKey: true, mapping: [], active: true, received: 4, lastReceivedAt: null, sampleKeys: ["form.email"], ingestPath: "/api/ingest/leads/s1" };

  it("la clave se muestra una vez al crear y no queda en la caché de consultas", async () => {
    const ingestKey = "lpk_SECRETO-de-prueba-123456";
    const { queryClient } = renderAt("/comercial/sources", COMMERCIAL, (url, init) => {
      if (url === "/api/sales/sources" && init?.method === "POST") return json({ source, ingestKey }, 201);
      return json({ sources: [source] });
    });
    expect(await screen.findByText(/terminada en …a1b2/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Meta Ads" } });
    fireEvent.click(screen.getByRole("button", { name: /Crear source/ }));
    expect(await screen.findByText(ingestKey)).toBeTruthy();
    expect(JSON.stringify(queryClient.getQueryCache().getAll().map((q) => q.state.data))).not.toContain(ingestKey);
    fireEvent.click(screen.getByRole("button", { name: "Ya la guardé" }));
    await waitFor(() => expect(screen.queryByText(ingestKey)).toBeNull());
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
    company: null,
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
    await waitFor(() => expect(screen.getAllByLabelText(/Deal del change order/).length).toBe(2));
    fireEvent.change(screen.getAllByLabelText(/Deal del change order/)[1], { target: { value: "d1" } });
    fireEvent.click(changeOrder);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/action-items/a2/convert"))).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith("/a2/convert"))!.init?.body))).toEqual({ to: "change_order", dealId: "d1" });

    fireEvent.change(screen.getByLabelText("Estado de proceso de «Revisión semanal»"), { target: { value: "reviewed" } });
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PATCH" && c.url.endsWith("/meetings/m1"))).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.init?.method === "PATCH")!.init?.body))).toEqual({ reviewStatus: "reviewed" });
    expect(calls.some((c) => c.init?.method === "PATCH" && c.url === `/api/ops/projects/${project.id}`)).toBe(false);
  });
});
