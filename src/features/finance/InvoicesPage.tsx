import { Fragment, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Drawer } from "@/components/ui/dialog";
import { Kpi, KpiRow } from "@/components/ui/kpi";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { TONE_CLASS, TONE_DOT } from "@/components/ui/tones";
import { PAYMENT_TYPE_LABELS, money } from "@/features/ops/api";
import { HoursInput } from "@/features/tasks/TaskBoard";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { INVOICE_STAGE_LABELS, INVOICE_STAGE_TONE, INVOICE_STAGES, invoicesApi, MONTHS, useFinanceAction, useInvoices, type Invoice, type InvoicePatch, type InvoiceProject, type InvoiceStage } from "./api";

/** Monto en dólares editable (se guarda en centavos); vacío = 0. */
function MoneyInput({ cents, label, onSave }: { cents: number; label: string; onSave: (cents: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (cents ? String(cents / 100) : "");
  const commit = () => {
    if (draft === null) return;
    const next = Math.round(Math.max(0, Number(draft.replace(",", ".")) || 0) * 100);
    setDraft(null);
    if (next !== cents) onSave(next);
  };
  return (
    <span className="inline-flex h-8 items-center rounded-lg border border-input bg-card px-2 text-sm tabular-nums focus-within:border-ring dark:bg-white/[0.03]">
      <span className="text-muted-foreground">$</span>
      <input aria-label={label} inputMode="decimal" placeholder="—" className="w-16 bg-transparent pl-0.5 outline-none" value={shown} onClick={(e) => e.currentTarget.select()} onChange={(e) => setDraft(e.target.value.replace(/[^0-9.,]/g, ""))} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
    </span>
  );
}

function StageSelect({ value, onSave, label }: { value: InvoiceStage; onSave: (v: InvoiceStage) => void; label: string }) {
  return (
    <Select
      label={label}
      size="sm"
      value={value}
      options={INVOICE_STAGES.map((s) => ({ value: s, label: INVOICE_STAGE_LABELS[s] }))}
      renderValue={(o) => <span className={cn("rounded-md px-2 py-0.5 text-xs font-semibold", TONE_CLASS[INVOICE_STAGE_TONE[(o?.value as InvoiceStage) ?? value]])}>{o?.label}</span>}
      onValueChange={(v) => v && v !== value && onSave(v as InvoiceStage)}
    />
  );
}

/** Campos editables de una invoice (en la fila y en el panel de detalle). */
function useInvoiceFields(inv: Invoice, projects: InvoiceProject[]) {
  const run = useFinanceAction();
  const save = (patch: InvoicePatch) => void run(() => invoicesApi.update(inv.id, patch));
  const deals = projects.find((p) => p.id === inv.project.id)?.deals ?? [];
  return {
    month: <Select label={`Mes de ${inv.number}`} size="sm" value={inv.month.slice(5, 7)} options={MONTHS.map((m, i) => ({ value: String(i + 1).padStart(2, "0"), label: m }))} onValueChange={(v) => v && save({ month: `${inv.month.slice(0, 4)}-${v}` })} />,
    stage: <StageSelect label={`Stage de ${inv.number}`} value={inv.stage === "pending" && inv.effectiveStage === "upcoming" ? "upcoming" : inv.stage} onSave={(stage) => save({ stage })} />,
    invoiced: <DatePicker size="sm" label={`Invoiced date de ${inv.number}`} value={inv.invoicedDate} onValueChange={(v) => save({ invoicedDate: v })} />,
    paid: <DatePicker size="sm" label={`Paid date de ${inv.number}`} value={inv.paidDate} onValueChange={(v) => save({ paidDate: v })} />,
    sustained: (
      <Select label={`Sustained de ${inv.number}`} size="sm" value={inv.sustained ? "yes" : "no"} options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]} renderValue={(o) => <span className={cn("rounded-md px-2 py-0.5 text-xs font-semibold", TONE_CLASS[o?.value === "yes" ? "ok" : "neutral"])}>{o?.label}</span>} onValueChange={(v) => save({ sustained: v === "yes" })} />
    ),
    project: <Select label={`Proyecto de ${inv.number}`} size="sm" value={inv.project.id} searchable options={projects.map((p) => ({ value: p.id, label: p.name }))} onValueChange={(v) => v && v !== inv.project.id && save({ projectId: v })} />,
    deal: <Select label={`Deal de ${inv.number}`} size="sm" value={inv.deal?.id ?? null} emptyLabel="Sin deal" options={deals.map((d) => ({ value: d.id, label: `${d.code} · ${d.title}` }))} onValueChange={(v) => save({ dealId: v })} />,
    hours: <HoursInput label={`Horas de ${inv.number}`} value={inv.hours} onSave={(hours) => save({ hours })} />,
    fee: <MoneyInput label={`Fee de ${inv.number}`} cents={inv.feeCents} onSave={(feeCents) => save({ feeCents })} />,
  };
}

function InvoiceRow({ inv, projects, onOpen, onDelete }: { inv: Invoice; projects: InvoiceProject[]; onOpen: () => void; onDelete: () => void }) {
  const f = useInvoiceFields(inv, projects);
  const td = "px-2 py-2 align-middle border-t border-border";
  return (
    <tr className="hover:bg-muted/40">
      <td className={td}>
        <button type="button" className="font-semibold whitespace-nowrap hover:underline" onClick={onOpen} title="Abrir detalle de la invoice">
          {inv.number}
        </button>
      </td>
      <td className={cn(td, "w-36")}>{f.month}</td>
      <td className={cn(td, "w-36")}>{f.stage}</td>
      <td className={cn(td, "w-40")}>{f.invoiced}</td>
      <td className={cn(td, "w-40")}>{f.paid}</td>
      <td className={cn(td, "w-24")}>{f.sustained}</td>
      <td className={cn(td, "w-48")}>{f.project}</td>
      <td className={cn(td, "w-52")}>{f.deal}</td>
      <td className={cn(td, "whitespace-nowrap")}>{inv.lead?.name ?? "—"}</td>
      <td className={cn(td, "whitespace-nowrap text-muted-foreground")}>{inv.paymentType ? PAYMENT_TYPE_LABELS[inv.paymentType] : "Sin definir"}</td>
      <td className={td}>{f.hours}</td>
      <td className={cn(td, "whitespace-nowrap text-muted-foreground tabular-nums")} title="Rate del deal">
        {money(inv.rateCents, inv.currency)}
      </td>
      <td className={cn(td, "whitespace-nowrap font-semibold tabular-nums")} title="Hours × Rate">
        {money(inv.grossCents, inv.currency)}
      </td>
      <td className={td}>{f.fee}</td>
      <td className={cn(td, "whitespace-nowrap font-bold tabular-nums")}>{money(inv.totalCents, inv.currency)}</td>
      <td className={cn(td, "text-center")}>
        <button type="button" aria-label={`Borrar ${inv.number}`} title="Borrar invoice" onClick={onDelete} className="inline-flex size-8 items-center justify-center rounded-lg text-destructive opacity-70 hover:bg-destructive/10 hover:opacity-100">
          <Trash2 className="size-4" />
        </button>
      </td>
    </tr>
  );
}

function InvoiceDetail({ inv, projects, onClose, onDelete }: { inv: Invoice; projects: InvoiceProject[]; onClose: () => void; onDelete: () => void }) {
  const f = useInvoiceFields(inv, projects);
  const field = (label: string, node: React.ReactNode) => (
    <div className="min-w-0 space-y-1.5">
      <p className="text-caps-label">{label}</p>
      <div className="flex min-h-control items-center text-sm">{node}</div>
    </div>
  );
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={inv.number}
      description={`${inv.project.name ?? "—"} · ${inv.deal ? `${inv.deal.code} · ${inv.deal.title}` : "Sin deal"}`}
      footer={
        <>
          <Button variant="ghost" className="text-destructive" onClick={onDelete}>
            <Trash2 /> Eliminar
          </Button>
          <Button onClick={onClose}>Cerrar</Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        {field("Stage", f.stage)}
        {field("Month", f.month)}
        {field("Invoiced date", f.invoiced)}
        {field("Paid date", f.paid)}
        {field("Sustained", f.sustained)}
        {field("Tipo de pago", inv.paymentType ? PAYMENT_TYPE_LABELS[inv.paymentType] : "Sin definir en el proyecto")}
        {field("Proyecto", f.project)}
        {field("Deal", f.deal)}
        {field("Team leader", inv.lead?.name ?? "—")}
        {field("Rate (del deal)", `${money(inv.rateCents, inv.currency)} / h`)}
        {field("Hours", f.hours)}
        {field("Monto bruto (Hours × Rate)", <b>{money(inv.grossCents, inv.currency)}</b>)}
        {field("Fee (opcional)", f.fee)}
      </div>
      <div className="mt-5 flex items-center justify-between rounded-xl border border-border bg-muted/30 px-4 py-3">
        <span className="text-caps-label">Total (monto bruto + fee)</span>
        <b className="text-2xl tracking-tight tabular-nums">{money(inv.totalCents, inv.currency)}</b>
      </div>
    </Drawer>
  );
}

/** Invoices: facturas por deal, agrupadas por stage. Monto bruto = Hours × Rate del deal; Total = bruto + fee. */
export default function InvoicesPage() {
  const { data, isLoading, error } = useInvoices();
  const run = useFinanceAction();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error || !data) return <p role="alert" className="text-sm text-destructive">{error instanceof Error ? error.message : "No se pudo cargar Invoices."}</p>;

  const all = data.invoices;
  const visible = all.filter((v) => !projectId || v.project.id === projectId);
  const sum = (f: (v: Invoice) => boolean) => all.filter(f).reduce((n, v) => n + v.totalCents, 0);
  const open = data.invoices.find((v) => v.id === openId);
  const remove = async (inv: Invoice) => {
    setOpenId(null);
    if (await run(() => invoicesApi.remove(inv.id))) toast.success(`${inv.number} eliminada`, { undo: () => run(() => invoicesApi.restore(inv.id)) });
  };
  const create = async () => {
    const target = projectId ?? data.projects[0]?.id;
    if (!target) return;
    const created = await run(() => invoicesApi.create({ projectId: target }));
    if (created) toast.success(`${created.invoice.number} creada`);
  };
  const columns = ["Invoice", "Month", "Stage", "Invoiced date", "Paid date", "Sustained", "Proyecto", "Deal", "Team leader", "Tipo de pago", "Hours", "Rate", "Monto bruto", "Fee", "Total", ""];

  return (
    <div className="space-y-6">
      <PageHeader
        stackOnMobile
        title="Invoices"
        description={<span className="max-sm:hidden">Facturas por deal. Un deal puede tener varias invoices; el team leader y el tipo de pago vienen del proyecto.</span>}
        actions={
          <Button size="lg" disabled={!data.projects.length} onClick={() => void create()}>
            <Plus /> Nueva <span className="max-sm:hidden">invoice</span>
          </Button>
        }
      />
      <KpiRow label="Resumen de invoices">
        <Kpi label="Total invoices" value={money(sum(() => true))} />
        <Kpi label="Upcoming" value={money(sum((v) => v.effectiveStage === "upcoming"))} />
        <Kpi label="Cobrado" value={money(sum((v) => v.effectiveStage === "paid"))} />
        <Kpi label="Por cobrar" value={money(sum((v) => ["invoiced", "due", "follow_up"].includes(v.effectiveStage)))} sub="Invoiced, Due y Follow Up" />
        <Kpi label="Vencido" value={money(sum((v) => v.effectiveStage === "overdue"))} />
      </KpiRow>
      <div className="w-full sm:w-72">
        <Select label="Filtrar por proyecto" value={projectId} emptyLabel="Todos los proyectos" options={data.projects.map((p) => ({ value: p.id, label: p.name }))} onValueChange={setProjectId} />
      </div>
      {!visible.length ? (
        <p className="rounded-2xl border border-border bg-card p-10 text-center text-sm text-muted-foreground">
          <b className="block text-foreground">Sin invoices</b>
          Crea la primera con «Nueva invoice».
        </p>
      ) : (
        <div className="max-h-[70vh] overflow-auto rounded-2xl border border-border bg-card">
          <table className="w-full min-w-[110rem] border-separate border-spacing-0 text-sm">
            <caption className="sr-only">Invoices</caption>
            <thead>
              <tr>
                {columns.map((c, i) => (
                  <th key={i} scope="col" className="text-caps-label sticky top-0 z-10 border-b border-border bg-card px-2 py-2.5 text-left font-semibold">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {INVOICE_STAGES.map((stage) => {
                const rows = visible.filter((v) => v.effectiveStage === stage);
                if (!rows.length) return null;
                return (
                  <Fragment key={stage}>
                    <tr>
                      <td colSpan={columns.length} className="px-3 pt-5 pb-2">
                        <span className="flex items-center gap-2">
                          <span aria-hidden className={cn("h-5 w-1 rounded-full", TONE_DOT[INVOICE_STAGE_TONE[stage]])} />
                          <b className="text-base">{INVOICE_STAGE_LABELS[stage]}</b>
                          <span className="text-xs text-muted-foreground">
                            {rows.length} {rows.length === 1 ? "invoice" : "invoices"} · {money(rows.reduce((n, v) => n + v.totalCents, 0))}
                          </span>
                        </span>
                      </td>
                    </tr>
                    {rows.map((inv) => (
                      <InvoiceRow key={inv.id} inv={inv} projects={data.projects} onOpen={() => setOpenId(inv.id)} onDelete={() => void remove(inv)} />
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {open && <InvoiceDetail inv={open} projects={data.projects} onClose={() => setOpenId(null)} onDelete={() => void remove(open)} />}
    </div>
  );
}
