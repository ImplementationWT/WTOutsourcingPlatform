import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfirmProvider } from "@/components/ui/confirm-provider";
import { Toaster } from "@/components/ui/toaster";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AppSidebar from "@/components/layout/AppSidebar";
import type { SessionUser } from "@/features/auth/auth";
import OpsProjectsPage from "@/features/ops/OpsProjectsPage";
import type { OpsProject } from "@/features/ops/api";
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
  country: null,
  corporateEmail: null,
  website: null,
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
          <Route path="/comercial/leads/:id" element={<LeadsPage />} />
          <Route path="/operativa/:id" element={<OpsProjectsPage />} />
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
    for (const name of [/Propuestas/, /Contactos/, /^Meetings$/]) expect(nav.getByRole("link", { name })).toBeTruthy();
    for (const name of [/^Actividades$/, /^Demos$/, /Partners/, /Catálogo/, /Reuniones por asignar/, /Sources de leads/, /Empresas/]) expect(nav.queryByRole("link", { name })).toBeNull();
    expect(nav.queryByText("Infraestructura")).toBeNull();
    expect(nav.queryByRole("link", { name: /^Deals$/ })).toBeNull();
  });
});

describe("leads", () => {
  const listed: Lead = { ...lead };
  const counts = { new: 3, contacted: 1, demo: 1, proposal_sent: 0, won: 2, lost: 0, nurturing: 4, unqualified: 0 };
  const page = (extra: Record<string, unknown> = {}) => ({ rows: [listed], total: 1, page: 1, pageSize: 25, facets: { demo: 1 }, totals: {}, counts, canWrite: true, ...extra });
  const route = (url: string) =>
    url.startsWith("/api/sales/owners")
      ? json({ owners: [{ id: "u-com", name: "Marta", role: "commercial" }] })
      : url === `/api/sales/leads/${lead.id}`
        ? json({ lead, demos: [], proposals: [], project: null, deals: [], pendingActivities: 0, canWrite: true })
        : url.startsWith("/api/sales/leads")
          ? json(page())
          : json({ meetings: [], updates: [], rows: [], total: 0, page: 1, pageSize: 25, facets: {}, totals: {} });

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

  it("agrupa por estado con grupos plegables, las columnas del prototipo y un clic en la fila abre el detalle", async () => {
    localStorage.clear();
    renderAt("/comercial", COMMERCIAL, route);
    const table = await screen.findByRole("table", { name: "Leads" });
    expect(within(table.querySelector("thead")!).getAllByRole("columnheader").map((h) => h.textContent?.trim())).toEqual(["Lead", "Estado", "Temp.", "Funnel", "Closer", "Submission"]);
    expect(screen.queryByRole("button", { name: "Columnas" })).toBeNull();
    // Las pestañas son Todos y los siete estados del prototipo.
    expect(within(screen.getByRole("group", { name: "Embudo" })).getAllByRole("button").map((b) => b.textContent?.replace(/[\d–]+/g, "").trim())).toEqual(["Todos", "Nuevo", "Contactado", "Demo", "Propuesta enviada", "Ganado", "Perdido", "Ghosted"]);
    expect(within(table).getByText("1 lead")).toBeTruthy();
    fireEvent.click(within(table).getByRole("button", { name: "Plegar Demo" }));
    expect(within(table).queryByText("Upwork")).toBeNull();
    fireEvent.click(within(table).getByRole("button", { name: "Desplegar Demo" }));
    fireEvent.click(within(table).getByText("Upwork"));
    const dialog = within(await screen.findByRole("dialog"));
    expect(await dialog.findByRole("heading", { name: "Manpersa SAC" })).toBeTruthy();
    expect(dialog.getAllByRole("tab").map((t) => t.textContent?.replace(/\d+/g, "").trim())).toEqual(["Información", "Actividades", "Reuniones", "Propuestas", "Comunicaciones"]);
    expect(dialog.getByRole("region", { name: "Updates" })).toBeTruthy();
  });

  it("«Filtros» tiene Funnel y Temperatura: van a la API y quedan como chip que se puede quitar", async () => {
    const { calls } = renderAt("/comercial", COMMERCIAL, route);
    fireEvent.click(await screen.findByRole("button", { name: /^Filtros/ }));
    expect(screen.queryByRole("combobox", { name: "Filtrar por vista" })).toBeNull();
    await pick("Filtrar por funnel", "LHT");
    await waitFor(() => expect(calls.some((c) => c.url.includes("funnel=lht"))).toBe(true));
    expect(screen.getByRole("button", { name: /^Filtros · 1/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Quitar filtro Funnel" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Quitar filtro Funnel" })).toBeNull());
  });

  it("«Nuevo lead» pide la empresa y crea el lead en Nuevo, Warm, LHT y Manual, sin Setter ni Closer", async () => {
    const { calls } = renderAt("/comercial", COMMERCIAL, (url, init) => (init?.method === "POST" ? json({ lead }, 201) : route(url)));
    fireEvent.click(await screen.findByRole("button", { name: /Nuevo lead/ }));
    const panel = within(await screen.findByRole("dialog", { name: "Nuevo lead" }));
    expect((panel.getByRole("button", { name: "Crear lead" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(panel.getByLabelText("Empresa"), { target: { value: "Andina SAC" } });
    fireEvent.click(panel.getByRole("button", { name: "Crear lead" }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "POST" && c.url === "/api/sales/leads")).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.init?.method === "POST")!.init?.body))).toEqual({ company: "Andina SAC", contactName: "", email: null, phone: null, temperature: "warm", funnel: "lht", source: "Manual", setterUserId: null, closerUserId: null });
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

  it("detalle: respuesta y pendientes, «Ganado» se elige a mano, sin «Convertir en cliente», y las respuestas del formulario tal cual", async () => {
    renderAt(`/comercial/leads/${lead.id}`, COMMERCIAL, detailRoute());
    expect(await screen.findByRole("heading", { name: "Manpersa SAC" })).toBeTruthy();
    expect(screen.getByText("Upwork")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Actividades/ }).textContent).toContain("2");
    expect(screen.queryByRole("button", { name: /Convertir en cliente/ })).toBeNull();
    expect(await optionLabels("Estado del lead")).toContain("Ganado");
    expect(screen.getByRole("heading", { name: "Respuestas del formulario" })).toBeTruthy();
    // La clave del source se muestra legible («form.campaign» → Campaign) con su respuesta.
    expect(screen.getByTitle("form.campaign").textContent).toBe("Campaign");
    expect(screen.getByText("octubre")).toBeTruthy();
  });

  it("se edita en el lugar: guarda el cambio y «Deshacer» vuelve al valor anterior", async () => {
    const { calls } = renderAt(`/comercial/leads/${lead.id}`, COMMERCIAL, detailRoute());
    await screen.findByRole("heading", { name: "Manpersa SAC" });
    await pick("Temperatura", "Warm");
    await waitFor(() => expect(patches(calls)).toEqual([{ temperature: "warm" }]));
    fireEvent.click(await screen.findByRole("button", { name: "Deshacer" }));
    await waitFor(() => expect(patches(calls)).toEqual([{ temperature: "warm" }, { temperature: "hot" }]));
  });

  it("Funnel y Submission son de solo lectura; el correo tiene su botón de copiar", async () => {
    renderAt(`/comercial/leads/${lead.id}`, COMMERCIAL, detailRoute());
    await screen.findByRole("heading", { name: "Manpersa SAC" });
    expect(screen.queryByRole("combobox", { name: "Funnel" })).toBeNull();
    expect(screen.getByText("20 oct. 2026")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copiar Correo" })).toBeTruthy();
  });

  it("sin «Crear deal» en el detalle; Updates solo muestra notas del equipo, no los registros automáticos", async () => {
    renderAt(`/comercial/leads/${lead.id}`, COMMERCIAL, (url, init) =>
      url === `/api/sales/leads/${lead.id}/updates`
        ? json({ updates: [{ id: "u1", kind: "system", body: "Estado: Nuevo → Demo", authorName: "Marta", createdAt: "2026-11-01T10:00:00Z" }, { id: "u2", kind: "manual", body: "Pidió la demo para el jueves", authorName: "Marta", createdAt: "2026-11-02T10:00:00Z" }] })
        : detailRoute()(url, init),
    );
    await screen.findByRole("heading", { name: "Manpersa SAC" });
    expect(screen.queryByRole("button", { name: /Crear deal/ })).toBeNull();
    const updates = within(screen.getByRole("region", { name: "Updates" }));
    expect(await updates.findByText("Pidió la demo para el jueves")).toBeTruthy();
    expect(updates.queryByText("Estado: Nuevo → Demo")).toBeNull();
  });

  it("Empresa y Contacto permiten agregar uno nuevo: la empresa queda en el lead y el contacto se crea y se enlaza", async () => {
    const { calls } = renderAt(`/comercial/leads/${lead.id}`, COMMERCIAL, (url, init) =>
      init?.method === "POST" && url === "/api/contacts" ? json({ contact: { id: "c-9", name: "Lucía Pérez" } }, 201) : detailRoute()(url, init),
    );
    await screen.findByRole("heading", { name: "Manpersa SAC" });
    await pick("Empresa", "+ Agregar empresa nueva");
    const company = within(await screen.findByRole("dialog", { name: "Agregar empresa nueva" }));
    fireEvent.change(company.getByLabelText("Nombre de la empresa"), { target: { value: "Andina SAC" } });
    fireEvent.click(company.getByRole("button", { name: "Agregar empresa" }));
    await waitFor(() => expect(patches(calls)).toContainEqual({ company: "Andina SAC" }));
    await pick("Contacto", "+ Agregar contacto nuevo");
    const contact = within(await screen.findByRole("dialog", { name: "Agregar contacto nuevo" }));
    fireEvent.change(contact.getByLabelText("Nombre"), { target: { value: "Lucía Pérez" } });
    fireEvent.click(contact.getByRole("button", { name: "Agregar contacto" }));
    await waitFor(() => expect(patches(calls)).toContainEqual({ contactId: "c-9", contactName: "Lucía Pérez" }));
    expect(JSON.parse(String(calls.find((c) => c.init?.method === "POST" && c.url === "/api/contacts")!.init?.body))).toMatchObject({ name: "Lucía Pérez", company: "Manpersa SAC" });
  });

  it("País es una lista de países; el teléfono tiene prefijo aparte; Empresa y Contacto no ofrecen quedar vacíos", async () => {
    const { calls } = renderAt(`/comercial/leads/${lead.id}`, COMMERCIAL, detailRoute());
    await screen.findByRole("heading", { name: "Manpersa SAC" });
    expect(await optionLabels("Empresa")).not.toContain("Sin empresa");
    expect(await optionLabels("Contacto")).not.toContain("Sin contacto");
    await pick("País", "Perú");
    await waitFor(() => expect(patches(calls)).toContainEqual({ country: "Perú" }));
    const number = screen.getByLabelText("Número de teléfono");
    fireEvent.change(number, { target: { value: "987 654 321" } });
    fireEvent.blur(number);
    await waitFor(() => expect(patches(calls).some((p) => typeof p.phone === "string" && p.phone.endsWith("987 654 321"))).toBe(true));
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
    developers: [],
    stageSince: "2026-11-01",
    stageHistory: [],
    contacts: [],
    clientSlug: null,
    client: null,
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
  const dealRow = { id: "d1", dealCode: "DL-0001", title: "Reportes", contacts: [], owner: null, project: null, lead: null, status: "draft", salesStage: "new_deal", hours: 0, rateCents: 0, amountCents: 0, currency: "USD", updatedAt: "2026-10-01T00:00:00Z" };
  const route = (calls: Call[]) => (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && url.includes("/convert")) return json({ created: { id: "x", label: "tarea" }, meeting }, 201);
    if (init?.method === "PATCH") return json({ meeting });
    if (url === `/api/ops/projects/${project.id}`) return json({ project, permissions: { manage: true, work: true } });
    if (url.endsWith("/meetings")) return json({ meetings: [meeting], processingAvailable: true, conversions: ["task", "change_order"] });
    if (url.startsWith("/api/deals")) return json({ rows: [dealRow], total: 1, page: 1, pageSize: 100, facets: {}, totals: {} });
    void calls;
    return json({ members: [], rows: [], tasks: [], updates: [] });
  };

  it("la pestaña Reuniones del proyecto es el tablero de Meetings del proyecto, sin la sección de action items de Claude", async () => {
    const holder: Call[] = [];
    renderAt(`/operativa/${project.id}`, LEAD, (url, init) =>
      url.startsWith("/api/meetings?") ? json({ rows: [{ id: "m1", title: "Revisión semanal", heldAt: "2026-11-02T15:00:00Z", durationMinutes: 30, source: "read_ai", status: "processed", engagement: null, team: null, lead: null, project: { id: project.id, name: project.name } }], total: 1, page: 1, pageSize: 100, facets: {}, totals: {} }) : route(holder)(url, init),
    );
    fireEvent.click(await screen.findByRole("tab", { name: /^Reuniones/ }));
    expect(await screen.findByText(/Reuniones de este proyecto/)).toBeTruthy();
    expect(screen.getByText("Revisión semanal")).toBeTruthy();
    expect(screen.queryByText(/Action items de las reuniones/)).toBeNull();
  });
});
