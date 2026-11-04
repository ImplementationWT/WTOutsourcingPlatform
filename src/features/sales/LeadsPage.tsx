import { useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { MoreVertical, Plus } from "lucide-react";
import { DataTable, type Column } from "@/components/data-table/DataTable";
import { InlineSelect } from "@/components/data-table/cells";
import { useTableState } from "@/components/data-table/table-state";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Drawer } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDate } from "@/lib/format";
import { errorText, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  createLead,
  LEAD_FILTERS,
  LEAD_FUNNEL_LABELS,
  LEAD_FUNNELS,
  LEAD_STATUS_LABELS,
  LEAD_STATUSES,
  PIPELINE_LEAD_STATUSES,
  LEAD_TEMPERATURE_LABELS,
  LEAD_TEMPERATURES,
  salesKeys,
  updateLead,
  useLeads,
  useOwners,
  type Lead,
  type LeadInput,
  type LeadStatus,
} from "./api";
import { LeadDetailModal } from "./LeadDetail";
import { LeadStatusBadge, TemperatureBadge } from "./SalesBadges";

/**
 * «Nuevo lead» (prototipo): panel deslizable con nombre, empresa (obligatoria), contacto, correo y
 * teléfono. Se crea en Nuevo, Warm, LHT y source Manual, sin Setter ni Closer, y se abre su detalle.
 */
function NewLeadPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const { search } = useLocation();
  const queryClient = useQueryClient();
  const empty = { name: "", company: "", contactName: "", email: "", phone: "" };
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const close = () => {
    setForm(empty);
    onClose();
  };
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.company.trim()) return;
    setBusy(true);
    try {
      const { lead } = await createLead({
        ...(form.name.trim() ? { name: form.name.trim() } : {}),
        company: form.company.trim(),
        contactName: form.contactName.trim(),
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        status: undefined,
        temperature: "warm",
        funnel: "lht",
        source: "Manual",
        setterUserId: null,
        closerUserId: null,
      } as Parameters<typeof createLead>[0]);
      await queryClient.invalidateQueries({ queryKey: salesKeys.all });
      toast.success(`Lead creado: ${lead.title}`);
      close();
      navigate({ pathname: `/comercial/leads/${lead.id}`, search });
    } catch (err) {
      toast.error("No se pudo crear el lead.", { description: errorText(err, "Inténtalo de nuevo.") });
    } finally {
      setBusy(false);
    }
  }
  const field = (k: keyof typeof empty, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="space-y-2">
      <Label htmlFor={`nl-${k}`} className="text-caps-label">
        {label}
      </Label>
      <Input id={`nl-${k}`} value={form[k]} onChange={set(k)} className="h-11 rounded-[10px] border-border bg-muted dark:bg-muted" {...props} />
    </div>
  );
  return (
    <Drawer
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Nuevo lead"
      description="Se crea en Nuevo, Warm y LHT; después completas el resto en su detalle."
      className="max-w-md"
      dirty={Object.values(form).some((v) => v.trim())}
      footer={
        <>
          <Button variant="outline" size="lg" onClick={close}>
            Cancelar
          </Button>
          <Button size="lg" type="submit" form="new-lead" disabled={!form.company.trim()} loading={busy}>
            Crear lead
          </Button>
        </>
      }
    >
      <form id="new-lead" onSubmit={submit} className="space-y-4 py-1">
        {field("name", "Nombre del lead", { placeholder: "Portal de pedidos Manpersa" })}
        {field("company", "Empresa", { placeholder: "Manpersa SAC", required: true })}
        {field("contactName", "Contacto", { placeholder: "Francisco Wong" })}
        {field("email", "Correo", { type: "email", placeholder: "nombre@empresa.com" })}
        {field("phone", "Teléfono", { type: "tel" })}
      </form>
    </Drawer>
  );
}

/** Pestañas del prototipo: Todos y estos siete estados (Nurturing y No calificado solo cuentan en «Todos»). */
const PILL_STATUSES: readonly LeadStatus[] = PIPELINE_LEAD_STATUSES;

/** Píldoras del embudo (prototipo): «Todos» y cada estado con su contador (sobre los demás filtros). */
function StatusChips({ counts, value, onChange }: { counts: Partial<Record<LeadStatus, number>> | undefined; value: LeadStatus | undefined; onChange: (status: LeadStatus | undefined) => void }) {
  const total = LEAD_STATUSES.reduce((sum, st) => sum + (counts?.[st] ?? 0), 0);
  const shown = PILL_STATUSES;
  const chip = (key: string, label: string, count: number | undefined, selected: boolean, onClick: () => void) => (
    <button
      key={key}
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "inline-flex h-10 shrink-0 items-center gap-2 rounded-full border px-3.5 text-sm transition-[background-color,border-color,transform] active:translate-y-px",
        selected ? "border-primary bg-accent-soft font-semibold text-accent-text" : "border-border bg-card font-medium hover:border-line-strong hover:bg-muted",
      )}
    >
      {label}
      <span className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs tabular-nums", selected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>{count ?? "–"}</span>
    </button>
  );
  return (
    <div role="group" aria-label="Embudo" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
      {chip("all", "Todos", counts ? total : undefined, !value, () => onChange(undefined))}
      {shown.map((st) => chip(st, LEAD_STATUS_LABELS[st], counts?.[st], value === st, () => onChange(value === st ? undefined : st)))}
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
        <DropdownMenuItem onClick={() => navigate({ pathname: `/comercial/leads/${lead.id}`, search: location.search })}>Abrir</DropdownMenuItem>
        {lead.phone && <DropdownMenuItem onClick={() => window.open(`tel:${lead.phone!.replace(/[^\d+]/g, "")}`, "_self")}>Llamar</DropdownMenuItem>}
        {lead.email && <DropdownMenuItem onClick={() => window.open(`mailto:${lead.email}`, "_self")}>Escribir correo</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Leads (prototipo): píldoras por estado, tabla agrupada por estado con grupos plegables, y el
 * detalle en una ventana grande al hacer clic (también por enlace: /comercial/leads/:id).
 */
export default function LeadsPage() {
  const navigate = useNavigate();
  const { search } = useLocation();
  const { id: openId } = useParams();
  const table = useTableState({ filterKeys: LEAD_FILTERS, groupByDefault: true });
  const { data, isLoading, isFetching, error } = useLeads(table.query);
  const queryClient = useQueryClient();
  const canWrite = data?.canWrite ?? false;
  const owners = useOwners(canWrite).data ?? [];
  const [creating, setCreating] = useState(false);
  const status = table.state.filters.status as LeadStatus | undefined;
  const openLead = (id: string | null) => navigate({ pathname: id ? `/comercial/leads/${id}` : "/comercial", search });
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
          options={PIPELINE_LEAD_STATUSES}
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
    { id: "submittedAt", header: "Submission", sortKey: "submittedAt", card: "meta", className: "whitespace-nowrap", cardCell: (l) => (l.submittedAt ? new Date(`${l.submittedAt.slice(0, 10)}T12:00:00`).toLocaleDateString("es-PE", { day: "numeric", month: "short" }) : null), cell: (l) => date(l.submittedAt) },
  ];

  return (
    <>
      <div className="space-y-5">
        <PageHeader
          title="Leads"
          description={<span className="max-sm:hidden">Todos los sources en una sola tabla, con Setter, Closer y conversión en cliente.</span>}
          actions={
            canWrite ? (
              <Button size="lg" onClick={() => setCreating(true)}>
                <Plus />
                Nuevo <span className="max-sm:hidden">lead</span>
              </Button>
            ) : undefined
          }
        />

        <NewLeadPanel open={creating} onClose={() => setCreating(false)} />

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
          onRowClick={(l) => openLead(l.id)}
          selectedKey={openId ?? null}
          rowMenu={(l) => <LeadMenu lead={l} />}
          empty="Aún no hay leads. Crea el primero con «Nuevo lead»."
          emptyFiltered="Sin resultados · Ajusta la búsqueda o limpia los filtros"
          columnPicker={false}
          searchPlaceholder="Buscar por empresa, contacto o correo"
          filters={[
            // Prototipo: Funnel (solo los que tienen leads) y Temperatura.
            { key: "funnel", label: "Filtrar por funnel", chip: "Funnel", all: "Todos", options: (data?.funnels ?? LEAD_FUNNELS).map((f) => ({ value: f, label: LEAD_FUNNEL_LABELS[f] })) },
            { key: "temperature", label: "Filtrar por temperatura", chip: "Temperatura", all: "Todas", options: LEAD_TEMPERATURES.map((t) => ({ value: t, label: LEAD_TEMPERATURE_LABELS[t] })) },
          ]}
          grouping={{ label: "Agrupar por estado", value: (l) => l.status, order: LEAD_STATUSES, labels: LEAD_STATUS_LABELS, toggle: false, chip: (v) => <LeadStatusBadge value={v as LeadStatus} />, countLabel: (n) => `${n} ${n === 1 ? "lead" : "leads"}` }}
        />
      </div>

      {openId && <LeadDetailModal key={openId} id={openId} onClose={() => openLead(null)} />}
    </>
  );
}
