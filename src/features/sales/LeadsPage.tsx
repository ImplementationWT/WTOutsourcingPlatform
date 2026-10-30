import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, X } from "lucide-react";
import { DataTable, type Column } from "@/components/data-table/DataTable";
import { InlineSelect, RelationCell } from "@/components/data-table/cells";
import { useTableState } from "@/components/data-table/table-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { selectClass } from "@/features/admin/TeamAssignCard";
import { textareaClass } from "@/features/activity/ActivityPanels";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  createLead,
  LEAD_FILTERS,
  LEAD_FUNNEL_LABELS,
  LEAD_FUNNELS,
  LEAD_STATUS_LABELS,
  LEAD_STATUSES,
  LEAD_TEMPERATURE_LABELS,
  LEAD_TEMPERATURES,
  LEAD_VIEW_LABELS,
  LEAD_VIEWS,
  salesKeys,
  updateLead,
  useLeads,
  useOwners,
  useSources,
  type Lead,
  type LeadFunnel,
  type LeadInput,
  type LeadStatus,
  type LeadView,
} from "./api";
import { LeadStatusBadge, TemperatureBadge } from "./SalesBadges";

function NewLeadForm({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const sources = useSources().data ?? [];
  const [company, setCompany] = useState("");
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [funnel, setFunnel] = useState<LeadFunnel | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = Boolean(company.trim() || contactName.trim() || email.trim());

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const { lead } = await createLead({
        company: company.trim(),
        contactName: contactName.trim(),
        email: email.trim() || null,
        phone: phone.trim() || null,
        notes: notes.trim(),
        ...(sourceId ? { sourceId } : {}),
        ...(funnel ? { funnel } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: salesKeys.all });
      navigate(`/comercial/leads/${lead.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear el lead.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Nuevo lead</CardTitle>
        <Button size="icon-sm" variant="ghost" aria-label="Cerrar" onClick={onClose}>
          <X />
        </Button>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="lead-company">Empresa</Label>
              <Input id="lead-company" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Manpersa SAC" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lead-contact">Contacto</Label>
              <Input id="lead-contact" value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Francisco Wong" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lead-email">Correo</Label>
              <Input id="lead-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lead-phone">Teléfono</Label>
              <Input id="lead-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lead-source">Source</Label>
              <select id="lead-source" className={cn(selectClass, "w-full")} value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                <option value="">Manual</option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lead-funnel">Funnel</Label>
              <select id="lead-funnel" className={cn(selectClass, "w-full")} value={funnel} onChange={(e) => setFunnel(e.target.value as LeadFunnel | "")}>
                <option value="">Sin definir</option>
                {LEAD_FUNNELS.map((f) => (
                  <option key={f} value={f}>
                    {LEAD_FUNNEL_LABELS[f]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="lead-notes">Notas</Label>
              <textarea id="lead-notes" rows={2} className={textareaClass} value={notes} onChange={(e) => setNotes(e.target.value)} />
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
              Crear lead
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** Estados que se eligen a mano: "Ganado" solo llega al convertir el lead. */
const MANUAL_STATUSES = LEAD_STATUSES.filter((s) => s !== "won");

export default function LeadsPage() {
  const table = useTableState({ filterKeys: LEAD_FILTERS });
  const { data, isLoading, isFetching, error } = useLeads(table.query);
  const queryClient = useQueryClient();
  const sources = useSources().data ?? [];
  const canWrite = data?.canWrite ?? false;
  const owners = useOwners(canWrite).data ?? [];
  const [creating, setCreating] = useState(false);
  const view = table.state.filters.view as LeadView | undefined;
  const status = table.state.filters.status as LeadStatus | undefined;
  const funnelStatuses: readonly LeadStatus[] = view ? LEAD_VIEWS[view] : LEAD_STATUSES;
  const save = async (lead: Lead, patch: Partial<LeadInput>) => {
    await updateLead(lead.id, patch);
    await queryClient.invalidateQueries({ queryKey: salesKeys.all });
  };
  const person = (p: Lead["setter"]) => p?.name ?? <span className="text-muted-foreground">—</span>;
  const date = (d: string | null) => (d ? formatDate(d) : <span className="text-muted-foreground">—</span>);
  const ownerIds = owners.map((o) => o.id);
  const ownerNames = Object.fromEntries(owners.map((o) => [o.id, o.name]));

  const columns: Column<Lead>[] = [
    {
      id: "lead",
      header: "Lead",
      sortKey: "company",
      card: "title",
      cell: (l) => (
        <span className="flex min-w-0 flex-col">
          <span className="font-medium">{l.title}</span>
          <span className="text-xs text-muted-foreground">{[l.contactName, l.email, l.phone].filter(Boolean).join(" · ") || "Sin datos de contacto"}</span>
        </span>
      ),
    },
    {
      id: "status",
      header: "Estado",
      sortKey: "status",
      cell: (l) => (
        <InlineSelect
          label={`Estado de ${l.title}`}
          value={l.status}
          options={MANUAL_STATUSES}
          labels={LEAD_STATUS_LABELS}
          disabled={!canWrite || l.status === "won"}
          display={<LeadStatusBadge value={l.status} />}
          onSave={(v) => save(l, { status: v ?? l.status })}
        />
      ),
    },
    {
      id: "temperature",
      header: "Temperatura",
      sortKey: "temperature",
      cell: (l) => (
        <InlineSelect
          label={`Temperatura de ${l.title}`}
          value={l.temperature}
          options={LEAD_TEMPERATURES}
          labels={LEAD_TEMPERATURE_LABELS}
          allowEmpty="Sin definir"
          disabled={!canWrite}
          display={l.temperature ? <TemperatureBadge value={l.temperature} /> : <span className="text-muted-foreground">—</span>}
          onSave={(v) => save(l, { temperature: v })}
        />
      ),
    },
    { id: "funnel", header: "Funnel", sortKey: "funnel", cell: (l) => (l.funnel ? LEAD_FUNNEL_LABELS[l.funnel] : <span className="text-muted-foreground">—</span>) },
    { id: "source", header: "Source", cell: (l) => l.source.name },
    {
      id: "setter",
      header: "Setter",
      cell: (l) => (
        <InlineSelect label={`Setter de ${l.title}`} value={l.setter?.id ?? null} options={ownerIds} labels={ownerNames} allowEmpty="Sin asignar" disabled={!canWrite} display={person(l.setter)} onSave={(v) => save(l, { setterUserId: v })} />
      ),
    },
    {
      id: "closer",
      header: "Closer",
      cell: (l) => (
        <InlineSelect label={`Closer de ${l.title}`} value={l.closer?.id ?? null} options={ownerIds} labels={ownerNames} allowEmpty="Sin asignar" disabled={!canWrite} display={person(l.closer)} onSave={(v) => save(l, { closerUserId: v })} />
      ),
    },
    { id: "submittedAt", header: "Submission", sortKey: "submittedAt", card: false, cell: (l) => date(l.submittedAt) },
    { id: "meetingAt", header: "Reunión", sortKey: "meetingAt", card: false, cell: (l) => date(l.meetingAt) },
    { id: "responseDays", header: "Respuesta", align: "right", cell: (l) => (l.responseDays === null ? <span className="text-muted-foreground">—</span> : `${l.responseDays} d`) },
    { id: "deal", header: "Deal", card: false, cell: (l) => <RelationCell to={l.deal ? `/deals/${l.deal.id}` : null}>{l.deal?.dealCode}</RelationCell> },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Leads</h1>
        <p className="mt-1 text-sm text-muted-foreground sm:text-base">Leads de todos los sources: activos y fríos en una sola tabla, con Setter, Closer y su conversión en cliente.</p>
      </div>

      {creating && <NewLeadForm onClose={() => setCreating(false)} />}

      <div role="tablist" aria-label="Vistas" className="flex gap-1 border-b border-foreground/10">
        {([undefined, "active", "cold", "won"] as const).map((v) => (
          <button
            key={v ?? "all"}
            type="button"
            role="tab"
            aria-selected={view === v}
            onClick={() => table.set({ filters: { view: v, status: undefined } })}
            className={cn("-mb-px border-b-2 px-3 py-2 text-sm", view === v ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {v ? LEAD_VIEW_LABELS[v] : "Todos"}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8" role="group" aria-label="Embudo">
        {funnelStatuses.map((st) => (
          <button
            key={st}
            type="button"
            aria-pressed={status === st}
            onClick={() => table.set({ filters: { status: status === st ? undefined : st } })}
            className={cn(
              "rounded-xl border p-3 text-left transition-colors",
              status === st ? "border-primary bg-primary/10" : "border-foreground/10 bg-foreground/[0.02] hover:bg-foreground/[0.05]",
            )}
          >
            <p className="text-xs text-muted-foreground">{LEAD_STATUS_LABELS[st]}</p>
            <p className="text-xl font-semibold tabular-nums">{data?.counts[st] ?? "–"}</p>
          </button>
        ))}
      </div>

      <DataTable
        label="Leads"
        columns={columns}
        table={table}
        data={data}
        isLoading={isLoading}
        isFetching={isFetching}
        error={error}
        rowKey={(l) => l.id}
        rowHref={(l) => `/comercial/leads/${l.id}`}
        empty="Aún no hay leads. Crea uno o conecta un source."
        searchPlaceholder="Buscar por empresa, contacto o correo"
        filters={[
          { key: "sourceId", label: "Filtrar por source", all: "Todos los sources", options: sources.map((s) => ({ value: s.id, label: s.name })) },
          { key: "funnel", label: "Filtrar por funnel", all: "Todos los funnels", options: LEAD_FUNNELS.map((f) => ({ value: f, label: LEAD_FUNNEL_LABELS[f] })) },
          { key: "temperature", label: "Filtrar por temperatura", all: "Toda temperatura", options: LEAD_TEMPERATURES.map((t) => ({ value: t, label: LEAD_TEMPERATURE_LABELS[t] })) },
          ...(owners.length ? [{ key: "closerUserId", label: "Filtrar por Closer", all: "Todos los Closers", options: owners.map((o) => ({ value: o.id, label: o.name })) }] : []),
        ]}
        grouping={{ label: "Agrupar por estado", value: (l) => l.status, order: LEAD_STATUSES, labels: LEAD_STATUS_LABELS }}
        actions={
          canWrite && !creating ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus />
              Nuevo lead
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}
