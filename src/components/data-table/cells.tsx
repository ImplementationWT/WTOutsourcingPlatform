import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Select } from "@/components/ui/select";
import { optionsOf } from "@/components/ui/select-styles";
import { errorText, toast } from "@/lib/toast";
import { tableSelectClass } from "./DataTable";

/** Celda de relación: enlace navegable a otro registro (Deal, Proyecto, Contacto…). */
export function RelationCell({ to, children, muted }: { to?: string | null; children?: ReactNode; muted?: string }) {
  if (!to || !children) return <span className="text-muted-foreground">{muted ?? "—"}</span>;
  return (
    <Link to={to} className="text-primary underline-offset-4 hover:underline">
      {children}
    </Link>
  );
}

/** Varias relaciones en una celda (contactos de un deal, por ejemplo). */
export function RelationsCell({ items, href }: { items: { id: string; name: string | null }[]; href: (id: string) => string }) {
  if (!items.length) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex flex-wrap gap-x-2">
      {items.map((item) => (
        <RelationCell key={item.id} to={href(item.id)}>
          {item.name ?? "Sin nombre"}
        </RelationCell>
      ))}
    </span>
  );
}

const hoursFormat = (hours: number) => `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;

/** Celda de total: monto (centavos) u horas, alineada a la derecha y con cifras tabulares. */
export function TotalCell({ cents, hours, currency = "USD", strong }: { cents?: number | null; hours?: number | null; currency?: string; strong?: boolean }) {
  const text = hours !== undefined ? (hours === null ? "—" : hoursFormat(hours)) : formatMoney(cents ?? null, currency);
  return <span className={cn("tabular-nums whitespace-nowrap", strong && "font-medium", (hours ?? cents ?? 0) < 0 && "text-destructive")}>{text}</span>;
}

/**
 * Edición en la celda: el valor (p. ej. una insignia de estado) abre un menú ligero y guarda al
 * elegir; si falla, avisa con un Toast y vuelve al valor anterior. Sin permiso (`disabled`) solo
 * muestra el valor.
 */
export function InlineSelect<V extends string>({
  label,
  value,
  options,
  labels,
  onSave,
  disabled,
  display,
  allowEmpty,
}: {
  label: string;
  value: V | null;
  options: readonly V[];
  labels: Record<V, string> | Record<string, string>;
  onSave: (value: V | null) => Promise<unknown>;
  disabled?: boolean;
  display?: ReactNode;
  /** Texto de la opción vacía (p. ej. "Sin asignar"); sin él no se puede dejar vacío. */
  allowEmpty?: string;
}) {
  const [busy, setBusy] = useState(false);
  const text = (v: V | null) => (v ? ((labels as Record<string, string>)[v] ?? v) : (allowEmpty ?? "—"));
  if (disabled) return <>{display ?? text(value)}</>;
  return (
    <span data-cell-control className="inline-flex max-w-full">
      <Select
        label={label}
        value={value}
        options={optionsOf(options, labels)}
        emptyLabel={allowEmpty}
        disabled={busy}
        size="sm"
        className="-ml-1.5 w-auto max-w-56 gap-1 border-transparent bg-transparent px-1.5 shadow-none hover:border-input dark:bg-transparent [&_svg]:opacity-0 hover:[&_svg]:opacity-100 focus-visible:[&_svg]:opacity-100 data-popup-open:[&_svg]:opacity-100"
        renderValue={() => display ?? text(value)}
        onValueChange={async (next) => {
          const before = value;
          if (next === before) return;
          setBusy(true);
          try {
            await onSave(next as V | null);
            toast.success(`${label.split(" de ")[0]}: ${text(next as V | null)}`, { undo: () => onSave(before) });
          } catch (err) {
            toast.error("No se pudo guardar el cambio.", { description: errorText(err, "Inténtalo de nuevo.") });
          } finally {
            setBusy(false);
          }
        }}
      />
    </span>
  );
}

/** Edición en la celda de un número (horas): guarda al salir o con Enter; Escape descarta. */
export function InlineNumber({
  label,
  value,
  onSave,
  disabled,
  display,
  min = 0,
}: {
  label: string;
  value: number;
  onSave: (value: number) => Promise<unknown>;
  disabled?: boolean;
  display?: ReactNode;
  min?: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (disabled) return <>{display ?? value}</>;

  async function commit() {
    if (draft === null) return;
    const next = Number(draft.replace(",", "."));
    if (!Number.isFinite(next) || next < min) {
      setError(`Debe ser un número desde ${min}.`);
      setDraft(null);
      return;
    }
    if (next === value) return setDraft(null);
    setBusy(true);
    setError(null);
    try {
      await onSave(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setBusy(false);
      setDraft(null);
    }
  }

  return (
    <span data-cell-control className="inline-flex flex-col items-end">
      <input
        aria-label={label}
        inputMode="decimal"
        disabled={busy}
        className={cn(tableSelectClass, "h-7 w-20 text-right text-xs tabular-nums", error && "border-destructive")}
        value={draft ?? String(value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setDraft(null);
        }}
      />
      {error && (
        <span role="alert" className="mt-0.5 max-w-44 text-[11px] whitespace-normal text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}
