import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfirmProvider } from "@/components/ui/confirm-provider";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { SessionUser } from "@/features/auth/auth";
import ActivitiesPage from "@/features/commercial/ActivitiesPage";
import ProposalDetailPage from "@/features/commercial/ProposalDetailPage";
import ProposalsPage from "@/features/commercial/ProposalsPage";
import MeetingsPage from "@/features/meetings/MeetingsPage";
import { optionLabels, pick } from "./pick";
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
      <ConfirmProvider>
        <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/comercial/actividades" element={<ActivitiesPage />} />
          <Route path="/comercial/propuestas" element={<ProposalsPage />} />
          <Route path="/comercial/propuestas/:id" element={<ProposalDetailPage />} />
          <Route path="/meetings" element={<MeetingsPage />} />
          <Route path="/operativa/:id" element={<p>Proyecto abierto</p>} />
        </Routes>
      </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
  return { calls };
}

describe("actividades", () => {
  it("una actividad vencida se marca y su estado se edita en la celda", async () => {
    const activity = { id: "a1", title: "Llamar a Francisco", kind: "call", owner: { id: "u-com", name: "Marta" }, dueDate: "2020-01-01", overdue: true, status: "pending", notes: "", lead: { id: "l1", title: "Manpersa" }, deal: null, completedAt: null, updatedAt: "" };
    const { calls } = renderAt("/comercial/actividades", COMMERCIAL, (_url, init) => (init?.method === "PATCH" ? json({ activity }) : json(page([activity]))));
    const table = await screen.findByRole("table", { name: "Actividades" });
    expect(within(table).getByText(/vencida/)).toBeTruthy();
    expect(within(table).getByRole("link", { name: "Manpersa" }).getAttribute("href")).toBe("/comercial/leads/l1");
    await pick("Estado de Llamar a Francisco", "Hecha");
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PATCH")).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.init?.method === "PATCH")!.init?.body))).toEqual({ status: "done" });
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
    lines: [{ id: "x1", description: "Portal", hours: 40, rateCents: 2500, subtotalCents: 100_000 }],
  };

  it("la tabla suma los montos al pie", async () => {
    renderAt("/comercial/propuestas", COMMERCIAL, () => json(page([{ ...proposal, lines: 1 }], { totals: { amountCents: 108_000 } })));
    const table = await screen.findByRole("table", { name: "Propuestas" });
    expect(within(table.querySelector("tfoot")!).getByText(/1,080\.00/)).toBeTruthy();
  });

  it("agregar una línea y guardar envía las líneas; el monto lo calcula el servidor", async () => {
    const { calls } = renderAt("/comercial/propuestas/pr1", COMMERCIAL, (_url, init) => {
      if (init?.method === "PATCH") return json({ proposal });
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
        { description: "Portal", hours: 40, rateCents: 2500 },
        { description: "Capacitación", hours: 4, rateCents: 2000 },
      ],
    });
  });
});

describe("Meetings", () => {
  const TEAM_A = { id: "t-a", name: "Equipo A" };
  const row = (id: string, title: string, team: typeof TEAM_A | null, engagement: "low" | "neutral" | "good" | "excellent" | null) => ({
    id,
    title,
    heldAt: "2026-10-28T15:00:00Z",
    durationMinutes: 45,
    source: "read_ai",
    status: "processed",
    engagement,
    team,
    project: null,
    lead: null,
  });
  const rows = [row("m1", "Sprint review Acme", TEAM_A, "excellent"), row("m2", "Llamada sin equipo", null, "low")];
  const detail = {
    ...rows[0],
    team: null,
    kind: null,
    url: "https://app.read.ai/analytics/meetings/S1",
    deal: null,
    attendees: [],
    participants: [{ name: "Lucía", email: "lucia@acme.pe" }],
    reviewStatus: "new",
    summary: "Se revisó el sprint y el cliente aprobó la demo.",
    feedback: [],
    actionItems: [],
    clientSentiment: null,
    readAi: { summary: "Resumen de Read.ai.", actionItems: ["Enviar acta"], topics: ["Sprint 4"], keyQuestions: ["¿Cuándo sale?"] },
    processingError: null,
    processedAt: null,
    transcriptLength: 300,
    candidates: [
      { kind: "project", id: "p1", name: "Proyecto Acme" },
      { kind: "lead", id: "l1", name: "Acme (lead)" },
    ],
  };
  const route = (permissions: Record<string, boolean>) => (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") return json({ ok: true, assigned: { kind: "project", id: "p1" } });
    if (url.startsWith("/api/teams")) return json({ teams: [TEAM_A] });
    if (url === "/api/meetings/m1") return json({ meeting: detail, permissions });
    return json(page(rows, { facets: { "t-a": 1, "": 1 } }));
  };

  it("tabla con nombre, fecha, equipo y engagement; se agrupa por equipo", async () => {
    renderAt("/meetings?group=1", BOSS, route({ assign: true, team: true, discard: true }));
    const table = await screen.findByRole("table", { name: "Meetings" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent?.trim())).toEqual(expect.arrayContaining(["Reunión", "Fecha", "Equipo", "Engagement"]));
    const acme = within(within(table).getByText("Sprint review Acme").closest("tr")!);
    expect(acme.getByText("Excelente")).toBeTruthy();
    expect(within(within(table).getByText("Llamada sin equipo").closest("tr")!).getByText("Bajo")).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: /Equipo A/ })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: /^Sin equipo/ })).toBeTruthy();
  });

  it("clic en la fila abre el pop-up solo con el informe de Read.ai; el CEO/CCO liga la reunión", async () => {
    const { calls } = renderAt("/meetings", BOSS, route({ assign: true, team: true, discard: true }));
    fireEvent.click(await screen.findByText("Sprint review Acme"));
    const dialog = await screen.findByRole("dialog", { name: "Sprint review Acme" });
    expect(await within(dialog).findByText("Resumen de Read.ai.")).toBeTruthy();
    expect(within(dialog).queryByText(/el cliente aprobó la demo/)).toBeNull();
    expect(within(dialog).queryByText(/procesando/)).toBeNull();
    expect(within(dialog).getByText("Sprint 4")).toBeTruthy();
    expect(within(dialog).getByText("¿Cuándo sale?")).toBeTruthy();
    expect(within(dialog).getByText(/lucia@acme\.pe/)).toBeTruthy();
    await pick("Ligar la reunión a un proyecto o lead", /^Proyecto Acme/);
    await waitFor(() => expect(calls.some((c) => c.init?.method === "POST")).toBe(true));
    const post = calls.find((c) => c.init?.method === "POST")!;
    expect(post.url).toBe("/api/meetings/m1/assign");
    expect(JSON.parse(String(post.init?.body))).toEqual({ projectId: "p1" });
  });

  it("Comercial solo puede ligar a leads; descartar pide confirmación", async () => {
    const { calls } = renderAt("/meetings", COMMERCIAL, route({ assign: true, team: false, discard: true }));
    fireEvent.click(await screen.findByText("Sprint review Acme"));
    await screen.findByRole("dialog", { name: "Sprint review Acme" });
    expect(await optionLabels("Ligar la reunión a un proyecto o lead")).toEqual(["Acme (lead)Lead (coincide por correo)"]);
    expect(screen.queryByLabelText("Equipo de la reunión")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Descartar reunión/ }));
    const ask = await screen.findByRole("alertdialog", { name: "¿Descartar «Sprint review Acme»?" });
    expect(within(ask).getByText(/hay que reenviarla desde Read.ai/)).toBeTruthy();
    expect(calls.some((c) => c.init?.method === "DELETE")).toBe(false);
    fireEvent.click(within(ask).getByRole("button", { name: "Descartar" }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "DELETE" && c.url === "/api/meetings/m1")).toBe(true));
  });
});
