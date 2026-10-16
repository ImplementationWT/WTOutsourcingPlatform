import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import ProjectsPage from "@/features/projects/ProjectsPage";
import { applyFilters, normalizeTag, readFilters } from "@/features/projects/filters";
import type { ProjectRepo } from "@/types/project";

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
const filtersOf = (query: string) => readFilters(new URLSearchParams(query));

describe("filtros de proyectos", () => {
  it("combina origen, estado, etiquetas (todas), archivados y búsqueda", () => {
    expect(names(applyFilters(projects, filtersOf("origen=platform")))).toEqual(["acme-crm-app", "beta-shop-app"]);
    expect(names(applyFilters(projects, filtersOf("origen=other")))).toEqual(["landing-acme", "viejo"]);
    expect(names(applyFilters(projects, filtersOf("estado=failed")))).toEqual(["beta-shop-app"]);
    expect(names(applyFilters(projects, filtersOf("etiquetas=cliente-acme")))).toEqual(["acme-crm-app", "landing-acme"]);
    expect(names(applyFilters(projects, filtersOf("etiquetas=cliente-acme,launchpad")))).toEqual(["acme-crm-app"]);
    expect(names(applyFilters(projects, filtersOf("archivados=ocultar")))).not.toContain("viejo");
    // La búsqueda mira nombre, descripción y etiquetas.
    expect(names(applyFilters(projects, filtersOf("q=landing de")))).toEqual(["landing-acme"]);
    expect(names(applyFilters(projects, filtersOf("q=cliente-ac")))).toEqual(["acme-crm-app", "landing-acme"]);
    // Valores desconocidos en la URL se ignoran.
    expect(applyFilters(projects, filtersOf("origen=x&estado=y"))).toHaveLength(4);
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

function renderPage(fetchImpl: typeof fetch, initial = "/projects") {
  globalThis.fetch = fetchImpl;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
  it("filtra por etiqueta desde los chips y guarda el filtro en la URL", async () => {
    renderPage((async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url === "/api/projects" ? { projects, platformTopic: "launchpad" } : { appBaseDomain: "apps.example.com", atlas: { clusterName: "c", consoleUrl: null } };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }) as typeof fetch);

    await screen.findByText("4 de 4 proyectos");
    const tagFilters = screen.getByText("Etiquetas").parentElement!;
    fireEvent.click(within(tagFilters).getByRole("button", { name: /#cliente-acme/ }));
    expect(screen.getByText("2 de 4 proyectos")).toBeTruthy();
    expect(screen.getByTestId("search").textContent).toBe("?etiquetas=cliente-acme");

    fireEvent.click(screen.getByRole("button", { name: "Creados por la plataforma" }));
    expect(screen.getByText("1 de 4 proyectos")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Limpiar filtros/ }));
    expect(screen.getByText("4 de 4 proyectos")).toBeTruthy();
  });

  it("edita las etiquetas de un proyecto y las envía normalizadas", async () => {
    const puts: { url: string; body: string }[] = [];
    renderPage((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PUT") {
        puts.push({ url, body: String(init.body) });
        return new Response(JSON.stringify({ topics: ["legacy", "sitio-web"] }), { headers: { "content-type": "application/json" } });
      }
      const body = url === "/api/projects" ? { projects: [projects[3]] } : { appBaseDomain: "apps.example.com", atlas: { clusterName: "c", consoleUrl: null } };
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
    const tagFilters = (await screen.findByText("Etiquetas")).parentElement!;
    expect(await within(tagFilters).findByRole("button", { name: /#sitio-web/ })).toBeTruthy();
  });
});
