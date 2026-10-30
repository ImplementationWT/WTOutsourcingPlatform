import { act, fireEvent, screen, within } from "@testing-library/react";

/** Clic como en el navegador: Base UI elige en el puntero (pointerdown → mouseup → click). */
export function press(element: Element) {
  fireEvent.pointerDown(element, { pointerType: "mouse", button: 0 });
  fireEvent.mouseDown(element, { button: 0 });
  fireEvent.pointerUp(element, { pointerType: "mouse", button: 0 });
  fireEvent.mouseUp(element, { button: 0 });
  fireEvent.click(element, { button: 0 });
}

/** Abre un Select del panel (por su nombre accesible o el elemento) y devuelve las opciones visibles. */
export async function openSelect(trigger: string | RegExp | HTMLElement) {
  const element = typeof trigger === "string" || trigger instanceof RegExp ? await screen.findByRole("combobox", { name: trigger }) : trigger;
  await act(async () => fireEvent.click(element));
  const listbox = await screen.findByRole("listbox");
  return within(listbox).getAllByRole("option");
}

/** Elige una opción de un Select del panel. */
export async function pick(trigger: string | RegExp | HTMLElement, option: string | RegExp) {
  await openSelect(trigger);
  const target = await screen.findByRole("option", { name: option });
  await act(async () => press(target));
}

/** Texto de las opciones de un Select (lo abre y lo vuelve a cerrar con Escape). */
export async function optionLabels(trigger: string | RegExp | HTMLElement) {
  const options = await openSelect(trigger);
  const labels = options.map((o) => o.textContent ?? "");
  await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
  return labels;
}
