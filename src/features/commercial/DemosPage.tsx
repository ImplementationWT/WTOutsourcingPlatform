import { DataTable, type Column } from "@/components/data-table/DataTable";
import { RelationCell } from "@/components/data-table/cells";
import { useTableState } from "@/components/data-table/table-state";
import { dateText } from "@/features/activity/api";
import { DEMO_STATUS_LABELS, DEMO_STATUSES } from "@/features/sales/api";
import { DEMO_FILTERS, useDemos, type DemoRow } from "./api";

/** Demos de todos los leads, con sus aprendizajes (se agendan desde el lead). */
export default function DemosPage() {
  const table = useTableState({ filterKeys: DEMO_FILTERS });
  const { data, isLoading, isFetching, error } = useDemos(table.query);

  const columns: Column<DemoRow>[] = [
    {
      id: "title",
      header: "Demo",
      sortKey: "title",
      card: "title",
      cell: (d) => (
        <span className="flex min-w-0 flex-col">
          <span className="font-medium">{d.title}</span>
          {d.url && (
            <a className="text-xs text-primary underline-offset-4 hover:underline" href={d.url} target="_blank" rel="noreferrer">
              Abrir la demo
            </a>
          )}
        </span>
      ),
    },
    { id: "lead", header: "Lead", cell: (d) => <RelationCell to={`/comercial/leads/${d.lead.id}`}>{d.lead.title ?? "Lead"}</RelationCell> },
    { id: "scheduledAt", header: "Fecha", sortKey: "scheduledAt", cell: (d) => dateText(d.scheduledAt) },
    { id: "status", header: "Estado", sortKey: "status", cell: (d) => DEMO_STATUS_LABELS[d.status] },
    {
      id: "learnings",
      header: "Aprendizajes",
      card: false,
      cell: (d) => (d.learnings.length ? <span className="line-clamp-2 max-w-sm text-sm whitespace-normal">{d.learnings.map((l) => l.text).join(" · ")}</span> : <span className="text-muted-foreground">—</span>),
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Demos</h1>
        <p className="mt-1 text-sm text-muted-foreground sm:text-base">Las demos de cada lead y lo que se aprendió en ellas. Se agendan desde el lead.</p>
      </div>
      <DataTable
        label="Demos"
        columns={columns}
        table={table}
        data={data}
        isLoading={isLoading}
        isFetching={isFetching}
        error={error}
        rowKey={(d) => d.id}
        rowHref={(d) => `/comercial/leads/${d.lead.id}`}
        empty="Aún no hay demos."
        searchPlaceholder="Buscar demo"
        filters={[{ key: "status", label: "Filtrar por estado", all: "Todos los estados", options: DEMO_STATUSES.map((s) => ({ value: s, label: DEMO_STATUS_LABELS[s] })) }]}
        grouping={{ label: "Agrupar por estado", value: (d) => d.status, order: DEMO_STATUSES, labels: DEMO_STATUS_LABELS }}
      />
    </div>
  );
}
