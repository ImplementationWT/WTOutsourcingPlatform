import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AppSidebar from "@/components/layout/AppSidebar";
import OpsProjectDetailPage from "@/features/ops/OpsProjectDetailPage";
import OpsProjectsPage from "@/features/ops/OpsProjectsPage";
import type { OpsProject, OpsProjectListItem } from "@/features/ops/api";
import type { SessionUser } from "@/features/auth/auth";
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
  clientSlug: null,
  proposalUrl: "https://demo.example.com/manpersa",
  customerId: null,
  leadId: null,
  stage: "structure",
  health: "at_risk",
  sentimentScore: 35,
  priority: "critical",
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-28T10:00:00Z",
};
const listItem: OpsProjectListItem = { ...project, summary: { deals: 2, hours: 60, amountCents: 150_000, tasks: 4, tasksDone: 1 } };

function renderAt(path: string, user: SessionUser, fetchImpl?: typeof fetch) {
  if (fetchImpl) globalThis.fetch = fetchImpl;
  const queryClient = withSession(new QueryClient({ defaultOptions: { queries: { retry: false } } }), user);
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AppSidebar />
        <Routes>
          <Route path="/operativa" element={<OpsProjectsPage />} />
          <Route path="/operativa/:id" element={<OpsProjectDetailPage />} />
        </Routes>
      </MemoryRouter>
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

  it("CEO/CCO ve las cuatro áreas", () => {
    renderAt("/operativa", BOSS, (async () => json({ projects: [] })) as typeof fetch);
    expect(sections()).toEqual(["Comercial", "Operativa", "Financiera", "Infraestructura"]);
  });

  it("Comercial: Comercial y Operativa, sin Infraestructura", () => {
    renderAt("/operativa", COMMERCIAL, (async () => json({ projects: [] })) as typeof fetch);
    expect(sections()).toEqual(["Comercial", "Operativa"]);
  });

  it("Financiera: Operativa y Financiera", () => {
    renderAt("/operativa", FINANCE, (async () => json({ projects: [] })) as typeof fetch);
    expect(sections()).toEqual(["Operativa", "Financiera"]);
  });

  it("developer: Operativa e Infraestructura", () => {
    renderAt("/operativa", DEV, (async () => json({ projects: [] })) as typeof fetch);
    expect(sections()).toEqual(["Operativa", "Infraestructura"]);
  });

  it("Comercial ya es un enlace; Financiera, que aún no existe, no", () => {
    renderAt("/operativa", BOSS, (async () => json({ projects: [] })) as typeof fetch);
    expect(screen.getByRole("link", { name: /Leads y propuestas/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Cobros y comisiones/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Proyectos del cliente/ })).toBeTruthy();
  });
});

describe("lista de proyectos operativos", () => {
  it("muestra etapa, health, prioridad, sentimiento y el resumen de deals", async () => {
    renderAt("/operativa", LEAD, (async () => json({ projects: [listItem] })) as typeof fetch);
    const row = within(await screen.findByRole("link", { name: /Automatización Manpersa/ }));
    expect(row.getByText("Estructura")).toBeTruthy();
    expect(row.getByText("At Risk")).toBeTruthy();
    expect(row.getByText("Critical")).toBeTruthy();
    expect(row.getByText("2 deals · 60 h")).toBeTruthy();
    expect(row.getByText(/1\/4 tareas/)).toBeTruthy();
  });

  it("los filtros se envían a la API", async () => {
    const urls: string[] = [];
    renderAt("/operativa", LEAD, (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return json({ projects: [] });
    }) as typeof fetch);
    await screen.findByText("Aún no hay proyectos operativos.");
    fireEvent.change(screen.getByLabelText("Filtrar por health"), { target: { value: "at_risk" } });
    await waitFor(() => expect(urls.some((u) => u.includes("health=at_risk"))).toBe(true));
  });

  it("solo el CEO/CCO y el Team Leader crean proyectos", async () => {
    const empty = (async () => json({ projects: [] })) as typeof fetch;
    renderAt("/operativa", LEAD, empty);
    expect(await screen.findByRole("button", { name: /Nuevo proyecto/ })).toBeTruthy();
  });

  it("comercial, finance y developer no ven el botón de crear", async () => {
    renderAt("/operativa", COMMERCIAL, (async () => json({ projects: [listItem] })) as typeof fetch);
    await screen.findByText("Automatización Manpersa");
    expect(screen.queryByRole("button", { name: /Nuevo proyecto/ })).toBeNull();
  });
});

describe("detalle del proyecto", () => {
  const route = (permissions: { manage: boolean; work: boolean }) =>
    (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/api/ops/projects/${project.id}`)) return json({ project, permissions });
      if (url.endsWith("/deals")) return json({ deals: [] });
      return json({ members: [], tasks: [], updates: [], meetings: [], accounts: [] });
    }) as typeof fetch;

  it("Team Leader: puede editar etapa, health, prioridad y sentimiento, y ve las cuentas", async () => {
    renderAt(`/operativa/${project.id}`, LEAD, route({ manage: true, work: true }));
    expect(await screen.findByRole("button", { name: "Maintenance" })).toBeTruthy();
    expect(screen.getByLabelText("Health")).toBeTruthy();
    expect(screen.getByLabelText("Sentiment score")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Cuentas" })).toBeTruthy();
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
