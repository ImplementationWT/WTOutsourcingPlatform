import { useRef, useState } from "react";
import { Download, Loader2, Paperclip, X } from "lucide-react";
import { useConfirm } from "@/components/ui/confirm-context";
import { cn } from "@/lib/utils";

/**
 * Campo «Subir …» (prototipo): abre el selector de archivos de la computadora. Con archivo, muestra
 * su nombre (descarga al hacer clic) y la «x» para quitarlo.
 */
export function FileField({ label, emptyText, file, href, disabled, onUpload, onRemove, className }: { label: string; emptyText: string; file: { name: string } | null | undefined; href: string; disabled?: boolean; onUpload: (file: File) => Promise<unknown>; onRemove: () => Promise<unknown>; className?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const base = "flex h-10 min-w-0 flex-1 items-center gap-2 rounded-[10px] border border-border bg-card px-3 text-sm";
  return (
    <div className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <input
        ref={input}
        type="file"
        className="hidden"
        aria-label={label}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void run(() => onUpload(f));
        }}
      />
      {file ? (
        <a href={href} className={cn(base, "font-semibold hover:border-line-strong hover:bg-muted")} title={`Descargar ${file.name}`}>
          {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : <Download className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
          <span className="truncate">{file.name}</span>
        </a>
      ) : (
        <button type="button" disabled={disabled || busy} onClick={() => input.current?.click()} className={cn(base, "font-semibold transition-colors enabled:hover:border-line-strong enabled:hover:bg-muted disabled:text-muted-foreground")}>
          {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : <Paperclip className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
          <span className="truncate">{emptyText}</span>
        </button>
      )}
      {file && !disabled && (
        <button
          type="button"
          aria-label={`Quitar ${file.name}`}
          title="Quitar el archivo"
          disabled={busy}
          onClick={async () => {
            if (await confirm({ title: `¿Quitar «${file.name}»?`, description: "Se borra el archivo subido.", confirmLabel: "Quitar", tone: "danger" })) void run(onRemove);
          }}
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-[10px] border border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}
