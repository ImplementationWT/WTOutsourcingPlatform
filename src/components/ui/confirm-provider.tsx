import { useCallback, useRef, useState, type ReactNode } from "react";
import { ConfirmContext, type ConfirmRequest } from "./confirm-context";
import { ConfirmDialog } from "./dialog";

/** Monta un único diálogo de confirmación para toda la app (ver useConfirm). */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const confirm = useCallback(
    (next: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        resolver.current?.(false);
        resolver.current = resolve;
        setRequest(next);
      }),
    [],
  );
  const settle = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setRequest(null);
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmDialog
        open={request !== null}
        onOpenChange={(open) => !open && settle(false)}
        title={request?.title ?? ""}
        description={request?.description}
        confirmLabel={request?.confirmLabel}
        cancelLabel={request?.cancelLabel}
        tone={request?.tone}
        onConfirm={() => settle(true)}
      />
    </ConfirmContext.Provider>
  );
}
