import type { Collection, Document, Filter } from "mongodb";
import { z } from "zod";

/**
 * Consulta de tabla común a todas las listas (docs/rework-plataforma.md §7): paginación, orden y
 * búsqueda en el servidor, contadores por un campo (agrupación por estado) y totales del conjunto
 * filtrado, no solo de la página.
 */
export const tableQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.string().regex(/^[a-zA-Z]{1,40}$/).optional(),
  dir: z.enum(["asc", "desc"]).default("asc"),
  q: z.string().trim().max(100).optional()
});
export type TableQuery = z.infer<typeof tableQuerySchema>;

/** Orden de una columna: un campo, o un campo de catálogo que ordena por su posición en el catálogo. */
export type SortSpec = string | { field: string; order: readonly string[] };

export interface TableResult<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  /** Cantidad por valor del campo de agrupación (sobre el conjunto filtrado). */
  facets: Record<string, number>;
  /** Sumas del conjunto filtrado. */
  totals: Record<string, number>;
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function runTableQuery<T extends Document>(
  collection: Collection<T>,
  {
    match,
    query,
    sortable,
    defaultSort,
    search = [],
    facetField,
    sums = {}
  }: {
    match: Filter<T>;
    query: TableQuery;
    sortable: Record<string, SortSpec>;
    defaultSort: { key: string; dir: "asc" | "desc" };
    /** Campos de texto donde busca `q`. */
    search?: string[];
    facetField?: string;
    /** Total → campo numérico a sumar. */
    sums?: Record<string, string>;
  }
): Promise<TableResult<T>> {
  const filter: Document = { ...match };
  if (query.q && search.length) {
    const pattern = new RegExp(escapeRegex(query.q), "i");
    const or = search.map((field) => ({ [field]: pattern }));
    filter.$and = [...((filter.$and as Document[] | undefined) ?? []), { $or: or }];
  }
  const key = query.sort && sortable[query.sort] ? query.sort : defaultSort.key;
  const dir = query.sort && sortable[query.sort] ? query.dir : defaultSort.dir;
  const spec = sortable[key];
  const direction = dir === "asc" ? 1 : -1;
  const sortStages: Document[] =
    typeof spec === "string"
      ? [{ $sort: { [spec]: direction, _id: 1 } }]
      : [{ $addFields: { _rank: { $indexOfArray: [spec.order, `$${spec.field}`] } } }, { $sort: { _rank: direction, _id: 1 } }, { $unset: "_rank" }];

  const facet: Document = {
    rows: [...sortStages, { $skip: (query.page - 1) * query.pageSize }, { $limit: query.pageSize }],
    total: [{ $count: "n" }]
  };
  if (facetField) facet.facets = [{ $group: { _id: `$${facetField}`, n: { $sum: 1 } } }];
  if (Object.keys(sums).length) {
    facet.totals = [{ $group: { _id: null, ...Object.fromEntries(Object.entries(sums).map(([name, field]) => [name, { $sum: `$${field}` }])) } }];
  }
  const [result] = await collection.aggregate<Document>([{ $match: filter }, { $facet: facet }]).toArray();
  const totalsDoc = (result.totals as Document[] | undefined)?.[0] ?? {};
  return {
    rows: result.rows as T[],
    total: (result.total as { n: number }[])[0]?.n ?? 0,
    page: query.page,
    pageSize: query.pageSize,
    facets: Object.fromEntries(((result.facets as { _id: unknown; n: number }[] | undefined) ?? []).map((f) => [String(f._id ?? ""), f.n])),
    totals: Object.fromEntries(Object.keys(sums).map((name) => [name, Number(totalsDoc[name] ?? 0)]))
  };
}
