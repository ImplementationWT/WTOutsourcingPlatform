import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import NewProjectPage from "@/features/projects/NewProjectPage";
import IntegrationsPage from "@/features/servers/IntegrationsPage";
import type { DeployServer } from "@/types/server";
import { withSession } from "./session";

const PUBKEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPublicaDePrueba launchpad-provisioner VPS Europa";
const FINGERPRINT = "256 SHA256:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ root@vps2 (ED25519)";

const primary: DeployServer = {
  id: "principal",
  name: "Principal",
  primary: true,
  host: "vps.example.test",
  sshPort: null,
  appsDomain: "apps.example.test",
  publicIp: "203.0.113.10",
  status: "ready",
  provisionerPublicKey: null,
  hostKeyFingerprint: null,
  verification: null,
  projects: 3,
  createdBy: null,
  createdAt: null,
};
const pending: DeployServer = {
  ...primary,
  id: "22222222-2222-4222-8222-222222222222",
  name: "VPS Europa",
  primary: false,
  host: "vps2.example.test",
  sshPort: 2222,
  appsDomain: "apps2.example.test",
  publicIp: "198.51.100.20",
  status: "host_key",
  provisionerPublicKey: PUBKEY,
  projects: 0,
};

type Call = { url: string; method: string; body: string | null };

function mockFetch(routes: Record<string, (body: string | null) => { status?: number; json?: unknown; text?: string }>) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ url, method, body });
    const key = Object.keys(routes).find((k) => `${method} ${url}`.startsWith(k));
    const result = key ? routes[key](body) : { status: 404, json: { error: "no simulado" } };
    return new Response(result.text ?? JSON.stringify(result.json ?? {}), { status: result.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

function renderWith(ui: ReactNode) {
  const queryClient = withSession(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Integraciones → Servidores", () => {
  it("guía la preparación con la clave pública y confirma la huella pegada de la consola", async () => {
    const calls = mockFetch({
      "GET /api/servers": () => ({ json: { available: true, ghcrOrg: "acme-org", servers: [primary, pending] } }),
      [`POST /api/servers/${pending.id}/host-key`]: () => ({ json: { server: { ...pending, status: "verify" } } }),
    });
    renderWith(<IntegrationsPage />);

    const commands = (await screen.findByLabelText("Comandos para preparar el VPS")).textContent!;
    expect(commands).toContain(PUBKEY);
    expect(commands).toContain("APP_BASE_DOMAIN=apps2.example.test");
    expect(commands).toContain("GHCR_ORG=acme-org");
    expect(commands).toContain(`PANEL_UPSTREAM=${window.location.origin}`);
    expect(commands).toContain('rsync -a --delete -e "ssh -p 2222"');
    expect(commands).not.toMatch(/PRIVATE KEY/);

    fireEvent.change(screen.getByLabelText("Salida de ssh-keygen"), { target: { value: FINGERPRINT } });
    fireEvent.click(screen.getByRole("button", { name: /Confirmar huella/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/host-key"))).toBe(true));
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/host-key"))!.body!)).toEqual({ consoleOutput: FINGERPRINT });

    // El principal no se puede quitar ni rotar desde aquí.
    expect(screen.getAllByRole("button", { name: /Quitar/ })).toHaveLength(1);
  });

  it("sin clave de cifrado avisa y no deja añadir servidores", async () => {
    mockFetch({ "GET /api/servers": () => ({ json: { available: false, ghcrOrg: null, servers: [primary] } }) });
    renderWith(<IntegrationsPage />);
    expect(await screen.findByText(/SERVER_KEYS_ENCRYPTION_KEY_SECRET_REF/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Añadir servidor/ })).toBeNull();
  });
});

describe("Nuevo proyecto: servidor", () => {
  it("solo ofrece servidores listos y envía el elegido; la URL usa su dominio", async () => {
    const ready = { ...pending, status: "ready" as const };
    const calls = mockFetch({
      "GET /api/projects": () => ({ json: { projects: [] } }),
      "GET /api/platform": () => ({
        json: { deployEnabled: true, appBaseDomain: "apps.example.test", githubOwner: "Acme", templateVersion: "1.5.0", integrationsAvailable: true, atlas: { clusterName: "c", consoleUrl: null } },
      }),
      "GET /api/integrations/catalog": () => ({ json: { available: true, providers: [] } }),
      "GET /api/servers": () => ({ json: { available: true, ghcrOrg: "acme-org", servers: [primary, ready, { ...pending, id: "33333333-3333-4333-8333-333333333333", name: "Sin verificar", appsDomain: "apps3.example.test" }] } }),
      "POST /api/clients": () => ({ status: 202, json: { clientId: "acme-crm", jobId: "11111111-1111-4111-8111-111111111111" } }),
      "GET /api/jobs/": () => ({ text: "" }),
    });
    renderWith(<NewProjectPage />);

    fireEvent.change(await screen.findByLabelText(/Nombre del proyecto/i), { target: { value: "Acme CRM" } });
    fireEvent.change(screen.getByLabelText(/Descripción/i), { target: { value: "CRM interno de Acme para ventas" } });
    fireEvent.click(screen.getByRole("button", { name: /Siguiente/ }));

    const options = await screen.findAllByRole("radio");
    expect(options.map((o) => o.textContent)).toEqual([expect.stringContaining("Principal"), expect.stringContaining("VPS Europa")]);
    expect(options[0].getAttribute("aria-checked")).toBe("true");
    fireEvent.click(options[1]);
    expect(await screen.findByText(".apps2.example.test")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Siguiente/ }));

    expect(await screen.findByText("https://acme-crm.apps2.example.test")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Crear proyecto/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === "/api/clients")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === "POST" && c.url === "/api/clients")!.body!)).toMatchObject({ slug: "acme-crm", serverId: pending.id });
  });
});
