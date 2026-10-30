import { createContext, useContext } from "react";

export interface ConfirmRequest {
  title: string;
  /** Qué pasa o qué se pierde si se confirma. */
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
}

export const ConfirmContext = createContext<((request: ConfirmRequest) => Promise<boolean>) | null>(null);

/**
 * Confirmación con el diálogo del panel (en lugar de window.confirm). Devuelve true si la persona
 * confirma. Solo para acciones destructivas o irreversibles.
 */
export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm necesita <ConfirmProvider>.");
  return confirm;
}
