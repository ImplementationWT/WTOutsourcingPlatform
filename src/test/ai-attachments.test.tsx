import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ChatPanel from "@/features/ai/ChatPanel";
import type { AiSession } from "@/types/ai";

const session: AiSession = {
  id: "11111111-1111-4111-8111-111111111111",
  clientId: "acme-crm",
  title: "Pantalla Referencia",
  status: "active",
  branch: "claude-develop",
  baseBranch: "main",
  repository: "acme-crm",
  createdBy: "admin",
  createdAt: "2026-10-20T10:00:00.000Z",
  lastMessageAt: null,
  pullRequest: null,
  merge: null,
  closedAt: null,
  consoleUrl: null,
};

let bodies: unknown[];

beforeEach(() => {
  bodies = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

function renderChat() {
  render(<ChatPanel session={session} items={[]} state="idle" pending={[]} connection="open" onRaiseBudget={async () => {}} />);
  return screen.getByTestId("markdown-input") as HTMLInputElement;
}

const file = (name: string, content: string) => new File([content], name, { type: "text/markdown" });

describe("AI Developer: adjuntos .md", () => {
  it("adjunta un .md y lo envía con el mensaje; después limpia la lista", async () => {
    const input = renderChat();
    fireEvent.change(input, { target: { files: [file("spec.md", "# Referencia\n\nCambiar el título")] } });
    expect(await screen.findByText("spec.md")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Instrucción para Claude"), { target: { value: "Sigue la especificación" } });
    fireEvent.click(screen.getByRole("button", { name: /Enviar/ }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      text: "Sigue la especificación",
      attachments: [{ name: "spec.md", content: "# Referencia\n\nCambiar el título" }],
    });
    await waitFor(() => expect(screen.queryByText("spec.md")).toBeNull());
  });

  it("permite enviar solo adjuntos y rechaza otros tipos de archivo", async () => {
    const input = renderChat();
    fireEvent.change(input, { target: { files: [file("notas.txt", "hola")] } });
    expect((await screen.findByRole("alert")).textContent).toContain("solo se aceptan archivos .md");
    expect((screen.getByRole("button", { name: /Enviar/ }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { files: [file("guia.markdown", "Usa #0F4C81")] } });
    await screen.findByText("guia.markdown");
    fireEvent.click(screen.getByRole("button", { name: /Enviar/ }));
    await waitFor(() => expect(bodies).toEqual([{ text: "", attachments: [{ name: "guia.markdown", content: "Usa #0F4C81" }] }]));
  });

  it("muestra los nombres de los adjuntos en el mensaje del chat", () => {
    render(
      <ChatPanel
        session={session}
        items={[{ id: "e1", at: null, kind: "user", text: "Te adjunto estos archivos Markdown.", attachments: ["spec.md"] }]}
        state="idle"
        pending={[]}
        connection="open"
        onRaiseBudget={async () => {}}
      />,
    );
    expect(screen.getByRole("list", { name: "Archivos adjuntos" }).textContent).toContain("spec.md");
  });
});
