import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import IntegrationsCard from "@/features/projects/IntegrationsCard";
import NewProjectPage from "@/features/projects/NewProjectPage";
import type { ClientDetail } from "@/types/project";

const TOKEN = "monday-token-secreto-0123456789-abcdef";

const catalog = {
  available: true,
  providers: [
    {
      id: "monday",
      label: "Monday.com",
      description: "Tab Monday con los tableros.",
      help: ["Genera un token personal."],
      helpUrl: "https://developer.monday.com/api-reference/docs/authentication",
      fields: [{ name: "token", label: "Token de la API", type: "secret", maxLength: 2000 }],
    },
  ],
};

type Call = { url: string; method: string; body: string | null };
let calls: Call[];

/** fetch simulado: responde por ruta y guarda las peticiones. */
function mockFetch(routes: Record<string, (body: string | null) => { status?: number; json?: unknown; text?: string }>) {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ url, method, body });
    const key = Object.keys(routes).find((k) => `${method} ${url}`.startsWith(k));
    const result = key ? routes[key](body) : { status: 404, json: { error: "no simulado" } };
    const text = result.text ?? JSON.stringify(result.json ?? {});
    return new Response(text, { status: result.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function renderWith(ui: ReactNode, path = "/") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="*" element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

/** Lo que no debe contener la credencial tras enviarla. */
function expectNotPersisted(queryClient: QueryClient) {
  expect(document.body.innerHTML).not.toContain(TOKEN);
  expect(screen.queryByDisplayValue(TOKEN)).toBeNull();
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
  expect(window.location.href).not.toContain(TOKEN);
  const cache = JSON.stringify({
    queries: queryClient.getQueryCache().getAll().map((q) => ({ key: q.queryKey, data: q.state.data })),
    mutations: queryClient.getMutationCache().getAll().map((m) => m.state),
  });
  expect(cache).not.toContain(TOKEN);
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("credenciales de integraciones en el panel", () => {
  it("asistente: el token viaja una vez en POST /api/clients y luego no queda en ningún sitio", async () => {
    mockFetch({
      "GET /api/projects": () => ({ json: { projects: [] } }),
      "GET /api/platform": () => ({
        json: { deployEnabled: true, appBaseDomain: "apps.example.test", githubOwner: "Acme", templateVersion: "1.5.0", integrationsAvailable: true, atlas: { clusterName: "c", consoleUrl: null } },
      }),
      "GET /api/integrations/catalog": () => ({ json: catalog }),
      "POST /api/clients": () => ({ status: 202, json: { clientId: "acme-crm", jobId: "11111111-1111-4111-8111-111111111111" } }),
      "GET /api/jobs/": () => ({ text: "" }),
    });
    const { queryClient } = renderWith(<NewProjectPage />);

    fireEvent.change(await screen.findByLabelText(/Nombre del proyecto/i), { target: { value: "Acme CRM" } });
    fireEvent.change(screen.getByLabelText(/Descripción/i), { target: { value: "CRM interno de Acme para ventas" } });
    fireEvent.click(screen.getByRole("button", { name: /Siguiente/ }));

    const toggle = await screen.findByRole("switch", { name: "Activar Monday.com" });
    fireEvent.click(toggle);
    const input = await screen.findByLabelText("Token de la API");
    expect(input).toHaveProperty("type", "password");
    expect(input.getAttribute("autocomplete")).toBe("off");
    fireEvent.change(input, { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: "Mostrar Token de la API" }));
    expect(input).toHaveProperty("type", "text");
    fireEvent.click(screen.getByRole("button", { name: /Siguiente/ }));

    expect(await screen.findByText("Monday.com: activada")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(TOKEN);
    fireEvent.click(screen.getByRole("button", { name: /Crear proyecto/ }));

    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === "/api/clients")).toBe(true));
    const post = calls.find((c) => c.method === "POST" && c.url === "/api/clients")!;
    expect(JSON.parse(post.body!)).toMatchObject({ slug: "acme-crm", integrations: { monday: { token: TOKEN } } });
    expect(calls.filter((c) => c.body?.includes(TOKEN))).toHaveLength(1);
    expectNotPersisted(queryClient);
  });

  it("detalle: Actualizar credencial envía el token una vez y lo borra del formulario", async () => {
    mockFetch({
      "GET /api/integrations/catalog": () => ({ json: catalog }),
      "POST /api/integrations/monday/validate": () => ({ json: { ok: true } }),
      "PUT /api/clients/acme-crm/integrations/monday": () => ({ status: 202, json: { action: "redeploy", jobId: "j" } }),
    });
    const client = {
      id: "acme-crm",
      name: "Acme CRM",
      status: "ready",
      integrations: [{ provider: "monday", enabled: true, configuredAt: new Date().toISOString(), updatedAt: null }],
    } as unknown as ClientDetail["client"];
    const { queryClient } = renderWith(<IntegrationsCard client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: /Actualizar credencial/ }));
    fireEvent.change(screen.getByLabelText("Token de la API"), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: /Probar conexión/ }));
    expect(await screen.findByText("Conexión correcta")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Guardar/ }));

    const status = await screen.findByText(/Se está redesplegando/);
    expect(within(status.parentElement!).queryByDisplayValue(TOKEN)).toBeNull();
    const put = calls.find((c) => c.method === "PUT")!;
    expect(JSON.parse(put.body!)).toEqual({ token: TOKEN });
    expectNotPersisted(queryClient);
  });

  it("desactivar pide confirmación en la propia página", async () => {
    mockFetch({
      "GET /api/integrations/catalog": () => ({ json: catalog }),
      "DELETE /api/clients/acme-crm/integrations/monday": () => ({ status: 202, json: { action: "redeploy", jobId: "j" } }),
    });
    const client = {
      id: "acme-crm",
      status: "ready",
      integrations: [{ provider: "monday", enabled: true, configuredAt: new Date().toISOString(), updatedAt: null }],
    } as unknown as ClientDetail["client"];
    renderWith(<IntegrationsCard client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: /Desactivar/ }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Sí, desactivar/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  });
});
