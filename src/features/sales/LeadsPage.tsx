import { useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, MoreVertical, Plus, X } from "lucide-react";
import { DataTable, type Column } from "@/components/data-table/DataTable";
import { InlineSelect, RelationCell } from "@/components/data-table/cells";
import { useTableState } from "@/components/data-table/table-state";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  type Lead,
  type LeadFunnel,
  type LeadInput,
  type LeadStatus,
  type LeadView,
} from "./api";
import { LeadPanel } from "./LeadPanel";
import { LeadStatusBadge, TemperatureBadge } from "./SalesBadges";

function NewLeadForm({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [company, setCompany] = useState("");
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [source, setSource] = useState("");
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
        ...(source.trim() ? { source: source.trim() } : {}),
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
              <Label htmlFor="lead-source">Origen</Label>
              <Input id="lead-source" value={source} onChange={(e) => setSource(e.target.value)} placeholder="Manual, Referido, Formulario web…" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lead-funnel">Funnel</Label>
              <Select
                id="lead-funnel"
                value={funnel || null}
                emptyLabel="Sin definir"
                options={LEAD_FUNNELS.map((f) => ({ value: f, label: LEAD_FUNNEL_LABELS[f] }))}
                onValueChange={(v) => setFunnel((v ?? "") as LeadFunnel | "")}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="lead-notes">Notas</Label>
              <Textarea id="lead-notes" rows={2}  value={notes} onChange={(e) => setNotes(e.target.value)} />
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

const WIDE = "(min-width: 1280px)";
const wideQuery = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(WIDE) : null);
/** En pantallas anchas la vista rápida va fija junto a la tabla; si no, entra como panel. */
function useWide() {
  return useSyncExternalStore(
    (onChange) => {
      const mql = wideQuery();
      mql?.addEventListener("change", onChange);
      return () => mql?.removeEventListener("change", onChange);
    },
    () => wideQuery()?.matches ?? false,
    () => false,
  );
}

/** Píldoras del embudo: «Todos» y cada estado con su contador (sobre los demás filtros). */
function StatusChips({ counts, value, onChange }: { counts: Partial<Record<LeadStatus, number>> | undefined; value: LeadStatus | undefined; onChange: (status: LeadStatus | undefined) => void }) {
  const total = LEAD_STATUSES.reduce((sum, st) => sum + (counts?.[st] ?? 0), 0);
  const chip = (key: string, label: string, count: number | undefined, selected: boolean, onClick: () => void) => (
    <button
      key={key}
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "inline-flex h-10 shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-semibold transition-colors",
        selected ? "border-primary/40 bg-primary/10 text-foreground" : "border-border bg-card hover:bg-accent dark:bg-white/[0.03]",
        !selected && count === 0 && "text-muted-foreground",
      )}
    >
      {label}
      <span className={cn("min-w-5 rounded-full px-1.5 text-center text-xs tabular-nums", selected ? "bg-primary text-primary-foreground" : "bg-foreground/[0.07] text-muted-foreground")}>{count ?? "–"}</span>
    </button>
  );
  return (
    <div role="group" aria-label="Embudo" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
      {chip("all", "Todos", counts ? total : undefined, !value, () => onChange(undefined))}
      {LEAD_STATUSES.map((st) => chip(st, LEAD_STATUS_LABELS[st], counts?.[st], value === st, () => onChange(value === st ? undefined : st)))}
    </div>
  );
}

/** Menú «⋮» de la tarjeta del celular. */
function LeadMenu({ lead }: { lead: Lead }) {
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label={`Acciones de ${lead.title}`} className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground">
        <MoreVertical className="size-5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} className="w-48">
        <DropdownMenuItem onClick={() => navigate(`/comercial/leads/${lead.id}`)}>Abrir</DropdownMenuItem>
        {lead.phone && <DropdownMenuItem onClick={() => window.open(`tel:${lead.phone!.replace(/[^\d+]/g, "")}`, "_self")}>Llamar</DropdownMenuItem>}
        {lead.email && <DropdownMenuItem onClick={() => window.open(`mailto:${lead.email}`, "_self")}>Escribir correo</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function LeadsPage() {
  const navigate = useNavigate();
  const wide = useWide();
  const table = useTableState({ filterKeys: LEAD_FILTERS });
  const { data, isLoading, isFetching, error } = useLeads(table.query);
  const queryClient = useQueryClient();
  const canWrite = data?.canWrite ?? false;
  const owners = useOwners(canWrite).data ?? [];
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const status = table.state.filters.status as LeadStatus | undefined;
  const opened = data?.rows.find((l) => l.id === openId) ?? null;
  const save = async (lead: Lead, patch: Partial<LeadInput>) => {
    await updateLead(lead.id, patch);
    await queryClient.invalidateQueries({ queryKey: salesKeys.all });
  };
  const muted = <span className="text-muted-foreground">—</span>;
  const person = (p: Lead["setter"]) => p?.name ?? <span className="text-muted-foreground">Sin asignar</span>;
  const date = (d: string | null) => (d ? formatDate(d) : muted);
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
          <span className="truncate font-semibold">{l.title}</span>
          <span className="truncate text-xs text-muted-foreground">{[l.contactName, l.email ?? l.phone].filter(Boolean).join(" · ") || "Sin datos de contacto"}</span>
        </span>
      ),
    },
    {
      id: "status",
      header: "Estado",
      sortKey: "status",
      card: "badge",
      cardCell: (l) => <LeadStatusBadge value={l.status} />,
      cell: (l) => (
        <InlineSelect
          label={`Estado de ${l.title}`}
          value={l.status}
          options={LEAD_STATUSES}
          labels={LEAD_STATUS_LABELS}
          disabled={!canWrite}
          display={<LeadStatusBadge value={l.status} />}
          onSave={(v) => save(l, { status: v ?? l.status })}
        />
      ),
    },
    {
      id: "temperature",
      header: "Temp.",
      sortKey: "temperature",
      card: "badge",
      cardCell: (l) => (l.temperature ? <TemperatureBadge value={l.temperature} /> : null),
      cell: (l) => (
        <InlineSelect
          label={`Temperatura de ${l.title}`}
          value={l.temperature}
          options={LEAD_TEMPERATURES}
          labels={LEAD_TEMPERATURE_LABELS}
          allowEmpty="Sin definir"
          disabled={!canWrite}
          display={l.temperature ? <TemperatureBadge value={l.temperature} /> : muted}
          onSave={(v) => save(l, { temperature: v })}
        />
      ),
    },
    { id: "funnel", header: "Funnel", sortKey: "funnel", card: false, cell: (l) => (l.funnel ? LEAD_FUNNEL_LABELS[l.funnel] : muted) },
    {
      id: "closer",
      header: "Closer",
      card: false,
      cell: (l) => (
        <InlineSelect label={`Closer de ${l.title}`} value={l.closer?.id ?? null} options={ownerIds} labels={ownerNames} allowEmpty="Sin asignar" disabled={!canWrite} display={person(l.closer)} onSave={(v) => save(l, { closerUserId: v })} />
      ),
    },
    {
      id: "setter",
      header: "Setter",
      card: false,
      hidden: true,
      cell: (l) => (
        <InlineSelect label={`Setter de ${l.title}`} value={l.setter?.id ?? null} options={ownerIds} labels={ownerNames} allowEmpty="Sin asignar" disabled={!canWrite} display={person(l.setter)} onSave={(v) => save(l, { setterUserId: v })} />
      ),
    },
    { id: "source", header: "Origen", card: false, hidden: true, cell: (l) => l.source },
    { id: "submittedAt", header: "Submission", sortKey: "submittedAt", card: "meta", className: "whitespace-nowrap", cardCell: (l) => (l.submittedAt ? new Date(`${l.submittedAt.slice(0, 10)}T12:00:00`).toLocaleDateString("es-PE", { day: "numeric", month: "short" }) : null), cell: (l) => date(l.submittedAt) },
    { id: "meetingAt", header: "Reunión", sortKey: "meetingAt", card: false, hidden: true, className: "whitespace-nowrap", cell: (l) => date(l.meetingAt) },
    { id: "responseDays", header: "Respuesta", align: "right", card: false, hidden: true, cell: (l) => (l.responseDays === null ? muted : `${l.responseDays} d`) },
    { id: "deal", header: "Deal", card: false, hidden: true, cell: (l) => <RelationCell to={l.deal ? `/deals/${l.deal.id}` : null}>{l.deal?.dealCode}</RelationCell> },
  ];

  const panel = opened && (
    <LeadPanel
      key={opened.id}
      lead={opened}
      owners={owners}
      canWrite={canWrite}
      onClose={() => setOpenId(null)}
      onSave={(patch) => save(opened, patch)}
      onFixDates={() => navigate(`/comercial/leads/${opened.id}#${opened.submittedAt ? "reunion" : "submission"}`)}
    />
  );

  return (
    <div className="xl:flex">
      <div className="min-w-0 flex-1 space-y-5">
        <PageHeader
          title="Leads"
          description={<span className="max-sm:hidden">Todos los orígenes en una sola tabla, con su Setter, su Closer y el deal.</span>}
          actions={
            canWrite && !creating ? (
              <Button size="lg" onClick={() => setCreating(true)}>
                <Plus />
                Nuevo <span className="max-sm:hidden">lead</span>
              </Button>
            ) : undefined
          }
        />

        {creating && <NewLeadForm onClose={() => setCreating(false)} />}

        <StatusChips counts={data?.counts} value={status} onChange={(st) => table.set({ filters: { status: st } })} />

        <DataTable
          label="Leads"
          columns={columns}
          table={table}
          data={data}
          isLoading={isLoading}
          isFetching={isFetching}
          error={error}
          rowKey={(l) => l.id}
          onRowClick={(l) => setOpenId((id) => (id === l.id ? null : l.id))}
          cardHref={(l) => `/comercial/leads/${l.id}`}
          selectedKey={openId}
          rowMenu={(l) => <LeadMenu lead={l} />}
          empty="Aún no hay leads. Crea el primero con «Nuevo lead»."
          searchPlaceholder="Buscar por empresa, contacto o correo"
          filters={[
            { key: "view", label: "Filtrar por vista", chip: "Vista", all: "Todas las vistas", options: (Object.keys(LEAD_VIEWS) as LeadView[]).map((v) => ({ value: v, label: LEAD_VIEW_LABELS[v] })) },
            { key: "funnel", label: "Filtrar por funnel", all: "Todos los funnels", options: LEAD_FUNNELS.map((f) => ({ value: f, label: LEAD_FUNNEL_LABELS[f] })) },
            { key: "temperature", label: "Filtrar por temperatura", all: "Toda temperatura", options: LEAD_TEMPERATURES.map((t) => ({ value: t, label: LEAD_TEMPERATURE_LABELS[t] })) },
            ...(owners.length ? [{ key: "closerUserId", label: "Filtrar por Closer", all: "Todos los Closers", options: owners.map((o) => ({ value: o.id, label: o.name })) }] : []),
          ]}
          grouping={{ label: "Agrupar por estado", value: (l) => l.status, order: LEAD_STATUSES, labels: LEAD_STATUS_LABELS }}
        />
      </div>

      {/* Vista rápida: fija a la derecha en pantallas anchas; en las demás, panel deslizable. */}
      {wide && panel && (
        <aside aria-label="Vista rápida del lead" className="sticky top-16 -mt-8 -mr-8 -mb-10 ml-8 h-[calc(100svh-4rem)] w-[22rem] shrink-0 border-l border-border bg-card">
          {panel}
        </aside>
      )}
      <Sheet open={!wide && Boolean(panel)} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent side="right" showCloseButton={false} className="w-full max-w-sm gap-0 bg-card p-0 sm:max-w-sm">
          <SheetTitle className="sr-only">Vista rápida del lead</SheetTitle>
          {panel}
        </SheetContent>
      </Sheet>
    </div>
  );
}
