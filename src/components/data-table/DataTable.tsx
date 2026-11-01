import { Fragment, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, Loader2, Search, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { PAGE_SIZES, type TableStateApi } from "./table-state";
import type { TablePage } from "./use-table-page";

export const tableSelectClass =
  "h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

export interface Column<T> {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Clave de orden que acepta la API; sin ella la columna no se ordena. */
  sortKey?: string;
  align?: "left" | "right";
  /** Total al pie (lo calcula el servidor sobre el conjunto filtrado). */
  footer?: ReactNode;
  className?: string;
  /**
   * En la tarjeta del celular: "title" va como encabezado (con su subtítulo), "badge" en la fila
   * de insignias, "meta" a la derecha de esa fila (una fecha, un monto); false la oculta. Sin
   * valor, va en la cuadrícula de datos de la tarjeta.
   */
  card?: "title" | "badge" | "meta" | false;
  /** Contenido en la tarjeta del celular si difiere de la celda (p. ej. la insignia sin el menú). */
  cardCell?: (row: T) => ReactNode;
  /** Oculta de inicio: se muestra desde «Columnas». */
  hidden?: boolean;
}

export interface FilterDef {
  key: string;
  label: string;
  /** Texto de la opción vacía, p. ej. "Todas las etapas". */
  all: string;
  options: { value: string; label: string }[];
  /** Nombre corto en el chip de filtro activo (por defecto, la etiqueta sin «Filtrar por»). */
  chip?: string;
}

export interface Grouping<T> {
  /** Texto del interruptor, p. ej. "Agrupar por etapa". */
  label: string;
  value: (row: T) => string;
  order: readonly string[];
  labels: Record<string, string>;
}

interface DataTableProps<T> {
  label: string;
  columns: Column<T>[];
  table: TableStateApi;
  data?: TablePage<T>;
  isLoading: boolean;
  isFetching?: boolean;
  error?: unknown;
  rowKey: (row: T) => string;
  /** Clic en la fila (o Enter) abre el detalle. */
  rowHref?: (row: T) => string;
  /** Clic en la fila (o Enter) abre algo en la misma página, p. ej. un pop-up de detalle. */
  onRowClick?: (row: T) => void;
  /** En el celular, la tarjeta abre esto en lugar de `onRowClick` (p. ej. el detalle completo). */
  cardHref?: (row: T) => string;
  /** Fila resaltada (la que está abierta en el panel lateral). */
  selectedKey?: string | null;
  /** Menú «⋮» de cada tarjeta del celular. */
  rowMenu?: (row: T) => ReactNode;
  empty: string;
  searchPlaceholder?: string;
  filters?: FilterDef[];
  grouping?: Grouping<T>;
  /** Botones a la derecha de la barra (p. ej. "Nuevo"). */
  actions?: ReactNode;
}

const MOBILE = "(max-width: 767px)";
const media = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(MOBILE) : null);
/** En el celular se pintan tarjetas en lugar de la tabla (una sola de las dos en el DOM). */
function useCards() {
  return useSyncExternalStore(
    (onChange) => {
      const mql = media();
      mql?.addEventListener("change", onChange);
      return () => mql?.removeEventListener("change", onChange);
    },
    () => media()?.matches ?? false,
    () => false,
  );
}

/** Columnas visibles de una tabla: lo elegido en «Columnas» se recuerda en este navegador. */
function useVisibleColumns<T>(label: string, columns: Column<T>[]) {
  const storageKey = `table.columns.${label}`;
  const defaults = columns.filter((c) => !c.hidden).map((c) => c.id);
  const [chosen, setChosen] = useState<string[] | null>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : null;
    } catch {
      return null;
    }
  });
  const visible = chosen ?? defaults;
  const toggle = (id: string) => {
    const next = visible.includes(id) ? visible.filter((v) => v !== id) : [...visible, id];
    setChosen(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Sin almacenamiento: la elección dura hasta recargar.
    }
  };
  // La primera columna (el registro) siempre se ve.
  return { shown: columns.filter((c, i) => i === 0 || visible.includes(c.id)), visible, toggle };
}

/**
 * Los clics en controles de la celda (enlaces, selects, inputs) no abren el detalle; tampoco los
 * que llegan desde un panel en portal (las opciones de un Select), que React propaga a la fila.
 */
const fromControl = (event: React.MouseEvent) => {
  const target = event.target;
  if (!(target instanceof Element) || !event.currentTarget.contains(target)) return true;
  return Boolean(target.closest("a,button,select,input,textarea,label,[role=combobox],[data-cell-control]"));
};

function SearchBox({ value, placeholder, onChange }: { value: string; placeholder: string; onChange: (q: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  // Si la URL cambia desde fuera (atrás/adelante), el cuadro la sigue.
  if (value !== seen) {
    setSeen(value);
    setDraft(value);
  }
  useEffect(() => {
    if (draft === value) return;
    const timer = window.setTimeout(() => onChange(draft), 300);
    return () => window.clearTimeout(timer);
  }, [draft, value, onChange]);
  return (
    <div className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input type="search" aria-label="Buscar" className="h-11 rounded-xl pl-10" value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} />
    </div>
  );
}

const toolbarButton =
  "inline-flex h-11 shrink-0 items-center gap-2 rounded-xl border border-border bg-card px-4 text-sm font-semibold transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none aria-expanded:bg-accent dark:bg-white/[0.03] dark:hover:bg-white/[0.06]";

const chipName = (f: FilterDef) => f.chip ?? f.label.replace(/^Filtrar por\s+/i, "").replace(/^\w/, (c) => c.toUpperCase());

/**
 * Tabla única del panel (docs/rework-plataforma.md §7): orden por columna, filtros y búsqueda en la
 * URL, paginación en el servidor, totales al pie, agrupación por estado con contador, columnas a
 * elegir y tarjetas en el celular. Las celdas editables usan los controles de `cells.tsx`.
 */
export function DataTable<T>({
  label,
  columns,
  table,
  data,
  isLoading,
  isFetching,
  error,
  rowKey,
  rowHref,
  onRowClick,
  cardHref,
  selectedKey,
  rowMenu,
  empty,
  searchPlaceholder = "Buscar…",
  filters = [],
  grouping,
  actions,
}: DataTableProps<T>) {
  const navigate = useNavigate();
  const cards = useCards();
  const { state, set } = table;
  const [filtersOpen, setFiltersOpen] = useState(false);
  const { shown, visible, toggle } = useVisibleColumns(label, columns);
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  const filtered = Boolean(state.q.trim()) || Object.keys(state.filters).length > 0;
  const hasFooter = shown.some((c) => c.footer !== undefined);
  const titleColumn = columns.find((c) => c.card === "title") ?? columns[0];
  const clickable = Boolean(rowHref || onRowClick);
  const open = (row: T) => (onRowClick ? onRowClick(row) : rowHref && navigate(rowHref(row)));
  const openCard = (row: T) => (cardHref ? navigate(cardHref(row)) : open(row));
  const active = filters.filter((f) => state.filters[f.key]);
  const activeCount = active.length + (grouping && state.group ? 1 : 0);
  const hasPanel = filters.length > 0 || Boolean(grouping);

  // Agrupar: los grupos siguen el orden del catálogo y el contador es del conjunto filtrado.
  const groups =
    grouping && state.group
      ? grouping.order
          .map((value) => ({ value, rows: rows.filter((r) => grouping.value(r) === value), count: data?.facets[value] ?? 0 }))
          .filter((g) => g.rows.length > 0)
      : [{ value: "", rows, count: rows.length }];

  const toggleSort = (key: string) => {
    if (state.sort !== key) set({ sort: key, dir: "asc" });
    else if (state.dir === "asc") set({ sort: key, dir: "desc" });
    else set({ sort: null, dir: "desc" });
  };

  const sortIcon = (key: string) =>
    state.sort !== key ? <ChevronsUpDown className="size-3 opacity-40" /> : state.dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />;

  const pager = !error && !isLoading && total > 0 && (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 text-sm text-muted-foreground">
      <p>
        {total} resultado{total === 1 ? "" : "s"}
        {pages > 1 && ` · página ${state.page} de ${pages}`}
      </p>
      <div className="flex items-center gap-2">
        <Select
          label="Filas por página"
          value={String(state.pageSize)}
          options={PAGE_SIZES.map((n) => ({ value: String(n), label: `${n} por página` }))}
          size="sm"
          className="w-auto"
          onValueChange={(v) => v && set({ pageSize: Number(v) })}
        />
        {pages > 1 && (
          <>
            <Button size="icon-sm" variant="outline" aria-label="Página anterior" disabled={state.page <= 1} onClick={() => set({ page: state.page - 1 })}>
              <ChevronLeft />
            </Button>
            <Button size="icon-sm" variant="outline" aria-label="Página siguiente" disabled={state.page >= pages} onClick={() => set({ page: state.page + 1 })}>
              <ChevronRight />
            </Button>
          </>
        )}
      </div>
    </div>
  );

  const groupCount = (n: number) => <span className="ml-1.5 rounded-full bg-foreground/10 px-1.5 py-px text-[11px] font-semibold tabular-nums">{n}</span>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2" role="group" aria-label="Filtros">
        <SearchBox value={state.q} placeholder={searchPlaceholder} onChange={(q) => set({ q })} />
        {hasPanel && (
          <button type="button" aria-expanded={filtersOpen} aria-controls={`${label}-filters`} onClick={() => setFiltersOpen((o) => !o)} className={toolbarButton}>
            <SlidersHorizontal className="size-4 sm:hidden" aria-hidden />
            <span className={cn(activeCount === 0 && "max-sm:sr-only")}>Filtros{activeCount > 0 && ` · ${activeCount}`}</span>
          </button>
        )}
        {!cards && columns.length > 2 && (
          <DropdownMenu>
            <DropdownMenuTrigger className={toolbarButton}>Columnas</DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={6} className="w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Columnas visibles</DropdownMenuLabel>
                {columns.slice(1).map((c) => (
                  <DropdownMenuCheckboxItem key={c.id} checked={visible.includes(c.id)} closeOnClick={false} onCheckedChange={() => toggle(c.id)}>
                    {c.header}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {isFetching && !isLoading && <Loader2 aria-label="Actualizando" className="size-4 shrink-0 animate-spin text-muted-foreground" />}
        {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
      </div>

      {hasPanel && filtersOpen && (
        <div id={`${label}-filters`} className="grid gap-3 rounded-2xl border border-border bg-card p-4 shadow-card sm:grid-cols-2 lg:grid-cols-4">
          {filters.map((f) => (
            <div key={f.key} className="min-w-0 space-y-1.5">
              <p className="text-caps-label">{chipName(f)}</p>
              <Select label={f.label} value={state.filters[f.key] ?? null} emptyLabel={f.all} options={f.options} onValueChange={(v) => set({ filters: { [f.key]: v ?? undefined } })} />
            </div>
          ))}
          {grouping && (
            <div className="min-w-0 space-y-1.5">
              <p className="text-caps-label">Vista</p>
              <label className="flex h-control cursor-pointer items-center gap-2.5 rounded-lg border border-input px-3 text-sm dark:bg-white/[0.03]">
                <input type="checkbox" className="size-4 accent-primary" checked={state.group} onChange={(e) => set({ group: e.target.checked })} />
                {grouping.label}
              </label>
            </div>
          )}
        </div>
      )}

      {active.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Filtros activos:</span>
          {active.map((f) => (
            <span key={f.key} className="inline-flex h-7 items-center gap-1 rounded-full bg-primary/10 pr-1 pl-3 text-[13px] font-medium text-brand-300 dark:text-brand-200">
              {chipName(f)}: {f.options.find((o) => o.value === state.filters[f.key])?.label ?? state.filters[f.key]}
              <button type="button" aria-label={`Quitar filtro ${chipName(f)}`} onClick={() => set({ filters: { [f.key]: undefined } })} className="inline-flex size-5 items-center justify-center rounded-full hover:bg-primary/15">
                <X className="size-3.5" />
              </button>
            </span>
          ))}
          <button type="button" onClick={() => set({ filters: Object.fromEntries(active.map((f) => [f.key, undefined])) })} className="text-muted-foreground underline underline-offset-4 hover:text-foreground">
            Limpiar filtros
          </button>
        </div>
      )}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error instanceof Error ? error.message : "No se pudo cargar la tabla."}
        </p>
      ) : isLoading ? (
        <div className="space-y-2 rounded-2xl border border-border bg-card p-4" aria-busy="true" aria-label="Cargando">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground shadow-card">{filtered ? "Nada coincide con los filtros." : empty}</div>
      ) : !cards ? (
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-card">
          <div className="overflow-x-auto">
            <table aria-label={label} className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  {shown.map((c) => (
                    <th
                      key={c.id}
                      scope="col"
                      aria-sort={c.sortKey && state.sort === c.sortKey ? (state.dir === "asc" ? "ascending" : "descending") : undefined}
                      className={cn("text-caps-label h-11 px-4 whitespace-nowrap", c.align === "right" ? "text-right" : "text-left", c.className)}
                    >
                      {c.sortKey ? (
                        <button type="button" onClick={() => toggleSort(c.sortKey!)} className={cn("inline-flex items-center gap-1 uppercase hover:text-foreground", c.align === "right" && "flex-row-reverse")}>
                          {c.header}
                          {sortIcon(c.sortKey)}
                        </button>
                      ) : (
                        c.header
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <Fragment key={g.value || "all"}>
                    {grouping && state.group && (
                      <tr className="border-b border-border bg-muted/50">
                        <th colSpan={shown.length} scope="colgroup" className="px-4 py-2 text-left text-xs font-semibold">
                          {grouping.labels[g.value] ?? g.value}
                          {groupCount(g.count)}
                        </th>
                      </tr>
                    )}
                    {g.rows.map((row) => {
                      const selected = selectedKey !== undefined && selectedKey === rowKey(row);
                      return (
                        <tr
                          key={rowKey(row)}
                          tabIndex={clickable ? 0 : undefined}
                          aria-selected={selectedKey !== undefined ? selected : undefined}
                          onClick={(e) => !fromControl(e) && open(row)}
                          onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && open(row)}
                          className={cn(
                            "border-b border-border transition-colors last:border-0",
                            selected ? "bg-primary/[0.06] dark:bg-primary/[0.09]" : clickable && "hover:bg-muted/60",
                            clickable && "cursor-pointer focus-visible:bg-muted/60 focus-visible:outline-none",
                          )}
                        >
                          {shown.map((c) => (
                            <td key={c.id} className={cn("px-4 py-3 align-middle", c.align === "right" && "text-right tabular-nums", c.className)}>
                              {c.cell(row)}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
              {hasFooter && (
                <tfoot className="border-t border-border bg-muted/40 font-medium">
                  <tr>
                    {shown.map((c, i) => (
                      <td key={c.id} className={cn("px-4 py-3", c.align === "right" && "text-right tabular-nums")}>
                        {c.footer ?? (i === 0 ? <span className="text-xs text-muted-foreground">Total ({total})</span> : null)}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          {pager}
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <section key={g.value || "all"} className="space-y-3" aria-label={grouping && state.group ? (grouping.labels[g.value] ?? g.value) : undefined}>
              {grouping && state.group && (
                <p className="pt-1 text-xs font-semibold">
                  {grouping.labels[g.value] ?? g.value}
                  {groupCount(g.count)}
                </p>
              )}
              {g.rows.map((row) => {
                const badges = columns.filter((c) => c.card === "badge");
                const meta = columns.find((c) => c.card === "meta");
                const rest = columns.filter((c) => c !== titleColumn && c.card === undefined);
                const tappable = clickable || Boolean(cardHref);
                return (
                  <div
                    key={rowKey(row)}
                    role={rowHref || cardHref ? "link" : onRowClick ? "button" : undefined}
                    tabIndex={tappable ? 0 : undefined}
                    onClick={(e) => !fromControl(e) && openCard(row)}
                    onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && openCard(row)}
                    className={cn("rounded-2xl border border-border bg-card p-4 shadow-card", tappable && "cursor-pointer active:bg-muted/60")}
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1 text-base [&_.text-xs]:text-sm">{titleColumn.cell(row)}</div>
                      {rowMenu && <div className="-mt-1 -mr-2 shrink-0">{rowMenu(row)}</div>}
                    </div>
                    {(badges.length > 0 || meta) && (
                      <div className="mt-3 flex items-center gap-2">
                        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                          {badges.map((c) => (
                            <Fragment key={c.id}>{(c.cardCell ?? c.cell)(row)}</Fragment>
                          ))}
                        </div>
                        {meta && <div className="shrink-0 text-sm text-muted-foreground">{(meta.cardCell ?? meta.cell)(row)}</div>}
                      </div>
                    )}
                    {rest.length > 0 && (
                      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                        {rest.map((c) => (
                          <div key={c.id} className="min-w-0">
                            <dt className="text-caps-label">{c.header}</dt>
                            <dd className={cn("min-w-0 truncate", c.align === "right" && "tabular-nums")}>{c.cell(row)}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                );
              })}
            </section>
          ))}
          {hasFooter && (
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-2xl border border-border bg-muted/40 p-4 text-sm" aria-label="Totales">
              {columns
                .filter((c) => c.footer !== undefined)
                .map((c) => (
                  <div key={c.id}>
                    <dt className="text-caps-label">Total {c.header.toLowerCase()}</dt>
                    <dd className="font-medium tabular-nums">{c.footer}</dd>
                  </div>
                ))}
            </dl>
          )}
          {pager && <div className="overflow-hidden rounded-2xl border border-border bg-card">{pager}</div>}
        </div>
      )}
    </div>
  );
}
