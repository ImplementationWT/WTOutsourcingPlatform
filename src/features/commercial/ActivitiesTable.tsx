import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { DatePicker } from "@/components/ui/date-picker";
import { Loader2, Plus, X } from "lucide-react";
import { DataTable, type Column } from "@/components/data-table/DataTable";
import { InlineSelect, RelationCell } from "@/components/data-table/cells";
import { useTableState } from "@/components/data-table/table-state";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useOwners } from "@/features/sales/api";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  ACTIVITY_FILTERS,
  ACTIVITY_KIND_LABELS,
  ACTIVITY_KINDS,
  ACTIVITY_STATUS_LABELS,
  ACTIVITY_STATUSES,
  commercialKeys,
  createActivity,
  updateActivity,
  useActivities,
  type Activity,
  type ActivityKind,
  type ActivityStatus,
} from "./api";

function NewActivityForm({ leadId, dealId, onClose }: { leadId?: string; dealId?: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const owners = useOwners().data ?? [];
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<ActivityKind>("follow_up");
  const [dueDate, setDueDate] = useState("");
  const [ownerUserId, setOwnerUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = title.trim().length >= 3;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await createActivity({ title: title.trim(), kind, dueDate: dueDate || null, ...(ownerUserId ? { ownerUserId } : {}), ...(leadId ? { leadId } : {}), ...(dealId ? { dealId } : {}) });
      await queryClient.invalidateQueries({ queryKey: commercialKeys.activities });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear la actividad.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid items-end gap-3 rounded-xl border border-foreground/10 p-4 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_auto]" aria-label="Nueva actividad">
      <div className="space-y-1.5">
        <Label htmlFor="act-title">Actividad</Label>
        <Input id="act-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Llamar para cerrar la demo" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="act-kind">Tipo</Label>
        <Select
          id="act-kind"
          value={kind}
          options={ACTIVITY_KINDS.map((k) => ({ value: k, label: ACTIVITY_KIND_LABELS[k] }))}
          onValueChange={(v) => setKind((v ?? "") as ActivityKind)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="act-due">Vence</Label>
        <DatePicker id="act-due" label="Vence" value={dueDate || null} onValueChange={(v) => setDueDate(v ?? "")} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="act-owner">Responsable</Label>
        <Select
          id="act-owner"
          value={ownerUserId || null}
          emptyLabel="Yo"
          options={owners.map((o) => ({ value: o.id, label: o.name }))}
          onValueChange={(v) => setOwnerUserId((v ?? ""))}
        />
      </div>
      <div className="flex gap-1">
        <Button type="submit" disabled={!valid || busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}
          Crear
        </Button>
        <Button type="button" size="icon" variant="ghost" aria-label="Cerrar" onClick={onClose}>
          <X />
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive sm:col-span-2 lg:col-span-5">
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * Actividades comerciales (§4.1). En un lead o un deal se usa filtrada por ese registro y con su
 * propio prefijo en la URL; en la página propia permite crear solo desde un lead o un deal.
 */
export function ActivitiesTable({ leadId, dealId, prefix = "" }: { leadId?: string; dealId?: string; prefix?: string }) {
  const fixed = { ...(leadId ? { leadId } : {}), ...(dealId ? { dealId } : {}) };
  const table = useTableState({ prefix, filterKeys: ACTIVITY_FILTERS, fixed });
  const { data, isLoading, isFetching, error } = useActivities(table.query);
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const canWrite = data?.canWrite ?? false;
  const embedded = Boolean(leadId || dealId);
  const save = async (a: Activity, patch: Parameters<typeof updateActivity>[1]) => {
    await updateActivity(a.id, patch);
    await queryClient.invalidateQueries({ queryKey: commercialKeys.activities });
  };

  const columns: Column<Activity>[] = [
    {
      id: "title",
      header: "Actividad",
      sortKey: "title",
      card: "title",
      cell: (a) => <span className={cn("font-medium", a.status === "done" && "text-muted-foreground line-through")}>{a.title}</span>,
    },
    { id: "kind", header: "Tipo", sortKey: "kind", cell: (a) => ACTIVITY_KIND_LABELS[a.kind] },
    {
      id: "status",
      header: "Estado",
      sortKey: "status",
      cell: (a) => <InlineSelect label={`Estado de ${a.title}`} value={a.status} options={ACTIVITY_STATUSES} labels={ACTIVITY_STATUS_LABELS} disabled={!canWrite} onSave={(v) => save(a, { status: (v ?? a.status) as ActivityStatus })} />,
    },
    {
      id: "dueDate",
      header: "Vence",
      sortKey: "dueDate",
      cell: (a) => (a.dueDate ? <span className={cn(a.overdue && "font-medium text-destructive")}>{formatDate(a.dueDate)}{a.overdue ? " · vencida" : ""}</span> : <span className="text-muted-foreground">—</span>),
    },
    { id: "owner", header: "Responsable", cell: (a) => a.owner?.name ?? <span className="text-muted-foreground">—</span> },
    ...(embedded
      ? []
      : [
          {
            id: "for",
            header: "Lead / Deal",
            cell: (a: Activity) =>
              a.deal ? (
                <RelationCell to={`/deals/${a.deal.id}`}>
                  {a.deal.dealCode} · {a.deal.title}
                </RelationCell>
              ) : (
                <RelationCell to={a.lead ? `/comercial/leads/${a.lead.id}` : null}>{a.lead?.title}</RelationCell>
              ),
          },
        ]),
  ];

  return (
    <div className="space-y-3">
      {creating && <NewActivityForm leadId={leadId} dealId={dealId} onClose={() => setCreating(false)} />}
      <DataTable
        label="Actividades"
        columns={columns}
        table={table}
        data={data}
        isLoading={isLoading}
        isFetching={isFetching}
        error={error}
        rowKey={(a) => a.id}
        empty={embedded ? "Sin actividades." : "Aún no hay actividades comerciales."}
        searchPlaceholder="Buscar actividad"
        filters={[
          { key: "status", label: "Filtrar por estado", all: "Todos los estados", options: ACTIVITY_STATUSES.map((s) => ({ value: s, label: ACTIVITY_STATUS_LABELS[s] })) },
          { key: "kind", label: "Filtrar por tipo", all: "Todos los tipos", options: ACTIVITY_KINDS.map((k) => ({ value: k, label: ACTIVITY_KIND_LABELS[k] })) },
          { key: "mine", label: "Responsable", all: "De todos", options: [{ value: "1", label: "Mías" }] },
        ]}
        grouping={{ label: "Agrupar por estado", value: (a) => a.status, order: ACTIVITY_STATUSES, labels: ACTIVITY_STATUS_LABELS }}
        actions={
          canWrite && embedded && !creating ? (
            <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
              <Plus />
              Nueva actividad
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}
