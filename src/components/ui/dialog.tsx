import * as React from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

const backdropClass =
  "fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none";

interface OverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  /** Botones del pie (a la derecha); en el celular quedan a todo el ancho. */
  footer?: React.ReactNode;
  /**
   * Hay cambios sin guardar: cerrar (Esc, clic fuera o la "x") pide confirmación antes de
   * descartarlos.
   */
  dirty?: boolean;
  className?: string;
}

/** Pregunta antes de cerrar si hay cambios sin guardar. */
function useGuardedClose(onOpenChange: (open: boolean) => void, dirty?: boolean) {
  const [asking, setAsking] = React.useState(false);
  const request = (next: boolean) => {
    if (!next && dirty) setAsking(true);
    else onOpenChange(next);
  };
  const guard = (
    <ConfirmDialog
      open={asking}
      onOpenChange={setAsking}
      title="¿Descartar los cambios?"
      description="Tienes cambios sin guardar. Si cierras, se pierden."
      confirmLabel="Descartar cambios"
      cancelLabel="Seguir editando"
      tone="danger"
      onConfirm={() => {
        setAsking(false);
        onOpenChange(false);
      }}
    />
  );
  return { request, guard };
}

function Header({ title, description, onClose }: { title: React.ReactNode; description?: React.ReactNode; onClose: () => void }) {
  return (
    <div className="flex items-start gap-3 border-b border-border px-5 py-4">
      <div className="min-w-0 flex-1">
        <Dialog.Title className="text-section-title">{title}</Dialog.Title>
        {description && <Dialog.Description className="mt-1 text-sm text-muted-foreground">{description}</Dialog.Description>}
      </div>
      <Button size="icon-sm" variant="ghost" aria-label="Cerrar" onClick={onClose}>
        <X />
      </Button>
    </div>
  );
}

/**
 * Ventana modal: foco atrapado, cierre con Esc o clic fuera, y confirmación si hay cambios sin
 * guardar (`dirty`). En el celular ocupa casi toda la pantalla.
 */
export function Modal({ open, onOpenChange, title, description, children, footer, dirty, className }: OverlayProps) {
  const { request, guard } = useGuardedClose(onOpenChange, dirty);
  return (
    <Dialog.Root open={open} onOpenChange={request}>
      <Dialog.Portal>
        <Dialog.Backdrop className={backdropClass} />
        <Dialog.Popup
          className={cn(
            "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-overlay outline-none",
            "transition-[opacity,scale] duration-200 data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0 motion-reduce:transition-none",
            className,
          )}
        >
          <Header title={title} description={description} onClose={() => request(false)} />
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-col-reverse gap-2 border-t border-border px-5 py-3 sm:flex-row sm:justify-end [&>*]:w-full sm:[&>*]:w-auto">{footer}</div>}
        </Dialog.Popup>
      </Dialog.Portal>
      {guard}
    </Dialog.Root>
  );
}

/**
 * Panel lateral (detalle rápido, crear/editar sin salir de la tabla): mismo comportamiento que
 * Modal, entra desde la derecha y en el celular ocupa todo el ancho.
 */
export function Drawer({ open, onOpenChange, title, description, children, footer, dirty, className }: OverlayProps) {
  const { request, guard } = useGuardedClose(onOpenChange, dirty);
  return (
    <Dialog.Root open={open} onOpenChange={request}>
      <Dialog.Portal>
        <Dialog.Backdrop className={backdropClass} />
        <Dialog.Popup
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-border bg-popover text-popover-foreground shadow-overlay outline-none",
            "transition-transform duration-200 ease-out data-ending-style:translate-x-full data-starting-style:translate-x-full motion-reduce:transition-none",
            className,
          )}
        >
          <Header title={title} description={description} onClose={() => request(false)} />
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
        </Dialog.Popup>
      </Dialog.Portal>
      {guard}
    </Dialog.Root>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  /** Qué pasa o qué se pierde si se confirma. */
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` para acciones destructivas o irreversibles. */
  tone?: "default" | "danger";
  onConfirm: () => void | Promise<void>;
}

/** Confirmación (reemplaza a window.confirm): solo para acciones destructivas o irreversibles. */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel = "Confirmar", cancelLabel = "Cancelar", tone = "default", onConfirm }: ConfirmDialogProps) {
  const [busy, setBusy] = React.useState(false);
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className={backdropClass} />
        <AlertDialog.Popup className="fixed top-1/2 left-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-overlay outline-none transition-[opacity,scale] duration-200 data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0 motion-reduce:transition-none">
          <AlertDialog.Title className="text-section-title">{title}</AlertDialog.Title>
          {description && <AlertDialog.Description className="mt-2 text-sm whitespace-pre-line text-muted-foreground">{description}</AlertDialog.Description>}
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <AlertDialog.Close render={<Button variant="ghost" disabled={busy} />}>{cancelLabel}</AlertDialog.Close>
            <Button
              variant={tone === "danger" ? "destructive" : "default"}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onConfirm();
                } finally {
                  setBusy(false);
                }
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
