import * as React from "react";
import { Popover } from "@base-ui/react/popover";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import { LOCALE } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Select } from "./select";
import { popupClass, triggerClass } from "./select-styles";

// Fechas como texto "AAAA-MM-DD" (el mismo formato que guarda la API), sin zonas horarias.
const pad = (n: number) => String(n).padStart(2, "0");
const toIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromIso = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
};
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12);
const addMonths = (d: Date, n: number) => {
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1, 12);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), last), 12);
};
const isValidIso = (v: string | null | undefined): v is string => Boolean(v && /^\d{4}-\d{2}-\d{2}$/.test(v));

const monthFormat = new Intl.DateTimeFormat(LOCALE, { month: "long", year: "numeric" });
const dayFormat = new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short", year: "numeric" });
const fullFormat = new Intl.DateTimeFormat(LOCALE, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
/** Semana de lunes a domingo. */
const WEEKDAYS = ["L", "M", "X", "J", "V", "S", "D"];

export interface DatePickerProps {
  id?: string;
  /** Nombre accesible si no hay un <Label htmlFor> apuntando a `id`. */
  label?: string;
  value: string | null;
  onValueChange: (value: string | null) => void;
  min?: string;
  max?: string;
  placeholder?: string;
  /** Muestra la "x" para dejar la fecha vacía. */
  clearable?: boolean;
  disabled?: boolean;
  size?: "sm" | "default";
  className?: string;
}

function Calendar({ value, min, max, onPick }: { value: string | null; min?: string; max?: string; onPick: (iso: string) => void }) {
  const today = toIso(new Date());
  const [focused, setFocused] = React.useState<Date>(() => fromIso(isValidIso(value) ? value : today));
  const gridRef = React.useRef<HTMLDivElement>(null);
  const month = new Date(focused.getFullYear(), focused.getMonth(), 1, 12);
  // Lunes de la semana del día 1.
  const start = addDays(month, -((month.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const outOfRange = (iso: string) => Boolean((min && iso < min) || (max && iso > max));

  React.useEffect(() => {
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-iso="${toIso(focused)}"]`)?.focus();
  }, [focused]);

  function onKeyDown(e: React.KeyboardEvent) {
    const moves: Record<string, () => Date> = {
      ArrowLeft: () => addDays(focused, -1),
      ArrowRight: () => addDays(focused, 1),
      ArrowUp: () => addDays(focused, -7),
      ArrowDown: () => addDays(focused, 7),
      PageUp: () => addMonths(focused, e.shiftKey ? -12 : -1),
      PageDown: () => addMonths(focused, e.shiftKey ? 12 : 1),
      Home: () => addDays(focused, -((focused.getDay() + 6) % 7)),
      End: () => addDays(focused, 6 - ((focused.getDay() + 6) % 7)),
    };
    if (moves[e.key]) {
      e.preventDefault();
      setFocused(moves[e.key]());
    }
  }

  return (
    <div className="w-[17.5rem] p-3">
      <div className="mb-2 flex items-center justify-between">
        <button type="button" aria-label="Mes anterior" className="inline-flex size-control-sm items-center justify-center rounded-md hover:bg-accent" onClick={() => setFocused(addMonths(focused, -1))}>
          <ChevronLeft className="size-4" />
        </button>
        <p className="text-sm font-medium capitalize" aria-live="polite">
          {monthFormat.format(month)}
        </p>
        <button type="button" aria-label="Mes siguiente" className="inline-flex size-control-sm items-center justify-center rounded-md hover:bg-accent" onClick={() => setFocused(addMonths(focused, 1))}>
          <ChevronRight className="size-4" />
        </button>
      </div>
      <div role="grid" aria-label={monthFormat.format(month)} ref={gridRef} onKeyDown={onKeyDown} className="grid grid-cols-7 gap-0.5 text-center">
        {WEEKDAYS.map((d) => (
          <span key={d} role="columnheader" className="py-1 text-[11px] font-medium text-muted-foreground">
            {d}
          </span>
        ))}
        {days.map((d) => {
          const iso = toIso(d);
          const inMonth = d.getMonth() === month.getMonth();
          const selected = iso === value;
          const isFocused = iso === toIso(focused);
          const disabled = outOfRange(iso);
          return (
            <button
              key={iso}
              type="button"
              role="gridcell"
              data-iso={iso}
              tabIndex={isFocused ? 0 : -1}
              aria-selected={selected}
              aria-label={fullFormat.format(d)}
              aria-current={iso === today ? "date" : undefined}
              disabled={disabled}
              onClick={() => onPick(iso)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (!disabled) onPick(iso);
                }
              }}
              className={cn(
                "inline-flex size-9 items-center justify-center rounded-md text-sm tabular-nums outline-none transition-colors pointer-coarse:size-10",
                "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30",
                !inMonth && "text-muted-foreground/60",
                iso === today && !selected && "font-semibold text-primary",
                selected && "bg-primary font-medium text-primary-foreground hover:bg-primary/90",
              )}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between border-t border-border pt-2">
        <button type="button" className="rounded-md px-2 py-1 text-xs text-primary hover:bg-accent disabled:opacity-40" disabled={outOfRange(today)} onClick={() => onPick(today)}>
          Hoy
        </button>
        <span className="self-center text-[11px] text-muted-foreground">Flechas para moverte · Enter para elegir</span>
      </div>
    </div>
  );
}

/**
 * Selector de fecha propio (reemplaza a <input type="date">): calendario con teclado, semana de
 * lunes a domingo y el formato de fechas del panel. Valor "AAAA-MM-DD" o null.
 */
export function DatePicker({ id, label, value, onValueChange, min, max, placeholder = "Elige una fecha", clearable = true, disabled, size = "default", className }: DatePickerProps) {
  const [open, setOpen] = React.useState(false);
  const current = isValidIso(value) ? value : null;
  return (
    <div className={cn("relative w-full min-w-0", className)}>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          id={id}
          aria-label={label ? `${label}${current ? `: ${dayFormat.format(fromIso(current))}` : ""}` : undefined}
          disabled={disabled}
          className={cn(triggerClass(size), "justify-start", clearable && current && "pr-9")}
        >
          <CalendarDays className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className={cn("min-w-0 flex-1 truncate", !current && "text-muted-foreground")}>{current ? dayFormat.format(fromIso(current)) : placeholder}</span>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner sideOffset={4} align="start" className="z-50">
            <Popover.Popup className={cn(popupClass, "min-w-0")} aria-label={label ?? "Calendario"}>
              <Calendar
                value={current}
                min={min}
                max={max}
                onPick={(iso) => {
                  onValueChange(iso);
                  setOpen(false);
                }}
              />
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {clearable && current && !disabled && (
        <button
          type="button"
          aria-label={label ? `Borrar ${label.toLowerCase()}` : "Borrar fecha"}
          onClick={() => onValueChange(null)}
          className="absolute top-1/2 right-1.5 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground pointer-coarse:size-9"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

const TIMES = Array.from({ length: 96 }, (_, i) => `${pad(Math.floor(i / 4))}:${pad((i % 4) * 15)}`);
const TIME_OPTIONS = TIMES.map((t) => ({ value: t, label: t }));

/**
 * Fecha y hora (reemplaza a <input type="datetime-local">): calendario + hora cada 15 minutos.
 * Valor "AAAA-MM-DDTHH:mm" en hora local, o "" si falta la fecha.
 */
export function DateTimePicker({ id, label, value, onValueChange, disabled }: { id?: string; label: string; value: string; onValueChange: (value: string) => void; disabled?: boolean }) {
  const [date, time] = value ? value.split("T") : ["", ""];
  const hhmm = time ? time.slice(0, 5) : "09:00";
  const options = TIMES.includes(hhmm) ? TIME_OPTIONS : [{ value: hhmm, label: hhmm }, ...TIME_OPTIONS];
  return (
    <div className="flex min-w-0 gap-2">
      <DatePicker id={id} label={label} value={date || null} clearable={false} disabled={disabled} onValueChange={(d) => onValueChange(d ? `${d}T${hhmm}` : "")} className="flex-1" />
      <Select label={`Hora de ${label.toLowerCase()}`} value={hhmm} options={options} searchable disabled={disabled} className="w-24 shrink-0" onValueChange={(t) => t && onValueChange(`${date || toIso(new Date())}T${t}`)} />
    </div>
  );
}
