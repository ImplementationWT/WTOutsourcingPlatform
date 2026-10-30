import { Toast } from "@base-ui/react/toast";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import type { ReactNode } from "react";
import { toastManager } from "@/lib/toast";
import { cn } from "@/lib/utils";

const ICON: Record<string, ReactNode> = {
  success: <CircleCheck className="size-4 text-ok-fg" aria-hidden />,
  error: <CircleAlert className="size-4 text-danger-fg" aria-hidden />,
  info: <Info className="size-4 text-info-fg" aria-hidden />,
};

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((t) => (
    <Toast.Root
      key={t.id}
      toast={t}
      className={cn(
        "pointer-events-auto flex w-full items-start gap-3 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-popover",
        "transition-[opacity,transform] duration-200 data-ending-style:translate-y-2 data-ending-style:opacity-0 data-starting-style:translate-y-2 data-starting-style:opacity-0 motion-reduce:transition-none",
        t.type === "error" && "border-danger/40",
      )}
    >
      <span className="mt-0.5">{ICON[t.type ?? "info"]}</span>
      <div className="min-w-0 flex-1">
        <Toast.Title className="text-sm font-medium" />
        <Toast.Description className="mt-0.5 text-sm text-muted-foreground" />
      </div>
      <Toast.Action className="shrink-0 rounded-md px-2 py-1 text-sm font-medium text-primary hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring" />
      <Toast.Close aria-label="Cerrar aviso" className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground pointer-coarse:size-10">
        <X className="size-4" />
      </Toast.Close>
    </Toast.Root>
  ));
}

/** Zona de avisos (abajo a la derecha; en el celular, abajo a todo el ancho). */
export function Toaster({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider toastManager={toastManager} limit={4}>
      {children}
      <Toast.Portal>
        <Toast.Viewport className="pointer-events-none fixed right-4 bottom-4 left-4 z-[60] flex flex-col-reverse gap-2 sm:left-auto sm:w-96">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
