import * as React from "react";
import { Combobox } from "@base-ui/react/combobox";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { itemClass, popupClass, triggerClass, type SelectOption } from "./select-styles";

export interface SelectProps {
  /** Nombre accesible si no hay un <Label htmlFor> apuntando a `id`. */
  label?: string;
  id?: string;
  value: string | null;
  onValueChange: (value: string | null) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  /** Agrega una opción vacía (p. ej. "Sin asignar") que deja el valor en null. */
  emptyLabel?: string;
  /** Con buscador dentro del panel; por defecto, cuando hay más de 7 opciones. */
  searchable?: boolean;
  disabled?: boolean;
  size?: "sm" | "default";
  className?: string;
  /** Contenido del botón en lugar de la etiqueta (p. ej. un Badge de estado). */
  renderValue?: (option: SelectOption | null) => React.ReactNode;
  "aria-invalid"?: boolean;
}

const EMPTY = "__empty__";

export type { SelectOption };

function OptionText({ option }: { option: SelectOption }) {
  return (
    <span className="col-start-2 min-w-0">
      <span className="block truncate">{option.label}</span>
      {option.description && <span className="block truncate text-xs text-muted-foreground">{option.description}</span>}
    </span>
  );
}

/**
 * Select propio del panel (reemplaza al <select> nativo): teclado, búsqueda cuando la lista es
 * larga y el mismo alto que el resto de controles. El valor siempre es un string o null.
 */
export function Select({
  label,
  id,
  value,
  onValueChange,
  options,
  placeholder = "Elige una opción",
  emptyLabel,
  searchable,
  disabled,
  size = "default",
  className,
  renderValue,
  "aria-invalid": invalid,
}: SelectProps) {
  const all = React.useMemo<SelectOption[]>(() => (emptyLabel !== undefined ? [{ value: EMPTY, label: emptyLabel }, ...options] : [...options]), [options, emptyLabel]);
  const selected = all.find((o) => o.value === (value ?? EMPTY)) ?? null;
  const shown = renderValue ? renderValue(selected && selected.value !== EMPTY ? selected : null) : null;
  const text = selected ? selected.label : placeholder;
  const change = (next: string | null) => onValueChange(next === null || next === EMPTY ? null : next);
  const useSearch = searchable ?? options.length > 7;

  if (useSearch) {
    return (
      <Combobox.Root
        items={all}
        value={selected}
        onValueChange={(item: SelectOption | null) => item && change(item.value)}
        itemToStringLabel={(item: SelectOption) => item.label}
        isItemEqualToValue={(a: SelectOption, b: SelectOption) => a.value === b.value}
        disabled={disabled}
      >
        <Combobox.Trigger id={id} aria-label={label} aria-invalid={invalid} className={cn(triggerClass(size), className)}>
          <span className={cn("min-w-0 flex-1 truncate", !selected && "text-muted-foreground")}>{shown ?? text}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </Combobox.Trigger>
        <Combobox.Portal>
          <Combobox.Positioner align="start" sideOffset={4} className="z-50">
            <Combobox.Popup className={popupClass} aria-label={label}>
              <div className="flex items-center gap-2 border-b border-border px-2.5">
                <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <Combobox.Input placeholder="Buscar…" aria-label={`Buscar en ${label ?? "la lista"}`} className="h-control w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
              </div>
              <Combobox.Empty>
                <p className="px-3 py-4 text-sm text-muted-foreground">Sin resultados.</p>
              </Combobox.Empty>
              <Combobox.List className="max-h-[min(18rem,calc(var(--available-height)-3rem))] overflow-y-auto overscroll-contain p-1 empty:p-0">
                {(option: SelectOption) => (
                  <Combobox.Item key={option.value} value={option} disabled={option.disabled} className={itemClass}>
                    <Combobox.ItemIndicator className="col-start-1">
                      <Check className="size-3.5" />
                    </Combobox.ItemIndicator>
                    <OptionText option={option} />
                  </Combobox.Item>
                )}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
    );
  }

  return (
    <SelectPrimitive.Root
      items={all.map((o) => ({ value: o.value, label: o.label }))}
      value={selected?.value ?? null}
      onValueChange={(next: string | null) => change(next)}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger id={id} aria-label={label} aria-invalid={invalid} className={cn(triggerClass(size), className)}>
        <span className={cn("min-w-0 flex-1 truncate", !selected && "text-muted-foreground")}>{shown ?? text}</span>
        <SelectPrimitive.Icon>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner sideOffset={4} alignItemWithTrigger={false} className="z-50">
          <SelectPrimitive.Popup className={popupClass}>
            <SelectPrimitive.List className="max-h-[min(20rem,var(--available-height))] overflow-y-auto overscroll-contain p-1">
              {all.map((option) => (
                <SelectPrimitive.Item key={option.value} value={option.value} disabled={option.disabled} className={itemClass} label={option.label}>
                  <SelectPrimitive.ItemIndicator className="col-start-1">
                    <Check className="size-3.5" />
                  </SelectPrimitive.ItemIndicator>
                  <OptionText option={option} />
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
