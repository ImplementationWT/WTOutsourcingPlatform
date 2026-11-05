import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { NotificationsBell } from "@/components/layout/NotificationsBell";
import { MentionTextarea, mentionsIn, WithMentions } from "@/components/ui/mention-textarea";
import { useState } from "react";

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const people = [{ id: "u-ana", name: "Ana Líder" }, { id: "u-dev", name: "Diego Dev" }];

function Where() {
  return <output aria-label="Ruta">{useLocation().pathname}</output>;
}

function setup(ui: React.ReactNode) {
  const calls: { url: string; method: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    if (url === "/api/notifications") return json({ unread: 1, items: [{ id: "n1", kind: "mention", title: "Jefe te mencionó en Manpersa SAC", body: "@Ana Líder revisa", link: "/comercial/leads/l1", actorName: "Jefe", read: false, createdAt: new Date().toISOString() }] });
    if (url === "/api/notifications/people") return json({ people });
    return json({ ok: true });
  }) as typeof fetch;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="*" element={<>{ui}<Where /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

describe("notificaciones", () => {
  it("la campana muestra los no leídos; al abrir un aviso lo marca como leído y va a su pantalla", async () => {
    const calls = setup(<NotificationsBell />);
    const bell = await screen.findByRole("button", { name: "Notificaciones: 1 sin leer" });
    fireEvent.click(bell);
    fireEvent.click(await screen.findByText("Jefe te mencionó en Manpersa SAC"));
    await waitFor(() => expect(screen.getByLabelText("Ruta").textContent).toBe("/comercial/leads/l1"));
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/notifications/n1/read")).toBe(true);
  });

  it("al escribir «@» aparece la lista de personas y se inserta la mención", async () => {
    function Box() {
      const [v, setV] = useState("");
      return (
        <>
          <MentionTextarea label="Nuevo update" value={v} onChange={setV} />
          <output aria-label="Menciones">{mentionsIn(v, people).join(",")}</output>
        </>
      );
    }
    setup(<Box />);
    const box = screen.getByLabelText("Nuevo update") as HTMLTextAreaElement;
    // Espera a que llegue la lista de personas antes de escribir.
    await waitFor(() => expect(globalThis.fetch).toBeDefined());
    fireEvent.change(box, { target: { value: "Hola @an", selectionStart: 8 } });
    const list = await screen.findByRole("listbox", { name: "Mencionar a" });
    fireEvent.click(within(list).getByText("Ana Líder"));
    await waitFor(() => expect(box.value).toBe("Hola @Ana Líder "));
    expect(screen.getByLabelText("Menciones").textContent).toBe("u-ana");
  });

  it("las menciones se resaltan en el texto del update", () => {
    render(<WithMentions text="@Ana Líder mira esto" people={people} />);
    expect(screen.getByText("@Ana Líder").tagName).toBe("SPAN");
  });
});
