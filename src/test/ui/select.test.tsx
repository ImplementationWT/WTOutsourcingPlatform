import { useState } from "react";
import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Select, type SelectOption } from "@/components/ui/select";
import { pick, press } from "../pick";

const few: SelectOption[] = [
  { value: "hot", label: "Hot" },
  { value: "warm", label: "Warm" },
];
const many: SelectOption[] = Array.from({ length: 10 }, (_, i) => ({ value: `u${i}`, label: `Persona ${i}` }));

function Harness({ options, emptyLabel, disabled }: { options: SelectOption[]; emptyLabel?: string; disabled?: boolean }) {
  const [value, setValue] = useState<string | null>(options[0].value);
  return (
    <>
      <Select label="Temperatura" value={value} onValueChange={setValue} options={options} emptyLabel={emptyLabel} disabled={disabled} />
      <output>{value ?? "vacío"}</output>
    </>
  );
}

describe("Select", () => {
  it("muestra el valor y elige otra opción", async () => {
    render(<Harness options={few} emptyLabel="Sin definir" />);
    expect(screen.getByRole("combobox", { name: "Temperatura" }).textContent).toContain("Hot");
    await pick("Temperatura", "Warm");
    expect(document.querySelector("output")?.textContent).toBe("warm");
  });

  it("la opción vacía deja el valor en null", async () => {
    render(<Harness options={few} emptyLabel="Sin definir" />);
    await pick("Temperatura", "Sin definir");
    expect(document.querySelector("output")?.textContent).toBe("vacío");
  });

  it("con muchas opciones busca dentro del panel", async () => {
    render(<Harness options={many} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Temperatura" }));
    fireEvent.change(await screen.findByLabelText("Buscar en Temperatura"), { target: { value: "Persona 7" } });
    await waitFor(() => expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Persona 7"]));
    await act(async () => press(screen.getByRole("option", { name: "Persona 7" })));
    expect(document.querySelector("output")?.textContent).toBe("u7");
  });

  it("deshabilitado no abre", () => {
    render(<Harness options={few} disabled />);
    fireEvent.click(screen.getByRole("combobox", { name: "Temperatura" }));
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
