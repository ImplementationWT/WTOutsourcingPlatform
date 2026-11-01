import { Toast } from "@base-ui/react/toast";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { toastManager } from "@/lib/toast";
import { cn } from "@/lib/utils";

const DOT: Record<string, string> = {
  success: "bg-ok",
  error: "bg-danger",
  info: "bg-info",
};

/**
 * Aviso compacto: punto de color, texto y la acción («Deshacer») subrayada en rojo. En claro va
 * oscuro (resalta sobre el fondo claro); en oscuro, sobre la superficie del panel.
 */
function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((t) => (
    <Toast.Root
      key={t.id}
      toast={t}
      className={cn(
        "pointer-events-auto flex w-full items-center gap-3 rounded-xl border px-4 py-3 shadow-popover sm:w-auto sm:max-w-md",
        "border-transparent bg-[#16161b] text-white dark:border-border dark:bg-popover dark:text-popover-foreground",
        "transition-[opacity,transform] duration-200 data-ending-style:translate-y-2 data-ending-style:opacity-0 data-starting-style:translate-y-2 data-starting-style:opacity-0 motion-reduce:transition-none",
      )}
    >
      <span aria-hidden className={cn("size-2 shrink-0 self-start rounded-full mt-1.5", DOT[t.type ?? "info"])} />
      <div className="min-w-0 flex-1">
        <Toast.Title className="text-sm font-medium" />
        <Toast.Description className="mt-0.5 text-sm text-white/65 dark:text-muted-foreground" />
      </div>
      <Toast.Action className="shrink-0 rounded-md px-1 text-sm font-semibold text-[#ff6b84] underline underline-offset-4 hover:text-[#ff8fa2] focus-visible:ring-2 focus-visible:ring-ring dark:text-primary" />
      <Toast.Close aria-label="Cerrar aviso" className="-mr-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-white/50 hover:bg-white/10 hover:text-white dark:text-muted-foreground dark:hover:bg-accent dark:hover:text-foreground pointer-coarse:size-10">
        <X className="size-4" />
      </Toast.Close>
    </Toast.Root>
  ));
}

/** Zona de avisos (abajo, junto al contenido; en el celular, sobre la barra inferior). */
export function Toaster({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider toastManager={toastManager} limit={4}>
      {children}
      <Toast.Portal>
        <Toast.Viewport className="pointer-events-none fixed right-4 bottom-20 left-4 z-[60] flex flex-col-reverse items-start gap-2 lg:right-auto lg:bottom-6 lg:left-[18rem]">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
