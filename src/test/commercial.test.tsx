import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { SessionUser } from "@/features/auth/auth";
import ActivitiesPage from "@/features/commercial/ActivitiesPage";
import MeetingsInboxPage from "@/features/commercial/MeetingsInboxPage";
import PartnersPage from "@/features/commercial/PartnersPage";
import ProposalDetailPage from "@/features/commercial/ProposalDetailPage";
import ProposalsPage from "@/features/commercial/ProposalsPage";
import { BOSS } from "./session";

const COMMERCIAL: SessionUser = { id: "u-com", username: "marta", name: "Marta", role: "commercial", teamId: null, mustChangeCredentials: false };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; init?: RequestInit };
const page = <T,>(rows: T[], extra: Record<string, unknown> = {}) => ({ rows, total: rows.length, page: 1, pageSize: 25, facets: {}, totals: {}, canWrite: true, ...extra });

function renderAt(path: string, user: SessionUser, fetchImpl: (url: string, init?: RequestInit) => Response) {
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
        <Routes>
          <Route path="/comercial/actividades" element={<ActivitiesPage />} />
          <Route path="/comercial/partners" element={<PartnersPage />} />
          <Route path="/comercial/propuestas" element={<ProposalsPage />} />
          <Route path="/comercial/propuestas/:id" element={<ProposalDetailPage />} />
          <Route path="/comercial/reuniones" element={<MeetingsInboxPage />} />
          <Route path="/operativa/:id" element={<p>Proyecto abierto</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { calls };
}

describe("actividades y partners", () => {
  it("una actividad vencida se marca y su estado se edita en la celda", async () => {
    const activity = { id: "a1", title: "Llamar a Francisco", kind: "call", owner: { id: "u-com", name: "Marta" }, dueDate: "2020-01-01", overdue: true, status: "pending", notes: "", lead: { id: "l1", title: "Manpersa" }, deal: null, completedAt: null, updatedAt: "" };
    const { calls } = renderAt("/comercial/actividades", COMMERCIAL, (_url, init) => (init?.method === "PATCH" ? json({ activity }) : json(page([activity]))));
    const table = await screen.findByRole("table", { name: "Actividades" });
    expect(within(table).getByText(/vencida/)).toBeTruthy();
    expect(within(table).getByRole("link", { name: "Manpersa" }).getAttribute("href")).toBe("/comercial/leads/l1");
    fireEvent.change(screen.getByLabelText("Estado de Llamar a Francisco"), { target: { value: "done" } });
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PATCH")).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.init?.method === "PATCH")!.init?.body))).toEqual({ status: "done" });
  });

  it("partners: comisión por defecto, valor vendido y comisión generada", async () => {
    const partner = { id: "p1", name: "Agencia Norte", kind: "agency", commissionPct: 10, contactId: null, notes: "", active: true, deals: 2, soldCents: 300_000, commissionCents: 30_000, updatedAt: "" };
    renderAt("/comercial/partners", COMMERCIAL, () => json(page([partner])));
    const row = within((await screen.findByText("Agencia Norte")).closest("tr")!);
    expect(row.getByText("10%")).toBeTruthy();
    expect(row.getByText(/3,000\.00/)).toBeTruthy();
    expect(row.getByText(/300\.00/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Nuevo partner/ })).toBeTruthy();
  });
});

describe("propuestas con líneas", () => {
  const proposal = {
    id: "pr1",
    title: "Propuesta Manpersa",
    url: "https://p.example.com/",
    amountCents: 108_000,
    currency: "USD",
    status: "draft",
    area: "commercial",
    sentAt: null,
    decidedAt: null,
    createdAt: "",
    lead: { id: "l1", title: "Manpersa" },
    deal: null,
    project: null,
    lines: [{ id: "x1", productId: null, product: null, description: "Portal", hours: 40, rateCents: 2500, subtotalCents: 100_000 }],
    useCases: [],
  };

  it("la tabla suma los montos al pie", async () => {
    renderAt("/comercial/propuestas", COMMERCIAL, () => json(page([{ ...proposal, lines: 1 }], { totals: { amountCents: 108_000 } })));
    const table = await screen.findByRole("table", { name: "Propuestas" });
    expect(within(table.querySelector("tfoot")!).getByText(/1,080\.00/)).toBeTruthy();
  });

  it("agregar una línea y guardar envía las líneas; el monto lo calcula el servidor", async () => {
    const { calls } = renderAt("/comercial/propuestas/pr1", COMMERCIAL, (url, init) => {
      if (init?.method === "PATCH") return json({ proposal });
      if (url === "/api/products") return json({ products: [], canWrite: true });
      if (url === "/api/use-cases") return json({ useCases: [], canWrite: true });
      return json({ proposal, canWrite: true });
    });
    expect(await screen.findByRole("heading", { name: "Propuesta Manpersa" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Agregar línea/ }));
    fireEvent.change(screen.getByLabelText("Descripción de la línea 2"), { target: { value: "Capacitación" } });
    fireEvent.change(screen.getByLabelText("Horas de la línea 2"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Tarifa de la línea 2"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: /Guardar líneas/ }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PATCH")).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.init?.method === "PATCH")!.init?.body))).toEqual({
      lines: [
        { productId: null, description: "Portal", hours: 40, rateCents: 2500 },
        { productId: null, description: "Capacitación", hours: 4, rateCents: 2000 },
      ],
    });
  });
});

describe("reuniones por asignar", () => {
  const inbox = {
    id: "m1",
    title: "Sprint review Acme",
    heldAt: "2026-10-28T15:00:00Z",
    source: "read_ai",
    kind: null,
    durationMinutes: 45,
    url: "https://app.read.ai/analytics/meetings/S1",
    deal: null,
    attendees: [],
    participants: [{ name: "Lucía", email: "lucia@acme.pe" }],
    status: "pending",
    reviewStatus: "new",
    summary: "",
    feedback: [],
    actionItems: [],
    clientSentiment: null,
    readAi: { summary: "Resumen de Read.ai.", actionItems: [], topics: [], keyQuestions: [] },
    processingError: null,
    processedAt: null,
    transcriptLength: 300,
    candidates: [
      { kind: "project", id: "p1", name: "Proyecto Acme" },
      { kind: "lead", id: "l1", name: "Acme (lead)" },
    ],
  };

  it("el CEO/CCO asigna la reunión a un candidato y se abre el proyecto", async () => {
    const { calls } = renderAt("/comercial/reuniones", BOSS, (url, init) => {
      if (init?.method === "POST") return json({ ok: true, assigned: { kind: "project", id: "p1" } });
      if (url.startsWith("/api/ops/projects")) return json(page([]));
      return json({ meetings: [inbox] });
    });
    expect(await screen.findByText("Sprint review Acme")).toBeTruthy();
    expect(screen.getByText(/lucia@acme\.pe/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Asignar" }));
    expect(await screen.findByText("Proyecto abierto")).toBeTruthy();
    const post = calls.find((c) => c.init?.method === "POST")!;
    expect(post.url).toBe("/api/meetings/inbox/m1/assign");
    expect(JSON.parse(String(post.init?.body))).toEqual({ projectId: "p1" });
  });

  it("Comercial solo ve los leads candidatos; descartar pide confirmación", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { calls } = renderAt("/comercial/reuniones", COMMERCIAL, (_url, init) => (init?.method === "DELETE" ? json({ ok: true }) : json({ meetings: [inbox] })));
    const select = await screen.findByLabelText("Asignar «Sprint review Acme»");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Lead: Acme (lead)"]);
    fireEvent.click(screen.getByRole("button", { name: /Descartar/ }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "DELETE" && c.url === "/api/meetings/inbox/m1")).toBe(true));
    expect(confirm).toHaveBeenCalled();
    confirm.mockRestore();
  });
});
