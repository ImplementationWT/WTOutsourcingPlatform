import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ConfirmProvider } from "@/components/ui/confirm-provider";
import { Toaster } from "@/components/ui/toaster";
import UsersPage from "@/features/admin/UsersPage";
import SettingsPage from "@/features/settings/SettingsPage";
import { BOSS, LEAD, withSession } from "./session";
import type { SessionUser } from "@/features/auth/auth";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const user = (id: string, name: string, role: string, teamId: string | null, extra: object = {}) => ({ id, username: name.toLowerCase(), name, email: `${name.toLowerCase()}@whatever.tech`, role, teamId, active: true, mustChangeCredentials: false, locked: false, lastLoginAt: null, createdAt: "2026-01-01", ...extra });
const USERS = [user("u-boss", "Jefa", "boss", null), user("u1", "Ariana", "lead", "t1", { mustChangeCredentials: true }), user("u2", "Romina", "developer", "t1", { email: null }), user("u3", "Lucho", "commercial", null, { active: false })];
const TEAMS = [{ id: "t1", name: "Team A", leadUserId: "u1", projects: 1, createdAt: "2026-01-01" }];

function renderPage(node: React.ReactNode, me: SessionUser = BOSS) {
  const calls: { url: string; method: string; body?: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
    if (url === "/api/admin/users" && init?.method === "POST") return json({ user: USERS[2], temporaryPassword: "temp-123456" }, 201);
    if (url === "/api/admin/users") return json({ users: USERS });
    if (url === "/api/admin/teams") return json({ teams: TEAMS });
    if (url === "/api/teams") return json({ teams: TEAMS });
    if (url.startsWith("/api/ops/stage-sla")) return json({ days: { kickoff: 7, structure: 30, automation_layer: 21, stabilization: 14, maintenance: 60, no_pending_items: 14, completed: null }, defaults: {} });
    return json({});
  }) as typeof fetch;
  render(
    <QueryClientProvider client={withSession(new QueryClient({ defaultOptions: { queries: { retry: false } } }), me)}>
      <Toaster>
        <ConfirmProvider>
          <MemoryRouter>{node}</MemoryRouter>
        </ConfirmProvider>
      </Toaster>
    </QueryClientProvider>,
  );
  return calls;
}

describe("Usuarios y equipos", () => {
  it("Personas: filtros con contador, estado de cada persona y «Agregar correo»", async () => {
    renderPage(<UsersPage />);
    const people = await screen.findByRole("list", { name: "Personas" });
    expect(within(people).getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByRole("tab", { name: /Inactivos/ }).textContent).toContain("1");
    expect(within(people).getByText("Contraseña temporal")).toBeTruthy();
    expect(within(people).getByText("Inactivo")).toBeTruthy();
    expect(within(people).getByRole("button", { name: /Agregar correo/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Team leaders/ }));
    expect(within(screen.getByRole("list", { name: "Personas" })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("Nuevo usuario: se elige el rol en tarjetas (los 5) y se muestra la contraseña temporal", async () => {
    const calls = renderPage(<UsersPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Nuevo usuario/ }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getAllByRole("radio")).toHaveLength(5);
    fireEvent.click(dialog.getByRole("radio", { name: /Comercial/ }));
    fireEvent.change(dialog.getByLabelText("Nombre"), { target: { value: "Ana López" } });
    fireEvent.change(dialog.getByLabelText("3. Usuario"), { target: { value: "ana.lopez" } });
    fireEvent.click(dialog.getByRole("button", { name: "Crear usuario" }));
    expect(await screen.findByText("temp-123456")).toBeTruthy();
    const post = calls.find((c) => c.method === "POST" && c.url === "/api/admin/users")!;
    expect(JSON.parse(post.body!)).toMatchObject({ username: "ana.lopez", role: "commercial", teamId: null });
  });

  it("Equipos: tarjeta con su team leader y sus miembros", async () => {
    renderPage(<UsersPage />);
    fireEvent.click(await screen.findByRole("tab", { name: /Equipos/ }));
    const card = within(screen.getByRole("region", { name: "Team A" }));
    expect(card.getByText("1 proyecto")).toBeTruthy();
    expect(card.getByText("2 personas")).toBeTruthy();
    expect(card.getByText("Romina")).toBeTruthy();
  });
});

describe("Configuración", () => {
  it("CEO/CCO: cuenta, seguridad y plazos por etapa", async () => {
    renderPage(<SettingsPage />, { ...BOSS, email: "jefa@whatever.tech" });
    expect(await screen.findByText("jefa@whatever.tech")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ir a Usuarios y equipos" })).toBeTruthy();
    expect(await screen.findByText("Plazos por etapa")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Guardar cambios" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Cambiar contraseña" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  });

  it("Team leader: sin plazos ni enlace a Usuarios", async () => {
    renderPage(<SettingsPage />, LEAD);
    expect(await screen.findByText("Seguridad")).toBeTruthy();
    expect(screen.queryByText("Plazos por etapa")).toBeNull();
    expect(screen.queryByRole("link", { name: "Ir a Usuarios y equipos" })).toBeNull();
  });
});
