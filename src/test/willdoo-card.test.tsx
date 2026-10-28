import { describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import WillDooCard from "@/features/projects/WillDooCard";
import type { ClientDetail } from "@/types/project";
import { withSession } from "./session";

function client(overrides: Partial<ClientDetail["client"]> = {}) {
  return {
    id: "acme-crm",
    name: "Acme CRM",
    status: "ready",
    template: { name: "node-typescript", version: "1.7.0", schemaVersion: 4 },
    integrations: [],
    willDoo: { mode: "basic", updatedAt: null },
    ...overrides,
  } as unknown as ClientDetail["client"];
}

function renderCard(value: ClientDetail["client"]) {
  const puts: unknown[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    puts.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ mode: "off", redeploy: true, actionsUrl: "https://github.com/x/actions" }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const queryClient = withSession(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  render(
    <QueryClientProvider client={queryClient}>
      <WillDooCard client={value} />
    </QueryClientProvider>,
  );
  return { puts };
}

describe("tarjeta Will Doo del proyecto", () => {
  it("tres opciones; «+ Claude» exige antes la clave de Anthropic; guarda y redespliega", async () => {
    const { puts } = renderCard(client());
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByRole("radio", { name: /Will Doo solo/ }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByRole("radio", { name: /Will Doo \+ Claude/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Primero guarda la clave de Anthropic/)).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: /Sin Will Doo/ }));
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(puts).toEqual([{ mode: "off" }]));
    expect(await screen.findByText(/Se está redesplegando/)).toBeTruthy();
  });

  it("con la clave guardada se puede elegir «Will Doo + Claude»; avisa si la plantilla es anterior", () => {
    renderCard(client({ integrations: [{ provider: "anthropic", enabled: true, configuredAt: "2026-10-28T00:00:00Z", updatedAt: null }] }));
    expect((screen.getByRole("radio", { name: /Will Doo \+ Claude/ }) as HTMLButtonElement).disabled).toBe(false);
    cleanup();
    renderCard(client({ template: { name: "node-typescript", version: "1.6.0", schemaVersion: 3 } }));
    expect(screen.getByText(/Necesita la plantilla 1.7.0/)).toBeTruthy();
  });
});
