import { Fragment, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  /** En la tarjeta del celular: "title" va como encabezado; false la oculta. */
  card?: "title" | false;
}

export interface FilterDef {
  key: string;
  label: string;
  /** Texto de la opción vacía, p. ej. "Todas las etapas". */
  all: string;
  options: { value: string; label: string }[];
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
    <div className="relative w-full sm:w-64">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input type="search" aria-label="Buscar" className="pl-8" value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} />
    </div>
  );
}

/**
 * Tabla única del panel (docs/rework-plataforma.md §7): orden por columna, filtros y búsqueda en la
 * URL, paginación en el servidor, totales al pie, agrupación por estado con contador y tarjetas en
 * el celular. Las celdas editables usan los controles de `cells.tsx`.
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
  empty,
  searchPlaceholder = "Buscar…",
  filters = [],
  grouping,
  actions,
}: DataTableProps<T>) {
  const navigate = useNavigate();
  const cards = useCards();
  const { state, set } = table;
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  const filtered = Boolean(state.q.trim()) || Object.keys(state.filters).length > 0;
  const hasFooter = columns.some((c) => c.footer !== undefined);
  const titleColumn = columns.find((c) => c.card === "title") ?? columns[0];
  const open = (row: T) => rowHref && navigate(rowHref(row));

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
    state.sort !== key ? <ChevronsUpDown className="size-3.5 opacity-40" /> : state.dir === "asc" ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filtros">
        <SearchBox value={state.q} placeholder={searchPlaceholder} onChange={(q) => set({ q })} />
        {filters.map((f) => (
          <Select
            key={f.key}
            label={f.label}
            value={state.filters[f.key] ?? null}
            emptyLabel={f.all}
            options={f.options}
            className="w-auto max-w-56"
            onValueChange={(v) => set({ filters: { [f.key]: v ?? undefined } })}
          />
        ))}
        {grouping && (
          <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-lg border border-input px-2.5 text-sm">
            <input type="checkbox" className="accent-primary" checked={state.group} onChange={(e) => set({ group: e.target.checked })} />
            {grouping.label}
          </label>
        )}
        {isFetching && !isLoading && <Loader2 aria-label="Actualizando" className="size-4 animate-spin text-muted-foreground" />}
        {actions && <div className="ml-auto flex gap-2">{actions}</div>}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error instanceof Error ? error.message : "No se pudo cargar la tabla."}
        </p>
      ) : isLoading ? (
        <div className="space-y-2" aria-busy="true" aria-label="Cargando">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-foreground/15 py-10 text-center text-sm text-muted-foreground">{filtered ? "Nada coincide con los filtros." : empty}</div>
      ) : !cards ? (
          <div className="overflow-x-auto rounded-xl border border-foreground/10">
            <table aria-label={label} className="w-full text-sm">
              <thead className="bg-foreground/[0.03] text-xs text-muted-foreground">
                <tr className="border-b border-foreground/10">
                  {columns.map((c) => (
                    <th
                      key={c.id}
                      scope="col"
                      aria-sort={c.sortKey && state.sort === c.sortKey ? (state.dir === "asc" ? "ascending" : "descending") : undefined}
                      className={cn("h-10 px-3 font-medium whitespace-nowrap", c.align === "right" ? "text-right" : "text-left", c.className)}
                    >
                      {c.sortKey ? (
                        <button type="button" onClick={() => toggleSort(c.sortKey!)} className={cn("inline-flex items-center gap-1 hover:text-foreground", c.align === "right" && "flex-row-reverse")}>
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
                      <tr className="border-b border-foreground/10 bg-foreground/[0.02]">
                        <th colSpan={columns.length} scope="colgroup" className="px-3 py-2 text-left text-xs font-semibold">
                          {grouping.labels[g.value] ?? g.value} <span className="ml-1 rounded-full bg-foreground/10 px-1.5 py-px font-medium tabular-nums">{g.count}</span>
                        </th>
                      </tr>
                    )}
                    {g.rows.map((row) => (
                      <tr
                        key={rowKey(row)}
                        tabIndex={rowHref ? 0 : undefined}
                        onClick={(e) => !fromControl(e) && open(row)}
                        onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && open(row)}
                        className={cn("border-b border-foreground/10 last:border-0 transition-colors", rowHref && "cursor-pointer hover:bg-foreground/[0.04] focus-visible:bg-foreground/[0.04] focus-visible:outline-none")}
                      >
                        {columns.map((c) => (
                          <td key={c.id} className={cn("px-3 py-2 align-middle", c.align === "right" && "text-right tabular-nums", c.className)}>
                            {c.cell(row)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
              {hasFooter && (
                <tfoot className="border-t border-foreground/15 bg-foreground/[0.03] font-medium">
                  <tr>
                    {columns.map((c, i) => (
                      <td key={c.id} className={cn("px-3 py-2", c.align === "right" && "text-right tabular-nums")}>
                        {c.footer ?? (i === 0 ? <span className="text-xs text-muted-foreground">Total ({total})</span> : null)}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
      ) : (
          <div className="space-y-2">
            {groups.map((g) => (
              <section key={g.value || "all"} className="space-y-2" aria-label={grouping && state.group ? (grouping.labels[g.value] ?? g.value) : undefined}>
                {grouping && state.group && (
                  <p className="pt-1 text-xs font-semibold">
                    {grouping.labels[g.value] ?? g.value} <span className="ml-1 rounded-full bg-foreground/10 px-1.5 py-px tabular-nums">{g.count}</span>
                  </p>
                )}
                {g.rows.map((row) => (
                  <div
                    key={rowKey(row)}
                    role={rowHref ? "link" : undefined}
                    tabIndex={rowHref ? 0 : undefined}
                    onClick={(e) => !fromControl(e) && open(row)}
                    onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && open(row)}
                    className={cn("rounded-xl border border-foreground/10 bg-foreground/[0.02] p-3", rowHref && "cursor-pointer active:bg-foreground/[0.05]")}
                  >
                    <div className="font-medium">{titleColumn.cell(row)}</div>
                    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                      {columns
                        .filter((c) => c !== titleColumn && c.card !== false)
                        .map((c) => (
                          <div key={c.id} className="min-w-0">
                            <dt className="text-[11px] tracking-wide text-muted-foreground uppercase">{c.header}</dt>
                            <dd className={cn("min-w-0 truncate", c.align === "right" && "tabular-nums")}>{c.cell(row)}</dd>
                          </div>
                        ))}
                    </dl>
                  </div>
                ))}
              </section>
            ))}
            {hasFooter && (
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-xl border border-foreground/15 bg-foreground/[0.03] p-3 text-sm" aria-label="Totales">
                {columns
                  .filter((c) => c.footer !== undefined)
                  .map((c) => (
                    <div key={c.id}>
                      <dt className="text-[11px] tracking-wide text-muted-foreground uppercase">Total {c.header.toLowerCase()}</dt>
                      <dd className="font-medium tabular-nums">{c.footer}</dd>
                    </div>
                  ))}
              </dl>
            )}
          </div>
      )}

      {!error && !isLoading && total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
          <p>
            {total} resultado{total === 1 ? "" : "s"}
            {pages > 1 && ` · página ${state.page} de ${pages}`}
          </p>
          <div className="flex items-center gap-2">
            <Select
              label="Filas por página"
              value={String(state.pageSize)}
              options={PAGE_SIZES.map((n) => ({ value: String(n), label: `${n} por página` }))}
              className="w-auto"
              onValueChange={(v) => v && set({ pageSize: Number(v) })}
            />
            <Button size="icon-sm" variant="outline" aria-label="Página anterior" disabled={state.page <= 1} onClick={() => set({ page: state.page - 1 })}>
              <ChevronLeft />
            </Button>
            <Button size="icon-sm" variant="outline" aria-label="Página siguiente" disabled={state.page >= pages} onClick={() => set({ page: state.page + 1 })}>
              <ChevronRight />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
