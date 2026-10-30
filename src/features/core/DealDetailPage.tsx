import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ExternalLink, Loader2, Plus, Save } from "lucide-react";
import { tableSelectClass } from "@/components/data-table/DataTable";
import { TotalCell } from "@/components/data-table/cells";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/features/auth/auth";
import { DEAL_STATUS_LABELS, type DealStatus } from "@/features/ops/api";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  CHANGE_ORDER_STATUS_LABELS,
  CHANGE_ORDER_STATUSES,
  createChangeOrder,
  SALE_TYPE_LABELS,
  SALE_TYPES,
  SALES_STAGE_LABELS,
  SALES_STAGES,
  updateChangeOrder,
  updateDeal,
  useContactOptions,
  useDeal,
  type ChangeOrderStatus,
  type Deal,
  type DealInput,
  type SaleType,
  type SalesStage,
} from "./api";
import { DealStatusBadge } from "./DealsTable";
import { dealLocked, useDealRefresh, useDealStatusOptions } from "./hooks";

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

function Field({ label, htmlFor, children, className }: { label: string; htmlFor?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <div className="text-sm">{children}</div>
    </div>
  );
}

/** Texto ↔ número/nulo para los inputs del formulario. */
const num = (v: string) => (v.trim() === "" ? null : Number(v.replace(",", ".")));
const orNull = (v: string) => (v.trim() ? v.trim() : null);

/** Formulario del deal: guarda solo lo que cambió. Horas y tarifa se bloquean una vez facturado. */
function DealForm({ deal }: { deal: Deal }) {
  const refresh = useDealRefresh();
  const statuses = useDealStatusOptions();
  const role = useSession().data?.role;
  const locked = dealLocked(deal);
  const pickContacts = role === "boss" || role === "commercial";
  const contacts = useContactOptions(null, pickContacts).data ?? [];
  const initial = {
    title: deal.title,
    description: deal.description,
    salesStage: deal.salesStage,
    status: deal.status,
    hours: String(deal.hours),
    rate: String(deal.rateCents / 100),
    probability: String(deal.probability),
    currency: deal.currency,
    expectedCloseDate: deal.expectedCloseDate ?? "",
    actualCloseDate: deal.actualCloseDate ?? "",
    saleType: deal.saleType ?? "",
    product: deal.product ?? "",
    channel: deal.channel ?? "",
    lostReason: deal.lostReason ?? "",
    partnerCommissionPct: deal.partnerCommissionPct === null ? "" : String(deal.partnerCommissionPct),
    proposalUrl: deal.proposalUrl ?? "",
    sowUrl: deal.sowUrl ?? "",
    contactIds: deal.contacts.map((c) => c.id),
  };
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setSaved(false);
    setForm((f) => ({ ...f, [key]: value }));
  };

  function patch(): Partial<DealInput> {
    const out: Partial<DealInput> = {};
    const changed = <K extends keyof typeof form>(key: K) => JSON.stringify(form[key]) !== JSON.stringify(initial[key]);
    if (changed("title")) out.title = form.title.trim();
    if (changed("description")) out.description = form.description;
    if (changed("salesStage")) out.salesStage = form.salesStage;
    if (changed("status")) out.status = form.status;
    if (changed("hours")) out.hours = num(form.hours) ?? 0;
    if (changed("rate")) out.rateCents = Math.round((num(form.rate) ?? 0) * 100);
    if (changed("probability")) out.probability = num(form.probability) ?? 0;
    if (changed("currency")) out.currency = form.currency.trim().toUpperCase();
    if (changed("expectedCloseDate")) out.expectedCloseDate = orNull(form.expectedCloseDate);
    if (changed("actualCloseDate")) out.actualCloseDate = orNull(form.actualCloseDate);
    if (changed("saleType")) out.saleType = (form.saleType || null) as SaleType | null;
    if (changed("product")) out.product = orNull(form.product);
    if (changed("channel")) out.channel = orNull(form.channel);
    if (changed("lostReason")) out.lostReason = orNull(form.lostReason);
    if (changed("partnerCommissionPct")) out.partnerCommissionPct = num(form.partnerCommissionPct);
    if (changed("proposalUrl")) out.proposalUrl = orNull(form.proposalUrl);
    if (changed("sowUrl")) out.sowUrl = orNull(form.sowUrl);
    if (changed("contactIds")) out.contactIds = form.contactIds;
    return out;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = patch();
    if (!Object.keys(body).length) return;
    setBusy(true);
    setError(null);
    try {
      await updateDeal(deal.id, body);
      await refresh(deal.project?.id);
      setSaved(true);
    } catch (err) {
      setError(message(err, "No se pudo guardar el deal."));
    } finally {
      setBusy(false);
    }
  }

  const text = (key: "title" | "product" | "channel" | "lostReason" | "proposalUrl" | "sowUrl", label: string, placeholder?: string, className?: string) => (
    <Field label={label} htmlFor={`deal-${key}`} className={className}>
      <Input id={`deal-${key}`} value={form[key]} placeholder={placeholder} onChange={(e) => set(key, e.target.value)} />
    </Field>
  );

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {text("title", "Nombre", undefined, "sm:col-span-2")}
        <Field label="Estado de venta" htmlFor="deal-salesStage">
          <select id="deal-salesStage" className={cn(tableSelectClass, "w-full")} value={form.salesStage} onChange={(e) => set("salesStage", e.target.value as SalesStage)}>
            {SALES_STAGES.map((s) => (
              <option key={s} value={s}>
                {SALES_STAGE_LABELS[s]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Estado" htmlFor="deal-status">
          <select id="deal-status" className={cn(tableSelectClass, "w-full")} value={form.status} onChange={(e) => set("status", e.target.value as DealStatus)}>
            {(statuses.includes(deal.status) ? statuses : [deal.status, ...statuses]).map((s) => (
              <option key={s} value={s}>
                {DEAL_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Horas" htmlFor="deal-hours">
          <Input id="deal-hours" inputMode="decimal" disabled={locked} value={form.hours} onChange={(e) => set("hours", e.target.value)} />
        </Field>
        <Field label="Tarifa por hora" htmlFor="deal-rate">
          <Input id="deal-rate" inputMode="decimal" disabled={locked} value={form.rate} onChange={(e) => set("rate", e.target.value)} />
        </Field>
        <Field label="Moneda" htmlFor="deal-currency">
          <Input id="deal-currency" maxLength={3} disabled={locked} value={form.currency} onChange={(e) => set("currency", e.target.value)} />
        </Field>
        <Field label="Probabilidad (%)" htmlFor="deal-probability">
          <Input id="deal-probability" inputMode="numeric" value={form.probability} onChange={(e) => set("probability", e.target.value)} />
        </Field>
        <Field label="Cierre estimado" htmlFor="deal-expected">
          <Input id="deal-expected" type="date" value={form.expectedCloseDate} onChange={(e) => set("expectedCloseDate", e.target.value)} />
        </Field>
        <Field label="Cierre real" htmlFor="deal-actual">
          <Input id="deal-actual" type="date" value={form.actualCloseDate} onChange={(e) => set("actualCloseDate", e.target.value)} />
        </Field>
        <Field label="Tipo de venta" htmlFor="deal-saleType">
          <select id="deal-saleType" className={cn(tableSelectClass, "w-full")} value={form.saleType} onChange={(e) => set("saleType", e.target.value)}>
            <option value="">Sin definir</option>
            {SALE_TYPES.map((s) => (
              <option key={s} value={s}>
                {SALE_TYPE_LABELS[s]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Comisión del partner (%)" htmlFor="deal-partner">
          <Input id="deal-partner" inputMode="decimal" value={form.partnerCommissionPct} onChange={(e) => set("partnerCommissionPct", e.target.value)} />
        </Field>
        {text("product", "Producto")}
        {text("channel", "Canal")}
        {text("proposalUrl", "Propuesta (enlace)", "https://…", "sm:col-span-2")}
        {text("sowUrl", "SOW (enlace)", "https://…", "sm:col-span-2")}
        {(form.salesStage === "lost" || form.lostReason) && text("lostReason", "Razón de pérdida", undefined, "sm:col-span-2 lg:col-span-4")}
        <Field label="Descripción" htmlFor="deal-description" className="sm:col-span-2 lg:col-span-4">
          <textarea
            id="deal-description"
            rows={3}
            className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
          />
        </Field>
        {pickContacts && (
          <Field label="Contactos" className="sm:col-span-2 lg:col-span-4">
            {contacts.length ? (
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {contacts.map((c) => (
                  <label key={c.id} className="inline-flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      className="accent-primary"
                      checked={form.contactIds.includes(c.id)}
                      onChange={(e) => set("contactIds", e.target.checked ? [...form.contactIds, c.id] : form.contactIds.filter((id) => id !== c.id))}
                    />
                    {c.name}
                    {c.company && <span className="text-xs text-muted-foreground">· {c.company.name}</span>}
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground">Aún no hay contactos.</p>
            )}
          </Field>
        )}
      </div>
      {locked && <p className="text-xs text-muted-foreground">El deal ya está facturado o cobrado: las horas y la tarifa no cambian. Los cambios van como change order.</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy || !Object.keys(patch()).length}>
          {busy ? <Loader2 className="animate-spin" /> : <Save />}
          Guardar cambios
        </Button>
        {saved && <span className="text-sm text-muted-foreground">Guardado.</span>}
      </div>
    </form>
  );
}

function ChangeOrders({ deal }: { deal: Deal }) {
  const refresh = useDealRefresh();
  const [description, setDescription] = useState("");
  const [hours, setHours] = useState("");
  const [rate, setRate] = useState(String(deal.rateCents / 100));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const orders = deal.changeOrders ?? [];
  const hoursValue = Number(hours);
  const rateCents = Math.round(Number(rate) * 100);
  const valid = description.trim().length >= 3 && hours !== "" && hoursValue >= 0 && rate !== "" && rateCents >= 0;

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await createChangeOrder(deal.id, { description: description.trim(), hours: hoursValue, rateCents });
      setDescription("");
      setHours("");
      await refresh(deal.project?.id);
    } catch (err) {
      setError(message(err, "No se pudo crear el change order."));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(id: string, status: ChangeOrderStatus) {
    setError(null);
    try {
      await updateChangeOrder(deal.id, id, { status });
      await refresh(deal.project?.id);
    } catch (err) {
      setError(message(err, "No se pudo cambiar el estado."));
    }
  }

  return (
    <div className="space-y-3">
      {deal.canEdit && (
        <form onSubmit={add} className="grid items-end gap-3 rounded-lg border border-foreground/10 p-3 sm:grid-cols-[2fr_1fr_1fr_auto]">
          <Field label="Cambio" htmlFor="co-description">
            <Input id="co-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Reporte adicional de ventas" />
          </Field>
          <Field label="Horas" htmlFor="co-hours">
            <Input id="co-hours" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="8" />
          </Field>
          <Field label="Tarifa por hora" htmlFor="co-rate">
            <Input id="co-rate" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
          </Field>
          <Button type="submit" disabled={!valid || busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Plus />}
            Agregar
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!orders.length ? (
        <p className="text-sm text-muted-foreground">Este deal no tiene change orders.</p>
      ) : (
        <ul className="divide-y divide-foreground/10 rounded-lg border border-foreground/10">
          {orders.map((co) => (
            <li key={co.id} className="grid items-center gap-2 p-3 text-sm sm:grid-cols-[minmax(0,2fr)_auto_auto_10rem]">
              <div className="min-w-0">
                <p className="font-medium">{co.description}</p>
                <p className="text-xs text-muted-foreground">{co.approvedAt ? `Aprobado el ${formatDate(co.approvedAt)}` : `Creado el ${formatDate(co.createdAt)}`}</p>
              </div>
              <span className="tabular-nums">
                <TotalCell hours={co.hours} /> × <TotalCell cents={co.rateCents} currency={deal.currency} />
              </span>
              <TotalCell cents={co.amountCents} currency={deal.currency} strong />
              {deal.canEdit ? (
                <select aria-label={`Estado de ${co.description}`} className={cn(tableSelectClass, "w-full")} value={co.status} onChange={(e) => void setStatus(co.id, e.target.value as ChangeOrderStatus)}>
                  {CHANGE_ORDER_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {CHANGE_ORDER_STATUS_LABELS[s]}
                    </option>
                  ))}
                </select>
              ) : (
                <span>{CHANGE_ORDER_STATUS_LABELS[co.status]}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function DealDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error } = useDeal(id);
  const back = (
    <button type="button" onClick={() => navigate(-1)} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="size-4" /> Volver
    </button>
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="space-y-4">
        {back}
        <p role="alert" className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Deal no encontrado."}
        </p>
      </div>
    );
  }

  const { deal } = data;
  return (
    <div className="space-y-6">
      <div>
        {back}
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <span className="rounded-md border border-foreground/15 px-2 py-0.5 text-sm tabular-nums text-muted-foreground">{deal.dealCode}</span>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{deal.title}</h1>
          <DealStatusBadge value={deal.status} />
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          {deal.project ? (
            <Link className="text-primary underline-offset-4 hover:underline" to={`/operativa/${deal.project.id}`}>
              {deal.project.name} · {deal.project.customerName}
            </Link>
          ) : (
            <span>Sin proyecto</span>
          )}
          {deal.lead && (
            <Link className="text-primary underline-offset-4 hover:underline" to={`/comercial/leads/${deal.lead.id}`}>
              Lead: {deal.lead.title}
            </Link>
          )}
          {deal.contacts.map((c) => (
            <Link key={c.id} className="text-primary underline-offset-4 hover:underline" to={`/comercial/contactos/${c.id}`}>
              {c.name}
            </Link>
          ))}
          {deal.proposalUrl && (
            <a className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline" href={deal.proposalUrl} target="_blank" rel="noreferrer">
              Propuesta <ExternalLink className="size-3.5" />
            </a>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        {[
          { label: "Horas", value: <TotalCell hours={deal.hours} strong /> },
          { label: "Valor (horas × tarifa)", value: <TotalCell cents={deal.amountCents} currency={deal.currency} strong /> },
          { label: "Probabilidad", value: <span className="font-medium">{deal.probability}%</span> },
          { label: "Valor proyectado", value: <TotalCell cents={deal.projectedCents} currency={deal.currency} strong /> },
        ].map((k) => (
          <Card key={k.label} size="sm">
            <CardContent>
              <p className="text-xs text-muted-foreground">{k.label}</p>
              <p className="mt-1 text-lg">{k.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Datos del deal</CardTitle>
        </CardHeader>
        <CardContent>
          {deal.canEdit ? (
            <DealForm key={deal.updatedAt} deal={deal} />
          ) : (
            <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              {[
                ["Estado de venta", SALES_STAGE_LABELS[deal.salesStage]],
                ["Estado", DEAL_STATUS_LABELS[deal.status]],
                ["Tarifa por hora", <TotalCell key="r" cents={deal.rateCents} currency={deal.currency} />],
                ["Tipo de venta", deal.saleType ? SALE_TYPE_LABELS[deal.saleType] : "—"],
                ["Cierre estimado", deal.expectedCloseDate ? formatDate(deal.expectedCloseDate) : "—"],
                ["Cierre real", deal.actualCloseDate ? formatDate(deal.actualCloseDate) : "—"],
                ["Producto", deal.product ?? "—"],
                ["Canal", deal.channel ?? "—"],
                ["Responsable", deal.owner?.name ?? "—"],
                ["Comisión del partner", deal.partnerCommissionPct === null ? "—" : `${deal.partnerCommissionPct}%`],
                ...(deal.lostReason ? [["Razón de pérdida", deal.lostReason]] : []),
              ].map(([label, value]) => (
                <div key={String(label)}>
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
              {deal.description && <p className="whitespace-pre-wrap sm:col-span-2 lg:col-span-4">{deal.description}</p>}
            </dl>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Change orders</CardTitle>
        </CardHeader>
        <CardContent>
          <ChangeOrders deal={deal} />
        </CardContent>
      </Card>
    </div>
  );
}
