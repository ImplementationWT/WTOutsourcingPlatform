import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { errorText, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * Campo que se edita en el lugar: parece texto hasta que se pasa el cursor o se enfoca, y guarda
 * al salir o con Enter (Escape descarta). Un aviso confirma "Guardado" o explica el error.
 */
export function EditableText({
  id,
  label,
  value,
  onSave,
  placeholder,
  multiline,
  type = "text",
  disabled,
  className,
  minLength = 0,
}: {
  id?: string;
  label: string;
  value: string | null;
  onSave: (value: string | null) => Promise<unknown>;
  placeholder?: string;
  multiline?: boolean;
  type?: "text" | "email" | "tel" | "url";
  disabled?: boolean;
  className?: string;
  /** Largo mínimo (si no se cumple, no guarda y avisa). */
  minLength?: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = draft ?? value ?? "";

  async function commit() {
    if (draft === null) return;
    const next = draft.trim() || null;
    setDraft(null);
    if (next === (value ?? null)) return;
    if (next && next.length < minLength) {
      toast.error(`${label}: muy corto.`, { description: `Escribe al menos ${minLength} caracteres.` });
      return;
    }
    setBusy(true);
    try {
      await onSave(next);
    } catch (err) {
      toast.error(`No se pudo guardar ${label.toLowerCase()}.`, { description: errorText(err, "Inténtalo de nuevo.") });
    } finally {
      setBusy(false);
    }
  }

  const base = cn(
    "w-full min-w-0 rounded-md border border-transparent bg-transparent px-2 text-sm outline-none transition-colors placeholder:text-muted-foreground/70",
    "hover:border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-100",
    busy && "opacity-60",
    className,
  );
  const common = {
    id,
    "aria-label": label,
    value: shown,
    placeholder: disabled ? "—" : placeholder,
    disabled: disabled || busy,
    onBlur: () => void commit(),
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === "Escape") setDraft(null);
      if (e.key === "Enter" && !multiline) e.currentTarget.blur();
    },
  };
  return multiline ? (
    <textarea {...common} rows={3} className={cn(base, "resize-y py-1.5")} onChange={(e) => setDraft(e.target.value)} />
  ) : (
    <input {...common} type={type} className={cn(base, "h-control")} onChange={(e) => setDraft(e.target.value)} />
  );
}

/** Copia un texto (correo, teléfono) y lo confirma. */
export function CopyButton({ value, label, text }: { value: string; label: string; /** Muestra «Copiar» junto al icono. */ text?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copiar ${label}`}
      title={`Copiar ${label}`}
      className={cn(
        "inline-flex shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        text ? "h-6 gap-1 rounded-md border border-border px-2 text-xs font-medium pointer-coarse:h-9" : "size-7 rounded-md pointer-coarse:size-10",
      )}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          toast.success(`${label} copiado`);
          window.setTimeout(() => setDone(false), 1500);
        } catch {
          toast.error("No se pudo copiar.", { description: value });
        }
      }}
    >
      {text ? (done ? "Copiado" : "Copiar") : done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

/** Fila etiqueta + valor de una sección de detalle (2 columnas en escritorio, 1 en el celular). */
export function FieldRow({ label, htmlFor, children, hint }: { label: string; htmlFor?: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center">
      <label htmlFor={htmlFor} className="text-field-label">
        {label}
      </label>
      <div className="min-w-0">
        {children}
        {hint && <div className="mt-1 px-2">{hint}</div>}
      </div>
    </div>
  );
}
