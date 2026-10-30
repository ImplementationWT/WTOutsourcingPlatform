import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

/** Estado de una tabla: vive en la URL para poder compartir una vista con un link. */
export interface TableState {
  page: number;
  pageSize: number;
  sort: string | null;
  dir: "asc" | "desc";
  q: string;
  /** Agrupar por estado (con contador). */
  group: boolean;
  filters: Record<string, string>;
}

export interface TableStateApi {
  state: TableState;
  /** Cambia parte del estado; cambiar filtros, búsqueda u orden vuelve a la página 1. */
  set: (patch: Partial<Omit<TableState, "filters">> & { filters?: Record<string, string | undefined> }) => void;
  /** Query string para la API (sin `group`, que es solo de la vista). */
  query: string;
}

export const PAGE_SIZES = [25, 50, 100] as const;

/**
 * Lee y escribe el estado de la tabla en la URL. `prefix` separa dos tablas en la misma página
 * (p. ej. la de deals dentro del proyecto: `d.page`, `d.sort`…). `filterKeys` son los filtros que
 * acepta esta tabla; `fixed` son filtros que no se muestran ni van a la URL (p. ej. el proyecto).
 */
export function useTableState({ prefix = "", filterKeys = [], fixed = {} }: { prefix?: string; filterKeys?: readonly string[]; fixed?: Record<string, string> } = {}): TableStateApi {
  const [params, setParams] = useSearchParams();
  const key = useCallback((name: string) => `${prefix}${name}`, [prefix]);
  const keysText = filterKeys.join(",");
  const fixedText = JSON.stringify(fixed);

  const state = useMemo<TableState>(() => {
    const page = Math.max(1, Number(params.get(key("page"))) || 1);
    const size = Number(params.get(key("pageSize")));
    const filters: Record<string, string> = {};
    for (const name of keysText ? keysText.split(",") : []) {
      const value = params.get(key(name));
      if (value) filters[name] = value;
    }
    return {
      page,
      pageSize: (PAGE_SIZES as readonly number[]).includes(size) ? size : PAGE_SIZES[0],
      sort: params.get(key("sort")),
      dir: params.get(key("dir")) === "asc" ? "asc" : "desc",
      q: params.get(key("q")) ?? "",
      group: params.get(key("group")) === "1",
      filters,
    };
  }, [params, key, keysText]);

  const set = useCallback<TableStateApi["set"]>(
    (patch) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          const write = (name: string, value: string | null | undefined) => (value ? next.set(key(name), value) : next.delete(key(name)));
          const resets = patch.filters !== undefined || patch.q !== undefined || patch.sort !== undefined || patch.pageSize !== undefined;
          if (patch.sort !== undefined) write("sort", patch.sort);
          if (patch.dir !== undefined) write("dir", patch.dir);
          if (patch.q !== undefined) write("q", patch.q.trim() ? patch.q : null);
          if (patch.group !== undefined) write("group", patch.group ? "1" : null);
          if (patch.pageSize !== undefined) write("pageSize", patch.pageSize === PAGE_SIZES[0] ? null : String(patch.pageSize));
          for (const [name, value] of Object.entries(patch.filters ?? {})) write(name, value);
          if (patch.page !== undefined) write("page", patch.page > 1 ? String(patch.page) : null);
          else if (resets) write("page", null);
          return next;
        },
        { replace: true },
      );
    },
    [setParams, key],
  );

  const query = useMemo(() => {
    const out = new URLSearchParams();
    out.set("page", String(state.page));
    out.set("pageSize", String(state.pageSize));
    if (state.sort) {
      out.set("sort", state.sort);
      out.set("dir", state.dir);
    }
    if (state.q.trim()) out.set("q", state.q.trim());
    for (const [name, value] of Object.entries(state.filters)) out.set(name, value);
    for (const [name, value] of Object.entries(JSON.parse(fixedText) as Record<string, string>)) out.set(name, value);
    return out.toString();
  }, [state, fixedText]);

  return { state, set, query };
}
