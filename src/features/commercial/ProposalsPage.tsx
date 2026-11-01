import { DataTable, type Column } from "@/components/data-table/DataTable";
import { RelationCell, TotalCell } from "@/components/data-table/cells";
import { useTableState } from "@/components/data-table/table-state";
import { dateText } from "@/features/activity/api";
import { PROPOSAL_STATUS_LABELS, PROPOSAL_STATUSES } from "@/features/ops/api";
import { PROPOSAL_FILTERS, useProposals, type ProposalRow } from "./api";
import { PageHeader } from "@/components/layout/PageHeader";

/** Cotizaciones de Comercial y de Operativa, con sus montos sumados al pie. Se crean desde el lead, el deal o el proyecto. */
export default function ProposalsPage() {
  const table = useTableState({ filterKeys: PROPOSAL_FILTERS });
  const { data, isLoading, isFetching, error } = useProposals(table.query);

  const columns: Column<ProposalRow>[] = [
    {
      id: "title",
      header: "Cotización",
      sortKey: "title",
      card: "title",
      cell: (p) => (
        <span className="flex min-w-0 flex-col">
          <span className="font-medium">{p.title}</span>
          <span className="text-xs text-muted-foreground">{p.lines ? `${p.lines} línea${p.lines === 1 ? "" : "s"}` : "Sin líneas"}</span>
        </span>
      ),
    },
    { id: "lead", header: "Lead", cell: (p) => <RelationCell to={p.lead ? `/comercial/leads/${p.lead.id}` : null}>{p.lead?.title}</RelationCell> },
    { id: "deal", header: "Deal", cell: (p) => <RelationCell to={p.deal ? `/deals/${p.deal.id}` : null}>{p.deal?.dealCode}</RelationCell> },
    { id: "status", header: "Estado", sortKey: "status", cell: (p) => PROPOSAL_STATUS_LABELS[p.status] },
    { id: "area", header: "Área", card: false, cell: (p) => (p.area === "commercial" ? "Comercial" : "Operativa") },
    { id: "sentAt", header: "Enviada", sortKey: "sentAt", card: false, cell: (p) => (p.sentAt ? dateText(p.sentAt) : <span className="text-muted-foreground">—</span>) },
    { id: "amount", header: "Monto", sortKey: "amountCents", align: "right", footer: <TotalCell cents={data?.totals.amountCents ?? 0} strong />, cell: (p) => <TotalCell cents={p.amountCents} currency={p.currency} strong /> },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="Propuestas" description="Cotizaciones de Comercial y de Operativa. Con líneas, el monto es la suma de producto × horas × tarifa." />
      <DataTable
        label="Propuestas"
        columns={columns}
        table={table}
        data={data}
        isLoading={isLoading}
        isFetching={isFetching}
        error={error}
        rowKey={(p) => p.id}
        rowHref={(p) => `/comercial/propuestas/${p.id}`}
        empty="Aún no hay propuestas. Se crean desde el lead, el deal o el proyecto."
        searchPlaceholder="Buscar propuesta"
        filters={[
          { key: "status", label: "Filtrar por estado", all: "Todos los estados", options: PROPOSAL_STATUSES.map((s) => ({ value: s, label: PROPOSAL_STATUS_LABELS[s] })) },
          { key: "area", label: "Filtrar por área", all: "Comercial y Operativa", options: [{ value: "commercial", label: "Comercial" }, { value: "operations", label: "Operativa" }] },
        ]}
        grouping={{ label: "Agrupar por estado", value: (p) => p.status, order: PROPOSAL_STATUSES, labels: PROPOSAL_STATUS_LABELS }}
      />
    </div>
  );
}
