import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { DatePicker } from "@/components/ui/date-picker";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Loader2, Plus, Save } from "lucide-react";
import { TotalCell } from "@/components/data-table/cells";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/features/auth/auth";
import { ActivitiesTable } from "@/features/commercial/ActivitiesTable";
import { createProposal, usePartnerOptions, useProposals } from "@/features/commercial/api";
import { UpdatesPanel } from "@/features/activity/ActivityPanels";
import { dateText, MEETING_KIND_LABELS, REVIEW_STATUS_LABELS, type MeetingKind, type MeetingReviewStatus } from "@/features/activity/api";
import { DEAL_STATUS_LABELS, PROPOSAL_STATUS_LABELS, type DealStatus } from "@/features/ops/api";
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
  dealBase,
  updateDeal,
  useContactOptions,
  useDeal,
  useDealMeetings,
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
  const partners = usePartnerOptions(pickContacts).data ?? [];
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
    partnerId: deal.partner?.id ?? "",
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
    if (changed("partnerId")) out.partnerId = form.partnerId || null;
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
          <Select
            id="deal-salesStage"
            value={form.salesStage}
            options={SALES_STAGES.map((s) => ({ value: s, label: SALES_STAGE_LABELS[s] }))}
            onValueChange={(v) => set("salesStage", (v ?? "") as SalesStage)}
          />
        </Field>
        <Field label="Estado" htmlFor="deal-status">
          <Select
            id="deal-status"
            value={form.status}
            options={(statuses.includes(deal.status) ? statuses : [deal.status,...statuses]).map((s) => ({ value: s, label: DEAL_STATUS_LABELS[s] }))}
            onValueChange={(v) => set("status", (v ?? "") as DealStatus)}
          />
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
          <DatePicker id="deal-expected" label="Cierre estimado" value={form.expectedCloseDate || null} onValueChange={(v) => set("expectedCloseDate", v ?? "")} />
        </Field>
        <Field label="Cierre real" htmlFor="deal-actual">
          <DatePicker id="deal-actual" label="Cierre real" value={form.actualCloseDate || null} onValueChange={(v) => set("actualCloseDate", v ?? "")} />
        </Field>
        <Field label="Tipo de venta" htmlFor="deal-saleType">
          <Select
            id="deal-saleType"
            value={form.saleType || null}
            emptyLabel="Sin definir"
            options={SALE_TYPES.map((s) => ({ value: s, label: SALE_TYPE_LABELS[s] }))}
            onValueChange={(v) => set("saleType", (v ?? ""))}
          />
        </Field>
        {pickContacts && (
          <Field label="Partner" htmlFor="deal-partner-id">
            <Select
              id="deal-partner-id"
              value={form.partnerId || null}
              emptyLabel="Sin partner"
              options={partners.map((p) => ({ value: p.id, label: `${p.name} (${p.commissionPct}%)` }))}
              onValueChange={(v) => set("partnerId", (v ?? ""))}
            />
          </Field>
        )}
        <Field label="Comisión del partner (%)" htmlFor="deal-partner">
          <Input id="deal-partner" inputMode="decimal" value={form.partnerCommissionPct} onChange={(e) => set("partnerCommissionPct", e.target.value)} />
        </Field>
        {text("product", "Producto")}
        {text("channel", "Canal")}
        {text("proposalUrl", "Propuesta (enlace)", "https://…", "sm:col-span-2")}
        {text("sowUrl", "SOW (enlace)", "https://…", "sm:col-span-2")}
        {(form.salesStage === "lost" || form.lostReason) && text("lostReason", "Razón de pérdida", undefined, "sm:col-span-2 lg:col-span-4")}
        <Field label="Descripción" htmlFor="deal-description" className="sm:col-span-2 lg:col-span-4">
          <Textarea
            id="deal-description"
            rows={3}
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
                <Select
                  label={`Estado de ${co.description}`}
                  value={co.status}
                  options={CHANGE_ORDER_STATUSES.map((s) => ({ value: s, label: CHANGE_ORDER_STATUS_LABELS[s] }))}
                  onValueChange={(v) => void setStatus(co.id, (v ?? "") as ChangeOrderStatus)}
                />
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
                ["Partner", deal.partner?.name ?? "—"],
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

      <DealSections deal={deal} />
    </div>
  );
}

type SectionId = "activities" | "proposals" | "meetings" | "updates";

/** Lo comercial del deal (§4.1): actividades, propuestas, reuniones donde se habló de él y su bitácora. */
function DealSections({ deal }: { deal: Deal }) {
  const role = useSession().data?.role;
  const salesSide = role === "boss" || role === "commercial" || role === "finance";
  const [tab, setTab] = useState<SectionId>(salesSide ? "activities" : "meetings");
  const meetings = useDealMeetings(deal.id).data ?? [];
  const tabs: { id: SectionId; label: string; visible: boolean }[] = [
    { id: "activities", label: "Actividades", visible: salesSide },
    { id: "proposals", label: "Propuestas", visible: salesSide },
    { id: "meetings", label: `Reuniones (${meetings.length})`, visible: true },
    { id: "updates", label: "Bitácora", visible: true },
  ];
  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Secciones del deal" className="-mx-4 flex gap-1 overflow-x-auto border-b border-foreground/10 px-4 sm:mx-0 sm:px-0">
        {tabs
          .filter((t) => t.visible)
          .map((t) => (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn("-mb-px shrink-0 border-b-2 px-3 py-2 text-sm whitespace-nowrap", tab === t.id ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}
            >
              {t.label}
            </button>
          ))}
      </div>
      <div role="tabpanel">
        {tab === "activities" && salesSide && <ActivitiesTable dealId={deal.id} prefix="a." />}
        {tab === "proposals" && salesSide && <DealProposals deal={deal} canWrite={role === "boss" || role === "commercial"} />}
        {tab === "meetings" &&
          (!meetings.length ? (
            <p className="text-sm text-muted-foreground">Ninguna reunión está ligada a este deal. Se liga desde la reunión, en el proyecto o el lead.</p>
          ) : (
            <ul className="divide-y divide-foreground/10 rounded-lg border border-foreground/10">
              {meetings.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-2 p-3 text-sm">
                  <Link className="font-medium text-primary underline-offset-4 hover:underline" to={m.owner.kind === "project" ? `/operativa/${m.owner.id}` : `/comercial/leads/${m.owner.id}`}>
                    {m.title}
                  </Link>
                  {m.kind && <span className="text-xs text-muted-foreground">{MEETING_KIND_LABELS[m.kind as MeetingKind] ?? m.kind}</span>}
                  <span className="text-xs text-muted-foreground">{REVIEW_STATUS_LABELS[m.reviewStatus as MeetingReviewStatus] ?? m.reviewStatus}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{dateText(m.heldAt)}</span>
                </li>
              ))}
            </ul>
          ))}
        {tab === "updates" && <UpdatesPanel base={dealBase(deal.id)} canWork={deal.canEdit || role === "boss" || role === "commercial"} />}
      </div>
    </div>
  );
}

/** Cotizaciones del deal; desde aquí se crea una nueva ligada al deal. */
function DealProposals({ deal, canWrite }: { deal: Deal; canWrite: boolean }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = `dealId=${deal.id}&pageSize=100&sort=createdAt&dir=desc`;
  const { data, isLoading } = useProposals(query);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState(deal.proposalUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = title.trim().length >= 3 && /^https?:\/\//i.test(url.trim());

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const { proposal } = await createProposal({ title: title.trim(), url: url.trim(), dealId: deal.id, currency: deal.currency });
      await queryClient.invalidateQueries({ queryKey: ["commercial"] });
      navigate(`/comercial/propuestas/${proposal.id}`);
    } catch (err) {
      setError(message(err, "No se pudo crear la propuesta."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {canWrite && (
        <form onSubmit={add} className="grid items-end gap-3 rounded-lg border border-foreground/10 p-3 sm:grid-cols-[1.5fr_2fr_auto]">
          <Field label="Propuesta" htmlFor="dp-title">
            <Input id="dp-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Propuesta del módulo" />
          </Field>
          <Field label="Enlace" htmlFor="dp-url">
            <Input id="dp-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
          </Field>
          <Button type="submit" disabled={!valid || busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Plus />}
            Crear
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {isLoading ? (
        <Skeleton className="h-12 w-full" />
      ) : !data?.rows.length ? (
        <p className="text-sm text-muted-foreground">Este deal no tiene propuestas.</p>
      ) : (
        <ul className="divide-y divide-foreground/10 rounded-lg border border-foreground/10">
          {data.rows.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 p-3 text-sm">
              <Link className="font-medium text-primary underline-offset-4 hover:underline" to={`/comercial/propuestas/${p.id}`}>
                {p.title}
              </Link>
              <span className="text-xs text-muted-foreground">{PROPOSAL_STATUS_LABELS[p.status]}</span>
              <span className="ml-auto">
                <TotalCell cents={p.amountCents} currency={p.currency} strong />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
