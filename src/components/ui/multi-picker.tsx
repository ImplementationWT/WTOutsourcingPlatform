import { X } from "lucide-react";
import { Select, type SelectOption } from "./select";

/**
 * Varios valores de una lista: cada elegido es una ficha que se quita con ✕ y un Select agrega
 * otro (hasta `max`). Guarda la lista completa en cada cambio.
 */
export function MultiPicker({
  label,
  values,
  options,
  onChange,
  max,
  min = 0,
  addLabel = "Agregar…",
  disabled,
}: {
  label: string;
  values: string[];
  options: readonly SelectOption[];
  onChange: (values: string[]) => void;
  max?: number;
  min?: number;
  addLabel?: string;
  disabled?: boolean;
}) {
  const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? "—";
  const free = options.filter((o) => !values.includes(o.value));
  const full = max !== undefined && values.length >= max;
  return (
    <div className="flex min-h-control flex-wrap items-center gap-1.5" role="group" aria-label={label}>
      {values.map((v) => (
        <span key={v} className="inline-flex h-8 items-center gap-1 rounded-full border border-border bg-muted/40 pr-1 pl-3 text-sm font-medium">
          {labelOf(v)}
          {!disabled && values.length > min && (
            <button type="button" aria-label={`Quitar ${labelOf(v)}`} onClick={() => onChange(values.filter((x) => x !== v))} className="inline-flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground">
              <X className="size-3.5" />
            </button>
          )}
        </span>
      ))}
      {!disabled && !full && free.length > 0 && (
        <div className="min-w-40 flex-1">
          <Select label={`${label}: agregar`} size="sm" value={null} placeholder={addLabel} options={free} onValueChange={(v) => v && onChange([...values, v])} />
        </div>
      )}
      {values.length === 0 && (disabled || free.length === 0) && <span className="text-sm text-muted-foreground">Sin asignar</span>}
    </div>
  );
}
