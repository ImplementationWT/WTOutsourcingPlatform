import { Toast } from "@base-ui/react/toast";

/** Un solo gestor de avisos para toda la app (se puede usar fuera de React). */
export const toastManager = Toast.createToastManager();

interface ToastOptions {
  description?: string;
  /** Acción para revertir el cambio ("Deshacer"). */
  undo?: () => void | Promise<unknown>;
}

function add(type: "success" | "error" | "info", title: string, { description, undo }: ToastOptions = {}) {
  const id = toastManager.add({
    title,
    description,
    type,
    priority: type === "error" ? "high" : "low",
    timeout: type === "error" ? 8000 : undo ? 6000 : 3500,
    ...(undo
      ? {
          actionProps: {
            children: "Deshacer",
            onClick: () => {
              toastManager.close(id);
              void Promise.resolve(undo()).catch((err: unknown) => toast.error("No se pudo deshacer.", { description: err instanceof Error ? err.message : undefined }));
            },
          },
        }
      : {}),
  });
  return id;
}

/** Avisos breves de éxito y error de cada acción. */
export const toast = {
  success: (title: string, options?: ToastOptions) => add("success", title, options),
  error: (title: string, options?: ToastOptions) => add("error", title, options),
  info: (title: string, options?: ToastOptions) => add("info", title, options),
};

/** Mensaje de un error de la API (o el texto por defecto). */
export const errorText = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback);
