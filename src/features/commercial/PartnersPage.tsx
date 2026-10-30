import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, X } from "lucide-react";
import { DataTable, type Column } from "@/components/data-table/DataTable";
import { TotalCell } from "@/components/data-table/cells";
import { useTableState } from "@/components/data-table/table-state";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { commercialKeys, createPartner, PARTNER_FILTERS, PARTNER_KIND_LABELS, PARTNER_KINDS, updatePartner, usePartners, type Partner, type PartnerKind } from "./api";

/** Alta o edición de un partner: nombre, tipo y comisión por defecto. */
export function PartnerForm({ partner, onClose }: { partner?: Partner; onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState(partner?.name ?? "");
  const [kind, setKind] = useState<PartnerKind>(partner?.kind ?? "referral");
  const [pct, setPct] = useState(partner ? String(partner.commissionPct) : "10");
  const [notes, setNotes] = useState(partner?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commissionPct = Number(pct.replace(",", "."));
  const valid = name.trim().length >= 2 && Number.isFinite(commissionPct) && commissionPct >= 0 && commissionPct <= 100;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const input = { name: name.trim(), kind, commissionPct, notes: notes.trim() };
      if (partner) {
        await updatePartner(partner.id, input);
        await queryClient.invalidateQueries({ queryKey: ["commercial"] });
        onClose();
      } else {
        const { partner: created } = await createPartner(input);
        await queryClient.invalidateQueries({ queryKey: commercialKeys.partners });
        navigate(`/comercial/partners/${created.id}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el partner.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-foreground/10 p-4" aria-label={partner ? "Editar partner" : "Nuevo partner"}>
      <div className="flex items-center justify-between">
        <p className="font-medium">{partner ? "Editar partner" : "Nuevo partner"}</p>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Cerrar" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
        <div className="space-y-1.5">
          <Label htmlFor="pt-name">Nombre</Label>
          <Input id="pt-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Agencia Norte" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pt-kind">Tipo</Label>
          <Select
            id="pt-kind"
            value={kind}
            options={PARTNER_KINDS.map((k) => ({ value: k, label: PARTNER_KIND_LABELS[k] }))}
            onValueChange={(v) => setKind((v ?? "") as PartnerKind)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pt-pct">Comisión por defecto (%)</Label>
          <Input id="pt-pct" inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} />
        </div>
        <div className="space-y-1.5 sm:col-span-3">
          <Label htmlFor="pt-notes">Notas</Label>
          <Input id="pt-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={!valid || busy}>
          {busy ? <Loader2 className="animate-spin" /> : !partner && <Plus />}
          {partner ? "Guardar cambios" : "Crear partner"}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

export default function PartnersPage() {
  const table = useTableState({ filterKeys: PARTNER_FILTERS });
  const { data, isLoading, isFetching, error } = usePartners(table.query);
  const [creating, setCreating] = useState(false);

  const columns: Column<Partner>[] = [
    { id: "name", header: "Partner", sortKey: "name", card: "title", cell: (p) => <span className={cn("font-medium", !p.active && "text-muted-foreground")}>{p.name}{!p.active && " (inactivo)"}</span> },
    { id: "kind", header: "Tipo", sortKey: "kind", cell: (p) => PARTNER_KIND_LABELS[p.kind] },
    { id: "pct", header: "Comisión", sortKey: "commissionPct", align: "right", cell: (p) => `${p.commissionPct}%` },
    { id: "deals", header: "Deals", align: "right", cell: (p) => p.deals },
    { id: "sold", header: "Vendido", align: "right", cell: (p) => <TotalCell cents={p.soldCents} /> },
    { id: "commission", header: "Comisión generada", align: "right", cell: (p) => <TotalCell cents={p.commissionCents} strong /> },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Partners</h1>
        <p className="mt-1 text-sm text-muted-foreground sm:text-base">Quienes nos traen deals. Su comisión es aparte: comisión % × valor del deal vendido.</p>
      </div>
      {creating && <PartnerForm onClose={() => setCreating(false)} />}
      <DataTable
        label="Partners"
        columns={columns}
        table={table}
        data={data}
        isLoading={isLoading}
        isFetching={isFetching}
        error={error}
        rowKey={(p) => p.id}
        rowHref={(p) => `/comercial/partners/${p.id}`}
        empty="Aún no hay partners."
        searchPlaceholder="Buscar partner"
        filters={[
          { key: "kind", label: "Filtrar por tipo", all: "Todos los tipos", options: PARTNER_KINDS.map((k) => ({ value: k, label: PARTNER_KIND_LABELS[k] })) },
          { key: "active", label: "Filtrar por estado", all: "Activos e inactivos", options: [{ value: "true", label: "Activos" }, { value: "false", label: "Inactivos" }] },
        ]}
        actions={
          data?.canWrite && !creating ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus />
              Nuevo partner
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}
