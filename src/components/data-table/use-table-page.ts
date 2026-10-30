import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";

/** Respuesta de una tabla paginada en el servidor (apps/api/src/lib/table-query.ts). */
export interface TablePage<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  /** Contador por estado del conjunto filtrado (para agrupar). */
  facets: Record<string, number>;
  /** Sumas del conjunto filtrado (para los totales al pie). */
  totals: Record<string, number>;
}

/** Trae una página; mientras llega la siguiente se queda la anterior en pantalla. */
export function useTablePage<T, Extra extends object = object>(key: readonly unknown[], path: string, query: string, enabled = true) {
  return useQuery({
    queryKey: [...key, query],
    queryFn: () => apiFetch<TablePage<T> & Extra>(`${path}?${query}`),
    placeholderData: keepPreviousData,
    enabled,
  });
}
