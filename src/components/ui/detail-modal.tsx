import type { ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Ventana grande de detalle (prototipo): ocupa casi toda la pantalla sobre la lista, con título,
 * chips, subtítulo, acciones y la «x» arriba; el cuerpo se desplaza. Esc o clic fuera la cierran.
 */
export function DetailModal({ title, badges, description, actions, onClose, children, bodyClassName }: { title: ReactNode; badges?: ReactNode; description?: ReactNode; actions?: ReactNode; onClose: () => void; children: ReactNode; bodyClassName?: string }) {
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup className="fixed inset-2 z-50 mx-auto flex max-w-[1320px] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-overlay outline-none sm:inset-x-6 sm:top-[46px] sm:bottom-[46px] lg:inset-x-[60px]">
          <div className="flex items-start gap-3 px-4 pt-5 pb-4 sm:px-8 sm:pt-8 sm:pb-5">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <Dialog.Title className="min-w-0 truncate text-2xl font-bold tracking-tight sm:text-[2rem]">{title}</Dialog.Title>
                {badges}
              </div>
              {description && <Dialog.Description render={<div />} className="font-subtitle mt-1.5 text-sm text-muted-foreground">{description}</Dialog.Description>}
            </div>
            {actions}
            <Dialog.Close aria-label="Cerrar" className="inline-flex size-11 shrink-0 items-center justify-center rounded-[10px] border border-border bg-card transition-colors hover:border-line-strong hover:bg-muted">
              <X className="size-5" />
            </Dialog.Close>
          </div>
          <div className={cn("min-h-0 flex-1 overflow-y-auto px-4 pb-6 sm:px-8 sm:pb-8", bodyClassName)}>{children}</div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Tarjeta del prototipo (`.card`): blanca, borde fino, radio 14 px. */
export function ProtoCard({ title, action, children, className, label }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; label?: string }) {
  return (
    <section aria-label={label ?? (typeof title === "string" ? title : undefined)} className={cn("rounded-[14px] border border-border bg-card", className)}>
      {(title || action) && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-5 sm:px-6">
          {title && <h3 className="text-lg font-bold">{title}</h3>}
          {action}
        </div>
      )}
      <div className="p-5 sm:p-6">{children}</div>
    </section>
  );
}
