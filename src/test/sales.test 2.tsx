import { describe, expect, it } from "vitest";
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
  owner: { id: "u-com", name: "Marta" },
  lostReason: null,
  customerId: null,
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
    renderAt("/comercial", COMMERCIAL, () => json({ leads: [], counts: {}, sources: [] }));
    const nav = within(screen.getByRole("navigation", { name: "Áreas" }));
    expect(nav.getByRole("link", { name: /Leads y propuestas/ })).toBeTruthy();
    expect(nav.getByRole("link", { name: /Sources de leads/ })).toBeTruthy();
    expect(nav.queryByText("Infraestructura")).toBeNull();
  });
});

describe("leads", () => {
  const listed: Lead = { ...lead };
  const counts = { new: 3, contacted: 1, demo: 1, proposal_sent: 0, won: 2, lost: 0 };

  it("muestra el embudo con sus conteos y filtra por estado al hacer clic", async () => {
    const { calls } = renderAt("/comercial", COMMERCIAL, (url) => (url.startsWith("/api/sales/sources") ? json({ sources: [] }) : json({ leads: [listed], counts })));
    const row = within(await screen.findByRole("link", { name: /Manpersa SAC/ }));
    expect(row.getByText("Meta Ads")).toBeTruthy();
    const funnel = within(screen.getByRole("group", { name: "Embudo" }));
    fireEvent.click(funnel.getByRole("button", { name: /Ganado/ }));
    await waitFor(() => expect(calls.some((c) => c.url.includes("status=won"))).toBe(true));
  });

  it("detalle: datos del source tal cual, y sin propuestas no se puede convertir", async () => {
    renderAt(`/comercial/leads/${lead.id}`, COMMERCIAL, (url) => {
      if (url === `/api/sales/leads/${lead.id}`) return json({ lead, demos: [], proposals: [], customer: null, project: null });
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

  it("convertir envía equipo, proyecto y propuesta, y abre el proyecto en Operativa", async () => {
    const proposal = { id: "22222222-2222-4222-8222-222222222222", leadId: lead.id, projectId: null, dealId: null, title: "Propuesta Manpersa", url: "https://p.example.com/", amountCents: null, currency: "USD", status: "accepted", area: "commercial", sentAt: null, decidedAt: null, createdAt: "2026-10-27T10:00:00Z" };
    const { calls } = renderAt(`/comercial/leads/${lead.id}`, COMMERCIAL, (url, init) => {
      if (url.endsWith("/convert") && init?.method === "POST") return json({ customer: { id: "c1", name: "Manpersa SAC" }, project: { id: "p1", name: "Proyecto Manpersa SAC" } }, 201);
      if (url === `/api/sales/leads/${lead.id}`) return json({ lead, demos: [], proposals: [proposal], customer: null, project: null });
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
    clientSlug: null,
    proposalUrl: null,
    customerId: null,
    leadId: null,
    stage: "kickoff",
    health: "neutral",
    sentimentScore: 50,
    priority: "medium",
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-28T10:00:00Z",
  };
  const meeting = {
    id: "m1",
    title: "Revisión semanal",
    heldAt: "2026-10-28T15:00:00Z",
    source: "manual",
    status: "processed",
    summary: "Se revisó el avance.",
    feedback: ["Quieren reportes semanales."],
    actionItems: ["Enviar el plan del proyecto"],
    sentimentSignal: 72,
    processingError: null,
    processedAt: "2026-10-28T16:00:00Z",
    transcriptLength: 120,
  };

  it("el Team Leader aplica el sentimiento sugerido y crea tareas desde los action items", async () => {
    const { calls } = renderAt(`/operativa/${project.id}`, LEAD, (url, init) => {
      if (init?.method === "PATCH") return json({ project: { ...project, sentimentScore: 72 } });
      if (init?.method === "POST" && url.endsWith("/tasks")) return json({ task: {} }, 201);
      if (url === `/api/ops/projects/${project.id}`) return json({ project, permissions: { manage: true, work: true } });
      if (url.endsWith("/meetings")) return json({ meetings: [meeting], processingAvailable: true });
      return json({ members: [], deals: [], tasks: [], updates: [] });
    });
    fireEvent.click(await screen.findByRole("tab", { name: "Reuniones" }));
    expect(await screen.findByText("Quieren reportes semanales.")).toBeTruthy();
    expect(screen.getByText("72/100")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Aplicar al proyecto" }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PATCH")).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.init?.method === "PATCH")!.init?.body))).toEqual({ sentimentScore: 72 });
    fireEvent.click(screen.getByRole("button", { name: /Crear tarea/ }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "POST" && c.url.endsWith("/tasks"))).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith("/tasks") && c.init?.method === "POST")!.init?.body))).toMatchObject({ title: "Enviar el plan del proyecto" });
  });
});
