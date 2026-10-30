import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Plus, X } from "lucide-react";
import { DataTable, type Column } from "@/components/data-table/DataTable";
import { InlineNumber, InlineSelect, RelationCell, RelationsCell, TotalCell } from "@/components/data-table/cells";
import { useTableState } from "@/components/data-table/table-state";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { StatusBadge } from "@/components/ui/status-badge";
import type { Tone } from "@/components/ui/tones";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "@/features/auth/auth";
import { DEAL_STATUS_LABELS, DEAL_STATUSES, opsKeys, type DealStatus, type OpsProjectRow } from "@/features/ops/api";
import { apiFetch } from "@/lib/api-client";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { dealLocked, useDealRefresh, useDealStatusOptions } from "./hooks";
import {
  createDeal,
  DEAL_FILTERS,
  SALES_STAGE_LABELS,
  SALES_STAGES,
  updateDeal,
  useDeals,
  type Deal,
  type DealInput,
  type SalesStage,
} from "./api";

const STATUS_TONE: Record<DealStatus, Tone> = {
  draft: "outline",
  proposed: "outline",
  approved: "info",
  in_progress: "accent",
  delivered: "primary",
  invoiced: "warn",
  paid: "ok",
  cancelled: "neutral",
};

export function DealStatusBadge({ value }: { value: DealStatus }) {
  return (
    <StatusBadge tone={STATUS_TONE[value]} className={cn(value === "cancelled" && "line-through")}>
      {DEAL_STATUS_LABELS[value]}
    </StatusBadge>
  );
}

function NewDealForm({ projectId, onClose }: { projectId?: string; onClose: () => void }) {
  const navigate = useNavigate();
  const refresh = useDealRefresh();
  const statuses = useDealStatusOptions();
  const role = useSession().data?.role;
  // Un Team Leader crea deals de un proyecto de su equipo; el resto puede dejarlo sin proyecto.
  const projects = useQuery({
    queryKey: [...opsKeys.allProjects, "options"],
    queryFn: async () => (await apiFetch<{ rows: OpsProjectRow[] }>("/api/ops/projects?pageSize=100&sort=name&dir=asc")).rows,
    enabled: !projectId,
    staleTime: 60_000,
  }).data;
  const [title, setTitle] = useState("");
  const [project, setProject] = useState(projectId ?? "");
  const [hours, setHours] = useState("");
  const [rate, setRate] = useState("");
  const [probability, setProbability] = useState("50");
  const [salesStage, setSalesStage] = useState<SalesStage>("new");
  const [status, setStatus] = useState<DealStatus>("draft");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hoursValue = hours === "" ? 0 : Number(hours);
  const rateCents = rate === "" ? 0 : Math.round(Number(rate) * 100);
  const prob = Number(probability);
  const valid =
    title.trim().length >= 3 && hoursValue >= 0 && Number.isFinite(hoursValue) && rateCents >= 0 && Number.isFinite(rateCents) && Number.isInteger(prob) && prob >= 0 && prob <= 100 && (role !== "lead" || Boolean(project));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const input: Partial<DealInput> & { title: string } = { title: title.trim(), projectId: project || null, hours: hoursValue, rateCents, probability: prob, salesStage, status };
      const { deal } = await createDeal(input);
      await refresh(project || null);
      if (projectId) onClose();
      else navigate(`/deals/${deal.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear el deal.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-foreground/10 p-4" aria-label="Nuevo deal">
      <div className="flex items-center justify-between">
        <p className="font-medium">Nuevo deal</p>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Cerrar" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="deal-title">Nombre</Label>
          <Input id="deal-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Módulo de pedidos" />
        </div>
        {!projectId && (
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="deal-project">Proyecto</Label>
            <Select
              id="deal-project"
              value={project || null}
              emptyLabel={role === "lead" ? "Elige un proyecto" : "Sin proyecto (aún no se gana)"}
              options={(projects ?? []).map((p) => ({ value: p.id, label: `${p.name} · ${p.customerName}` }))}
              onValueChange={(v) => setProject((v ?? ""))}
            />
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="deal-hours">Horas</Label>
          <Input id="deal-hours" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="40" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="deal-rate">Tarifa por hora (USD)</Label>
          <Input id="deal-rate" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="25" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="deal-prob">Probabilidad (%)</Label>
          <Input id="deal-prob" inputMode="numeric" value={probability} onChange={(e) => setProbability(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="deal-stage">Estado de venta</Label>
          <Select
            id="deal-stage"
            value={salesStage}
            options={SALES_STAGES.map((s) => ({ value: s, label: SALES_STAGE_LABELS[s] }))}
            onValueChange={(v) => setSalesStage((v ?? "") as SalesStage)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="deal-status">Estado</Label>
          <Select
            id="deal-status"
            value={status}
            options={statuses.map((s) => ({ value: s, label: DEAL_STATUS_LABELS[s] }))}
            onValueChange={(v) => setStatus((v ?? "") as DealStatus)}
          />
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={!valid || busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}
          Crear deal
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

/**
 * Tabla de Deals (§4.1). En el proyecto se usa filtrada por `projectId` con su propio prefijo en la
 * URL, así conviven con otros filtros de la página.
 */
export function DealsTable({ projectId, prefix = "" }: { projectId?: string; prefix?: string }) {
  const table = useTableState({ prefix, filterKeys: DEAL_FILTERS, fixed: projectId ? { projectId } : {} });
  const { data, isLoading, isFetching, error } = useDeals(table.query);
  const refresh = useDealRefresh();
  const statuses = useDealStatusOptions();
  const [creating, setCreating] = useState(false);
  const save = async (deal: Deal, patch: Partial<DealInput>) => {
    await updateDeal(deal.id, patch);
    await refresh(deal.project?.id);
  };
  const totals = data?.totals ?? {};

  const columns: Column<Deal>[] = [
    {
      id: "deal",
      header: "Deal",
      sortKey: "dealCode",
      card: "title",
      cell: (d) => (
        <span className="flex min-w-0 flex-col">
          <span className="font-medium">{d.title}</span>
          <span className="text-xs text-muted-foreground tabular-nums">{d.dealCode}</span>
        </span>
      ),
    },
    ...(projectId
      ? []
      : [
          {
            id: "project",
            header: "Proyecto",
            cell: (d: Deal) => <RelationCell to={d.project ? `/operativa/${d.project.id}` : null}>{d.project?.name}</RelationCell>,
          },
        ]),
    { id: "contacts", header: "Contactos", cell: (d) => <RelationsCell items={d.contacts} href={(id) => `/comercial/contactos/${id}`} /> },
    {
      id: "salesStage",
      header: "Estado de venta",
      sortKey: "salesStage",
      cell: (d) => <InlineSelect label={`Estado de venta de ${d.title}`} value={d.salesStage} options={SALES_STAGES} labels={SALES_STAGE_LABELS} disabled={!d.canEdit} onSave={(v) => save(d, { salesStage: v ?? "new" })} />,
    },
    {
      id: "status",
      header: "Estado",
      sortKey: "status",
      cell: (d) => (
        <InlineSelect
          label={`Estado de ${d.title}`}
          value={d.status}
          options={statuses.includes(d.status) ? statuses : [d.status, ...statuses]}
          labels={DEAL_STATUS_LABELS}
          disabled={!d.canEdit}
          display={<DealStatusBadge value={d.status} />}
          onSave={(v) => save(d, { status: v ?? d.status })}
        />
      ),
    },
    {
      id: "hours",
      header: "Horas",
      sortKey: "hours",
      align: "right",
      footer: <TotalCell hours={totals.hours ?? 0} strong />,
      cell: (d) => <InlineNumber label={`Horas de ${d.title}`} value={d.hours} disabled={!d.canEdit || dealLocked(d)} display={<TotalCell hours={d.hours} />} onSave={(v) => save(d, { hours: v })} />,
    },
    { id: "rate", header: "Tarifa", sortKey: "rateCents", align: "right", cell: (d) => <TotalCell cents={d.rateCents} currency={d.currency} /> },
    { id: "amount", header: "Valor", sortKey: "amountCents", align: "right", footer: <TotalCell cents={totals.amountCents ?? 0} strong />, cell: (d) => <TotalCell cents={d.amountCents} currency={d.currency} strong /> },
    { id: "probability", header: "Prob.", sortKey: "probability", align: "right", cell: (d) => `${d.probability}%` },
    { id: "projected", header: "Proyectado", sortKey: "projectedCents", align: "right", footer: <TotalCell cents={totals.projectedCents ?? 0} strong />, cell: (d) => <TotalCell cents={d.projectedCents} currency={d.currency} /> },
    { id: "close", header: "Cierre estimado", sortKey: "expectedCloseDate", cell: (d) => (d.expectedCloseDate ? formatDate(d.expectedCloseDate) : <span className="text-muted-foreground">—</span>) },
    { id: "owner", header: "Responsable", card: false, cell: (d) => d.owner?.name ?? <span className="text-muted-foreground">—</span> },
  ];

  return (
    <div className="space-y-3">
      {creating && <NewDealForm projectId={projectId} onClose={() => setCreating(false)} />}
      <DataTable
        label="Deals"
        columns={columns}
        table={table}
        data={data}
        isLoading={isLoading}
        isFetching={isFetching}
        error={error}
        rowKey={(d) => d.id}
        rowHref={(d) => `/deals/${d.id}`}
        empty={projectId ? "Este proyecto aún no tiene deals." : "Aún no hay deals."}
        searchPlaceholder="Buscar por código, nombre o producto"
        filters={[
          { key: "salesStage", label: "Filtrar por estado de venta", all: "Todo estado de venta", options: SALES_STAGES.map((s) => ({ value: s, label: SALES_STAGE_LABELS[s] })) },
          { key: "status", label: "Filtrar por estado", all: "Todos los estados", options: DEAL_STATUSES.map((s) => ({ value: s, label: DEAL_STATUS_LABELS[s] })) },
        ]}
        grouping={{ label: "Agrupar por estado", value: (d) => d.status, order: DEAL_STATUSES, labels: DEAL_STATUS_LABELS }}
        actions={
          data?.canCreate && !creating ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus />
              Nuevo deal
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}
