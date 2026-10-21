import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import ProjectsPage from "@/features/projects/ProjectsPage";
import { normalizeTag, searchProjects } from "@/features/projects/filters";
import type { ProjectRepo } from "@/types/project";
import { BOSS, withSession } from "./session";

const base = {
  fullName: "",
  description: null,
  url: "https://github.com/acme-org/x",
  private: true,
  archived: false,
  defaultBranch: "main",
  language: null,
  createdAt: null,
  pushedAt: null,
  topics: [] as string[],
  clientId: null,
  clientStatus: null,
};
const projects: ProjectRepo[] = [
  { ...base, id: 1, name: "acme-crm-app", topics: ["launchpad", "cliente-acme"], clientId: "acme-crm", clientStatus: "ready" },
  { ...base, id: 2, name: "beta-shop-app", topics: ["launchpad"], clientId: "beta-shop", clientStatus: "failed" },
  { ...base, id: 3, name: "landing-acme", topics: ["cliente-acme"], description: "Landing de Acme" },
  { ...base, id: 4, name: "viejo", archived: true },
];

const names = (list: ProjectRepo[]) => list.map((p) => p.name);

describe("búsqueda de proyectos", () => {
  it("busca por nombre, descripción y etiquetas", () => {
    expect(searchProjects(projects, "")).toHaveLength(4);
    expect(names(searchProjects(projects, "landing de"))).toEqual(["landing-acme"]);
    expect(names(searchProjects(projects, "cliente-ac"))).toEqual(["acme-crm-app", "landing-acme"]);
    expect(names(searchProjects(projects, "  BETA "))).toEqual(["beta-shop-app"]);
  });

  it("normaliza etiquetas al formato de GitHub", () => {
    expect(normalizeTag("  Cliente Ácme  ")).toBe("cliente-acme");
    expect(normalizeTag("--Shopify!!2--")).toBe("shopify-2");
    expect(normalizeTag("x".repeat(80))).toHaveLength(50);
  });
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="search">{location.search}</output>;
}

function renderPage(fetchImpl: typeof fetch, initial = "/projects", user = undefined as typeof BOSS | undefined) {
  globalThis.fetch = fetchImpl;
  const queryClient = withSession(new QueryClient({ defaultOptions: { queries: { retry: false } } }), user);
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/projects" element={<><ProjectsPage /><LocationProbe /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("página de Proyectos", () => {
  it("sin filtros: solo la búsqueda (guardada en la URL); pulsar una etiqueta la busca", async () => {
    renderPage((async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url === "/api/projects" ? { projects, platformTopic: "launchpad" } : { appBaseDomain: "apps.example.com", atlas: { clusterName: "c", consoleUrl: null } };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }) as typeof fetch);

    await screen.findByText("4 de 4 proyectos");
    expect(screen.queryByText("Origen")).toBeNull();
    expect(screen.queryByText("Estado")).toBeNull();
    expect(screen.queryByRole("button", { name: /Ocultar archivados/ })).toBeNull();

    fireEvent.change(screen.getByPlaceholderText(/Buscar por nombre/), { target: { value: "beta" } });
    expect(screen.getByText("1 de 4 proyectos")).toBeTruthy();
    expect(screen.getByTestId("search").textContent).toBe("?q=beta");

    fireEvent.click(screen.getByRole("button", { name: /Limpiar búsqueda/ }));
    expect(screen.getByText("4 de 4 proyectos")).toBeTruthy();

    const card = screen.getByText("landing-acme").closest("[data-slot=card]") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: /#cliente-acme/ }));
    expect(screen.getByText("2 de 4 proyectos")).toBeTruthy();
    expect(screen.getByTestId("search").textContent).toBe("?q=cliente-acme");
  });

  it("edita las etiquetas de un proyecto y las envía normalizadas", async () => {
    const puts: { url: string; body: string }[] = [];
    renderPage((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PUT") {
        puts.push({ url, body: String(init.body) });
        return new Response(JSON.stringify({ topics: ["legacy", "sitio-web"] }), { headers: { "content-type": "application/json" } });
      }
      const body = url === "/api/projects" ? { projects: [{ ...projects[3], clientId: "viejo" }] } : { appBaseDomain: "apps.example.com", atlas: { clusterName: "c", consoleUrl: null } };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }) as typeof fetch);

    fireEvent.click(await screen.findByRole("button", { name: /Añadir etiquetas/ }));
    const input = screen.getByLabelText("Nueva etiqueta para viejo");
    fireEvent.change(input, { target: { value: "Legacy" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "Sitio web" } });
    fireEvent.click(screen.getByRole("button", { name: /Guardar/ }));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ url: "/api/projects/viejo/topics", body: JSON.stringify({ topics: ["legacy", "sitio-web"] }) });
    // La etiqueta guardada aparece en la tarjeta del proyecto.
    expect(await screen.findByRole("button", { name: /#sitio-web/ })).toBeTruthy();
  });

  it("un jefe solo consulta: sin crear proyectos ni editar etiquetas", async () => {
    renderPage(
      (async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = url === "/api/projects" ? { projects } : { appBaseDomain: "apps.example.com", atlas: { clusterName: "c", consoleUrl: null } };
        return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      "/projects",
      BOSS,
    );
    await screen.findByText("4 de 4 proyectos");
    expect(screen.queryByText(/Nuevo proyecto/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Añadir etiquetas|Editar/ })).toBeNull();
  });
});
