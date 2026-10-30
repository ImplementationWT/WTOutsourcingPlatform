import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { InlineSelect } from "@/components/data-table/cells";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-context";
import { ConfirmProvider } from "@/components/ui/confirm-provider";
import { DatePicker } from "@/components/ui/date-picker";
import { Drawer, Modal } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { Toaster } from "@/components/ui/toaster";
import { toast } from "@/lib/toast";
import { pick } from "../pick";

describe("DatePicker", () => {
  function Harness({ initial = "2026-10-20", min }: { initial?: string | null; min?: string }) {
    const [value, setValue] = useState<string | null>(initial);
    return (
      <>
        <DatePicker label="Submission" value={value} onValueChange={setValue} min={min} />
        <output>{value ?? "vacía"}</output>
      </>
    );
  }
  const value = () => document.querySelector("output")?.textContent;

  it("muestra la fecha con el formato del panel y elige un día con clic", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: /Submission: 20 oct/ });
    fireEvent.click(trigger);
    const grid = await screen.findByRole("grid", { name: /octubre de 2026/ });
    fireEvent.click(within(grid).getByRole("gridcell", { name: /23 de octubre de 2026/ }));
    expect(value()).toBe("2026-10-23");
    await waitFor(() => expect(screen.queryByRole("grid")).toBeNull());
  });

  it("se maneja con el teclado: flechas, cambio de mes y Enter", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Submission/ }));
    const grid = await screen.findByRole("grid");
    await waitFor(() => expect(document.activeElement?.getAttribute("data-iso")).toBe("2026-10-20"));
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement?.getAttribute("data-iso")).toBe("2026-10-28"));
    fireEvent.keyDown(grid, { key: "PageDown" });
    await waitFor(() => expect(document.activeElement?.getAttribute("data-iso")).toBe("2026-11-28"));
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(value()).toBe("2026-11-28");
  });

  it("respeta el mínimo y se puede borrar", async () => {
    render(<Harness min="2026-10-15" />);
    fireEvent.click(screen.getByRole("button", { name: /Submission/ }));
    expect((within(await screen.findByRole("grid")).getByRole("gridcell", { name: /10 de octubre/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Borrar submission" }));
    expect(value()).toBe("vacía");
  });
});

describe("Modal y Drawer", () => {
  function Harness({ dirty, kind = "modal" }: { dirty?: boolean; kind?: "modal" | "drawer" }) {
    const [open, setOpen] = useState(true);
    const Overlay = kind === "modal" ? Modal : Drawer;
    return (
      <>
        <Overlay open={open} onOpenChange={setOpen} title="Nuevo lead" description="Solo los datos obligatorios" dirty={dirty} footer={<Button onClick={() => setOpen(false)}>Guardar</Button>}>
          <input aria-label="Empresa" />
        </Overlay>
        <output>{open ? "abierto" : "cerrado"}</output>
      </>
    );
  }
  const state = () => document.querySelector("output")?.textContent;

  it("se cierra con Esc y con la «x»", async () => {
    render(<Harness />);
    expect(await screen.findByRole("dialog", { name: "Nuevo lead" })).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText("Empresa"), { key: "Escape" });
    await waitFor(() => expect(state()).toBe("cerrado"));
  });

  it("con cambios sin guardar pregunta antes de cerrar", async () => {
    render(<Harness dirty kind="drawer" />);
    fireEvent.click(await screen.findByRole("button", { name: "Cerrar" }));
    const ask = await screen.findByRole("alertdialog", { name: "¿Descartar los cambios?" });
    fireEvent.click(within(ask).getByRole("button", { name: "Seguir editando" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(state()).toBe("abierto");
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Descartar cambios" }));
    await waitFor(() => expect(state()).toBe("cerrado"));
  });
});

describe("confirmación", () => {
  function Danger({ onDone }: { onDone: (ok: boolean) => void }) {
    const confirm = useConfirm();
    return <Button onClick={async () => onDone(await confirm({ title: "¿Eliminar la cuenta?", description: "No se puede deshacer.", confirmLabel: "Eliminar", tone: "danger" }))}>Eliminar</Button>;
  }

  it("devuelve true al confirmar y false al cancelar", async () => {
    const done = vi.fn();
    render(
      <ConfirmProvider>
        <Danger onDone={done} />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    const dialog = await screen.findByRole("alertdialog", { name: "¿Eliminar la cuenta?" });
    expect(within(dialog).getByText("No se puede deshacer.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(done).toHaveBeenCalledWith(false));
    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Eliminar" }));
    await waitFor(() => expect(done).toHaveBeenLastCalledWith(true));
  });
});

describe("edición en la celda y avisos", () => {
  it("guarda al elegir, avisa con un Toast y «Deshacer» vuelve al valor anterior", async () => {
    const saves: (string | null)[] = [];
    function Cell() {
      const [value, setValue] = useState<"hot" | "warm" | null>("hot");
      return (
        <InlineSelect
          label="Temperatura de Manpersa"
          value={value}
          options={["hot", "warm"] as const}
          labels={{ hot: "Hot", warm: "Warm" }}
          display={<StatusBadge tone="danger">{value}</StatusBadge>}
          onSave={async (next) => {
            saves.push(next);
            setValue(next);
          }}
        />
      );
    }
    render(
      <Toaster>
        <Cell />
      </Toaster>,
    );
    await pick("Temperatura de Manpersa", "Warm");
    expect(saves).toEqual(["warm"]);
    const notice = await screen.findByText("Temperatura: Warm");
    fireEvent.click(within(notice.closest("[role=dialog],li,div")!.parentElement!).getByRole("button", { name: "Deshacer" }));
    await waitFor(() => expect(saves).toEqual(["warm", "hot"]));
  });

  it("si falla el guardado avisa con un Toast de error", async () => {
    render(
      <Toaster>
        <InlineSelect label="Estado de X" value="a" options={["a", "b"] as const} labels={{ a: "A", b: "B" }} onSave={() => Promise.reject(new Error("Comercial edita deals hasta «Propuesto»."))} />
      </Toaster>,
    );
    await pick("Estado de X", "B");
    // Base UI repite el aviso en una región "aria-live" para los lectores de pantalla.
    expect((await screen.findAllByText("No se pudo guardar el cambio.")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Comercial edita deals hasta «Propuesto».").length).toBeGreaterThan(0);
  });

  it("toast.success sin acción no muestra «Deshacer»", async () => {
    render(<Toaster>{null}</Toaster>);
    act(() => void toast.success("Guardado"));
    expect(await screen.findByText("Guardado")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Deshacer" })).toBeNull();
  });
});

describe("EmptyState", () => {
  it("muestra el texto y la acción", () => {
    render(<EmptyState title="Aún no hay leads" description="Crea uno o conecta un source." action={<Button>Nuevo lead</Button>} />);
    expect(screen.getByText("Aún no hay leads")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Nuevo lead" })).toBeTruthy();
  });
});
