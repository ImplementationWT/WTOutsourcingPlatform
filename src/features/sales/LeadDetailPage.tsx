import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, Check as CheckIcon, ChevronRight, ExternalLink, FilePlus2, FileText, Handshake, ListPlus, Loader2, Mail, MessageSquarePlus, MonitorPlay, MoreHorizontal, Pencil, Phone, Plus } from "lucide-react";
import { useCrumbs } from "@/components/layout/crumbs";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DatePicker, DateTimePicker } from "@/components/ui/date-picker";
import { CopyButton, EditableText } from "@/components/ui/editable";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Empty, ErrorLine, MeetingsPanel, UpdatesPanel } from "@/features/activity/ActivityPanels";
import { activityKeys, dateText } from "@/features/activity/api";
import { ActivitiesTable } from "@/features/commercial/ActivitiesTable";
import { useContactOptions } from "@/features/core/api";
import { DealStatusBadge } from "@/features/core/DealsTable";
import { money, PROPOSAL_STATUS_LABELS, PROPOSAL_STATUSES, STAGE_LABELS, type Proposal, type ProposalStatus } from "@/features/ops/api";
import { formatDate, formatDateTime } from "@/lib/format";
import { errorText, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  addDemoLearning,
  createDemo,
  createLeadProposal,
  DEMO_STATUS_LABELS,
  DEMO_STATUSES,
  LEAD_FUNNEL_LABELS,
  LEAD_FUNNELS,
  LEAD_STATUS_LABELS,
  LEAD_STATUSES,
  LEAD_TEMPERATURE_LABELS,
  LEAD_TEMPERATURES,
  leadBase,
  salesKeys,
  updateDemo,
  updateLead,
  updateLeadProposal,
  useLead,
  useOwners,
  type Demo,
  type DemoStatus,
  type LeadDetail,
  type LeadFunnel,
  type LeadInput,
  type LeadStatus,
  type LeadTemperature,
} from "./api";
import { ResponseNotice } from "./LeadPanel";
import { LeadStatusBadge } from "./SalesBadges";
import { useCreateDeal } from "./use-create-deal";

type TabId = "updates" | "activities" | "demos" | "proposals" | "deals" | "meetings" | "data";

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

function useRefresh(id: string) {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: salesKeys.lead(id) }),
      queryClient.invalidateQueries({ queryKey: ["sales", "leads"] }),
      queryClient.invalidateQueries({ queryKey: activityKeys.updates(leadBase(id)) }),
    ]);
  };
}

/** Lo que había antes de un cambio, para «Deshacer». */
function previousOf(lead: LeadDetail, patch: Partial<LeadInput>): Partial<LeadInput> {
  const before: Partial<LeadInput> = {};
  const current: Record<keyof LeadInput, unknown> = {
    company: lead.company,
    contactName: lead.contactName,
    email: lead.email,
    phone: lead.phone,
    notes: lead.notes,
    status: lead.status,
    setterUserId: lead.setter?.id ?? null,
    closerUserId: lead.closer?.id ?? null,
    funnel: lead.funnel,
    temperature: lead.temperature,
    submittedAt: lead.submittedAt,
    meetingAt: lead.meetingAt,
    proposalUrl: lead.proposalUrl,
    contactId: lead.contactId,
    source: lead.source,
    lostReason: lead.lostReason,
  };
  for (const key of Object.keys(patch) as (keyof LeadInput)[]) (before as Record<string, unknown>)[key] = current[key];
  return before;
}

/** Guarda un cambio del lead con aviso «Guardado» y «Deshacer». */
function useSaveLead(lead: LeadDetail) {
  const refresh = useRefresh(lead.id);
  return async (patch: Partial<LeadInput>, what = "Cambio guardado") => {
    const before = previousOf(lead, patch);
    await updateLead(lead.id, patch);
    await refresh();
    toast.success(what, {
      undo: async () => {
        await updateLead(lead.id, before);
        await refresh();
      },
    });
  };
}

/** Tarjeta de sección del detalle. */
function Panel({ title, children, action, className }: { title: string; children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>{title}</CardTitle>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** Campo con etiqueta en mayúsculas sobre el control (formularios del detalle). */
function Field({ label, htmlFor, children, className }: { label: string; htmlFor?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <label htmlFor={htmlFor} className="text-caps-label block">
        {label}
      </label>
      {children}
    </div>
  );
}

/** Texto editable con aspecto de campo (borde y fondo), para los formularios del detalle. */
const boxed = "h-control border-input bg-card px-3 hover:border-foreground/20 dark:bg-white/[0.03]";

/** Correo o teléfono: enlace con icono (color de texto, acento al pasar el cursor) y botón de copiar. */
function ContactLink({ kind, value, onEdit, canWrite }: { kind: "email" | "phone"; value: string | null; onEdit: (v: string | null) => Promise<unknown>; canWrite: boolean }) {
  const [editing, setEditing] = useState(false);
  const label = kind === "email" ? "Correo" : "Teléfono";
  if (!value || editing) {
    return (
      <EditableText
        label={label}
        type={kind === "email" ? "email" : "tel"}
        value={value}
        placeholder={kind === "email" ? "Agregar correo" : "Agregar teléfono"}
        disabled={!canWrite}
        onSave={async (v) => {
          await onEdit(v);
          setEditing(false);
        }}
      />
    );
  }
  const Icon = kind === "email" ? Mail : Phone;
  const href = kind === "email" ? `mailto:${value}` : `tel:${value.replace(/[^\d+]/g, "")}`;
  return (
    <div className="flex min-h-control min-w-0 items-center gap-2">
      <a href={href} className="inline-flex min-w-0 items-center gap-1.5 text-sm font-semibold text-foreground underline-offset-4 transition-colors hover:text-primary hover:underline">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">{value}</span>
      </a>
      <CopyButton value={value} label={label} text />
      {canWrite && (
        <button type="button" aria-label={`Editar ${label}`} title={`Editar ${label}`} className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground pointer-coarse:size-10" onClick={() => setEditing(true)}>
          <Pencil className="size-3.5" />
        </button>
      )}
    </div>
  );
}

type LeadData = NonNullable<ReturnType<typeof useLead>["data"]>;

function Check({ ok, children, action }: { ok: boolean; children: ReactNode; action?: ReactNode }) {
  return (
    <li className="flex items-center gap-2.5 text-sm">
      <span aria-hidden className={cn("flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold", ok ? "bg-ok/15 text-ok-fg" : "bg-warn/15 text-warn-fg")}>
        {ok ? <CheckIcon className="size-3" /> : "!"}
      </span>
      <span className="flex-1">{children}</span>
      {action}
    </li>
  );
}

/** Siguiente paso del lead: el deal (con lo que conviene tener antes) o los deals que ya tiene. */
function DealCard({ data, canWrite, onOpenProposals }: { data: LeadData; canWrite: boolean; onOpenProposals: () => void }) {
  const { lead, deals, proposals } = data;
  const { create, busy } = useCreateDeal(lead);
  const contactReady = Boolean(lead.contactName && (lead.email || lead.phone));
  const accepted = proposals.some((p) => p.status === "accepted");
  return (
    <Panel title={deals.length ? "Deals" : "Crear deal"}>
      <div className="space-y-4">
        {deals.length ? (
          <ul className="-mx-1 space-y-1">
            {deals.map((d) => (
              <li key={d.id}>
                <Link to={`/deals/${d.id}`} className="flex items-center gap-2 rounded-lg px-1 py-1.5 text-sm transition-colors hover:bg-accent">
                  <span className="text-xs text-muted-foreground tabular-nums">{d.dealCode}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{d.title}</span>
                  <DealStatusBadge value={d.status} />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">Crea el deal ligado a este lead y a su contacto. Horas, tarifa y probabilidad se completan después.</p>
            <ul className="space-y-2.5">
              <Check ok={contactReady}>Datos de contacto completos</Check>
              <Check
                ok={accepted}
                action={
                  !accepted && (
                    <button type="button" onClick={onOpenProposals} className="text-sm font-semibold text-primary underline underline-offset-4 hover:opacity-80">
                      Registrar
                    </button>
                  )
                }
              >
                Propuesta aceptada
              </Check>
            </ul>
          </>
        )}
        {canWrite && (
          <Button variant={deals.length ? "outline" : "secondary"} className="w-full" loading={busy} onClick={() => void create()}>
            {!busy && <Plus />}
            {deals.length ? "Crear otro deal" : "Crear deal"}
          </Button>
        )}
      </div>
    </Panel>
  );
}

/** Tiempo de respuesta: días entre la submission y la reunión, o qué fecha falta. */
function ResponseCard({ lead, onFixDates }: { lead: LeadDetail; onFixDates: () => void }) {
  return (
    <Panel title="Respuesta">
      {lead.responseDays === null ? (
        <ResponseNotice lead={lead} onFix={onFixDates} />
      ) : (
        <div>
          <p className="text-3xl font-bold tracking-tight tabular-nums">{lead.responseDays} d</p>
          <p className="mt-1 text-sm text-muted-foreground">Desde la submission hasta la reunión.</p>
        </div>
      )}
    </Panel>
  );
}

/** Deals del lead, con acceso directo a crear uno nuevo. */
function DealsTab({ data, canWrite }: { data: LeadData; canWrite: boolean }) {
  const { lead, deals } = data;
  const { create, busy } = useCreateDeal(lead);
  if (!deals.length) {
    return (
      <EmptyState
        icon={Handshake}
        title="Este lead aún no tiene deals"
        description="Crea el deal cuando haya algo concreto que vender: horas, tarifa y probabilidad se completan después."
        action={
          canWrite ? (
            <Button variant="outline" onClick={() => void create()} loading={busy}>
              {!busy && <Plus />}
              Crear deal
            </Button>
          ) : undefined
        }
      />
    );
  }
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
      {deals.map((d) => (
        <li key={d.id}>
          <Link to={`/deals/${d.id}`} className="flex flex-wrap items-center gap-3 p-3 transition-colors hover:bg-accent/40">
            <span className="text-xs text-muted-foreground tabular-nums">{d.dealCode}</span>
            <span className="min-w-0 flex-1 truncate font-medium">{d.title}</span>
            <DealStatusBadge value={d.status} />
            <span className="tabular-nums">{money(d.amountCents, d.currency)}</span>
            <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Aprendizajes de una demo (§4.1): lo que se aprendió, ligado a la demo. */
function DemoLearnings({ leadId, demo, canWrite }: { leadId: string; demo: Demo; canWrite: boolean }) {
  const refresh = useRefresh(leadId);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-1.5 border-t border-foreground/10 pt-2 sm:col-span-3">
      {demo.learnings.length > 0 && (
        <ul className="space-y-1 text-sm">
          {demo.learnings.map((l) => (
            <li key={l.id}>
              <span className="text-muted-foreground">{l.authorName}:</span> {l.text}
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (text.trim().length < 3) return;
            setBusy(true);
            setError(null);
            try {
              await addDemoLearning(leadId, demo.id, text.trim());
              setText("");
              await refresh();
            } catch (err) {
              setError(message(err, "No se pudo guardar el aprendizaje."));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Input aria-label={`Aprendizaje de ${demo.title}`} className="h-7 text-xs" value={text} onChange={(e) => setText(e.target.value)} placeholder="Aprendizaje: objeciones, qué gustó, qué faltó…" />
          <Button size="xs" variant="outline" type="submit" disabled={text.trim().length < 3 || busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Plus />}
            Guardar
          </Button>
        </form>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

function DemosTab({ leadId, demos, canWrite, startAdding = false }: { leadId: string; demos: Demo[]; canWrite: boolean; startAdding?: boolean }) {
  const refresh = useRefresh(leadId);
  const [adding, setAdding] = useState(startAdding);
  const [title, setTitle] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = title.trim().length >= 3 && Boolean(scheduledAt) && (!url.trim() || /^https?:\/\//i.test(url.trim()));

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await createDemo(leadId, { title: title.trim(), scheduledAt: new Date(scheduledAt).toISOString(), url: url.trim() || null });
      setTitle("");
      setScheduledAt("");
      setUrl("");
      setAdding(false);
      await refresh();
    } catch (err) {
      setError(message(err, "No se pudo agendar la demo."));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(demo: Demo, status: DemoStatus) {
    setError(null);
    try {
      await updateDemo(leadId, demo.id, { status });
      await refresh();
    } catch (err) {
      setError(message(err, "No se pudo cambiar la demo."));
    }
  }

  return (
    <div className="space-y-4">
      {canWrite && demos.length > 0 && !adding && (
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus />
          Agregar demo
        </Button>
      )}
      {canWrite && adding && <form onSubmit={add} className="grid items-end gap-3 rounded-xl border border-border bg-muted/30 p-4 sm:grid-cols-2 lg:grid-cols-[2fr_1.3fr_2fr_auto]">
        <div className="space-y-1.5">
          <Label htmlFor="demo-title">Demo</Label>
          <Input id="demo-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Demo del portal de pedidos" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="demo-date">Fecha y hora</Label>
          <DateTimePicker id="demo-date" label="Fecha y hora" value={scheduledAt} onValueChange={setScheduledAt} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="demo-url">Enlace de la demo (opcional)</Label>
          <Input id="demo-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </div>
        <Button type="submit" disabled={!valid || busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}
          Agendar
        </Button>
      </form>}
      <ErrorLine error={error} />
      {!demos.length ? (
        !adding && (
          <EmptyState
            icon={MonitorPlay}
            title="Todavía no hay demos"
            description="Registra la web demo que se le mostró a este lead para llevar el seguimiento."
            action={
              canWrite ? (
                <Button variant="outline" onClick={() => setAdding(true)}>
                  <Plus />
                  Agregar demo
                </Button>
              ) : undefined
            }
          />
        )
      ) : (
        <ul className="space-y-2">
          {demos.map((d) => (
            <li key={d.id} className="grid items-center gap-3 rounded-xl border border-border p-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_10rem]">
              <div className="min-w-0">
                <p className="truncate font-medium">{d.title}</p>
                {d.url && (
                  <a className="text-xs text-primary underline-offset-4 hover:underline" href={d.url} target="_blank" rel="noreferrer">
                    Abrir demo
                  </a>
                )}
              </div>
              <p className="text-sm text-muted-foreground">{dateText(d.scheduledAt)}</p>
              {canWrite ? (
                <Select
                  label={`Estado de ${d.title}`}
                  value={d.status}
                  options={DEMO_STATUSES.map((s) => ({ value: s, label: DEMO_STATUS_LABELS[s] }))}
                  onValueChange={(v) => void setStatus(d, (v ?? "") as DemoStatus)}
                />
              ) : (
                <Badge variant="outline">{DEMO_STATUS_LABELS[d.status]}</Badge>
              )}
              <DemoLearnings leadId={leadId} demo={d} canWrite={canWrite} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProposalsTab({ leadId, proposals, canWrite, startAdding = false }: { leadId: string; proposals: Proposal[]; canWrite: boolean; startAdding?: boolean }) {
  const refresh = useRefresh(leadId);
  const [adding, setAdding] = useState(startAdding);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = title.trim().length >= 3 && /^https?:\/\//i.test(url.trim()) && (amount === "" || Number(amount) >= 0);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await createLeadProposal(leadId, { title: title.trim(), url: url.trim(), ...(amount ? { amountCents: Math.round(Number(amount) * 100) } : {}) });
      setTitle("");
      setUrl("");
      setAmount("");
      setAdding(false);
      await refresh();
    } catch (err) {
      setError(message(err, "No se pudo crear la propuesta."));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(proposal: Proposal, status: ProposalStatus) {
    setError(null);
    try {
      await updateLeadProposal(leadId, proposal.id, { status });
      await refresh();
    } catch (err) {
      setError(message(err, "No se pudo cambiar la propuesta."));
    }
  }

  return (
    <div className="space-y-4">
      {canWrite && proposals.length > 0 && !adding && (
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus />
          Agregar propuesta
        </Button>
      )}
      {canWrite && adding && <form onSubmit={add} className="grid items-end gap-3 rounded-xl border border-border bg-muted/30 p-4 sm:grid-cols-2 lg:grid-cols-[1.5fr_2fr_0.8fr_auto]">
        <div className="space-y-1.5">
          <Label htmlFor="lp-title">Propuesta</Label>
          <Input id="lp-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Propuesta Manpersa" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lp-url">Enlace</Label>
          <Input id="lp-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://demo-prospecto-….sites.whatever.tech/" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lp-amount">Monto (USD)</Label>
          <Input id="lp-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Opcional" />
        </div>
        <Button type="submit" disabled={!valid || busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}
          Agregar
        </Button>
      </form>}
      <ErrorLine error={error} />
      {!proposals.length ? (
        !adding && (
          <EmptyState
            icon={FileText}
            title="Todavía no hay propuestas"
            description="La web de la propuesta que se le envía al prospecto. Al marcarla como enviada, el lead pasa a «Propuesta enviada»."
            action={
              canWrite ? (
                <Button variant="outline" onClick={() => setAdding(true)}>
                  <Plus />
                  Agregar propuesta
                </Button>
              ) : undefined
            }
          />
        )
      ) : (
        <ul className="space-y-2">
          {proposals.map((p) => (
            <li key={p.id} className="grid items-center gap-3 rounded-xl border border-border p-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_10rem]">
              <span className="flex min-w-0 flex-col">
                <Link className="truncate font-medium text-primary underline-offset-4 hover:underline" to={`/comercial/propuestas/${p.id}`}>
                  {p.title}
                </Link>
                <a className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:underline" href={p.url} target="_blank" rel="noreferrer">
                  Abrir la web <ExternalLink className="size-3 shrink-0" />
                </a>
              </span>
              <p className="text-sm tabular-nums">{p.amountCents !== null ? money(p.amountCents, p.currency) : "—"}</p>
              <p className="text-xs text-muted-foreground">{p.area === "operations" ? "Desde Operativa" : p.sentAt ? `Enviada ${dateText(p.sentAt)}` : ""}</p>
              {canWrite ? (
                <Select
                  label={`Estado de ${p.title}`}
                  value={p.status}
                  options={PROPOSAL_STATUSES.map((s) => ({ value: s, label: PROPOSAL_STATUS_LABELS[s] }))}
                  onValueChange={(v) => void setStatus(p, (v ?? "") as ProposalStatus)}
                />
              ) : (
                <Badge variant="outline">{PROPOSAL_STATUS_LABELS[p.status]}</Badge>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Con sangría si es JSON válido; si el servidor lo recortó por tamaño, tal cual. */
function prettyJson(raw: string) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** Todo lo que mandó el source, tal cual: cada source trae datos distintos. */
function SourceDataTab({ lead }: { lead: LeadDetail }) {
  const [showRaw, setShowRaw] = useState(false);
  if (!lead.fields.length && !lead.rawJson) return <Empty>Este lead se creó a mano: no hay datos del source.</Empty>;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Datos recibidos desde {lead.source}. Lo que no encaja en los campos del lead queda aquí.</p>
      <dl className="divide-y divide-foreground/10 rounded-lg border border-foreground/10">
        {lead.fields.map((f) => (
          <div key={f.key} className="grid gap-1 p-2.5 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <dt className="font-mono text-xs break-all text-muted-foreground">{f.key}</dt>
            <dd className="break-words">{f.value}</dd>
          </div>
        ))}
      </dl>
      {lead.rawJson && (
        <div>
          <Button size="xs" variant="ghost" onClick={() => setShowRaw((v) => !v)}>
            {showRaw ? "Ocultar" : "Ver"} el envío original
          </Button>
          {showRaw && <pre className="mt-2 max-h-80 overflow-auto rounded-lg border border-foreground/10 bg-foreground/[0.03] p-3 text-xs">{prettyJson(lead.rawJson)}</pre>}
        </div>
      )}
    </div>
  );
}

/**
 * Detalle del lead: todo se edita en el lugar con guardado automático y «Deshacer», con atajos a
 * lo siguiente que suele pasar (nota, actividad, demo, propuesta, deal). Financiera solo lee.
 */
export default function LeadDetailPage() {
  const { id = "" } = useParams();
  const { hash } = useLocation();
  const { data, isLoading, error } = useLead(id);
  const refresh = useRefresh(id);
  const [tab, setTab] = useState<TabId>("demos");
  // Al abrir un atajo («Demo», «Propuesta») la pestaña empieza con el formulario a la vista.
  const [adding, setAdding] = useState<{ tab: TabId; n: number } | null>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const canWrite = data?.canWrite ?? false;
  const owners = useOwners(canWrite).data ?? [];
  const contacts = useContactOptions(canWrite).data ?? [];
  const save = useSaveLead(data?.lead ?? ({} as LeadDetail));
  const { create: createDealNow, busy: creatingDeal } = useCreateDeal(data?.lead ?? null);
  useCrumbs([data && { label: data.lead.title }]);

  const open = (next: TabId, add = false) => {
    setTab(next);
    if (add) setAdding((a) => ({ tab: next, n: (a?.n ?? 0) + 1 }));
    tabsRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };
  const persist = (patch: Partial<LeadInput>, what?: string) =>
    save(patch, what).catch((err: unknown) => toast.error("No se pudo guardar el cambio.", { description: errorText(err, "Inténtalo de nuevo.") }));
  const focusDate = (which: "submission" | "reunion") => {
    const el = document.getElementById(`lead-${which}`);
    el?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    el?.focus();
  };

  // Desde la vista rápida («Ir al campo»): la fecha que falta queda enfocada.
  const ready = Boolean(data);
  useEffect(() => {
    if (ready && (hash === "#reunion" || hash === "#submission")) focusDate(hash.slice(1) as "submission" | "reunion");
  }, [ready, hash]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <Skeleton className="h-80 w-full rounded-2xl" />
          <Skeleton className="h-48 w-full rounded-2xl" />
        </div>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="space-y-4">
        <Link to="/comercial" className="text-sm text-muted-foreground hover:text-foreground">
          ← Leads
        </Link>
        <p role="alert" className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Lead no encontrado."}
        </p>
      </div>
    );
  }

  const { lead, demos, proposals, project, deals } = data;
  const people = owners.map((o) => ({ value: o.id, label: o.name }));
  const hasSourceData = lead.fields.length > 0 || Boolean(lead.rawJson);
  const tabs: { id: TabId; label: string; count?: number }[] = [
    { id: "demos", label: "Demos", count: demos.length },
    { id: "proposals", label: "Propuestas", count: proposals.length },
    { id: "activities", label: "Actividades", count: data.pendingActivities },
    { id: "meetings", label: "Reuniones" },
    { id: "updates", label: "Updates" },
    { id: "deals", label: "Deals", count: deals.length },
    ...(hasSourceData ? [{ id: "data" as const, label: "Datos del source" }] : []),
  ];
  const startAdding = (t: TabId) => adding?.tab === t;

  return (
    <div className="space-y-6">
      <PageHeader
        stackOnMobile
        title={lead.title}
        badges={
          <>
            <LeadStatusBadge value={lead.status} />
            <StatusBadge tone="neutral">{lead.source}</StatusBadge>
          </>
        }
        description={[lead.contactName, `creado ${formatDateTime(lead.createdAt)}`].filter(Boolean).join(" · ")}
        actions={
          canWrite && (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger aria-label="Más acciones" className="inline-flex size-10 items-center justify-center rounded-xl border border-border bg-card transition-colors hover:bg-accent data-[popup-open]:bg-accent dark:bg-white/[0.03]">
                  <MoreHorizontal className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={6} className="w-52">
                  <DropdownMenuItem onClick={() => open("updates")}>
                    <MessageSquarePlus />
                    Nota
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => open("activities")}>
                    <ListPlus />
                    Actividad
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => open("demos", true)}>
                    <CalendarPlus />
                    Demo
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => open("proposals", true)}>
                    <FilePlus2 />
                    Propuesta
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button size="lg" loading={creatingDeal} onClick={() => void createDealNow()}>
                {!creatingDeal && <Handshake />}
                Crear deal
              </Button>
            </>
          )
        }
      />

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-5">
          <Panel title="Datos comerciales">
            <div className="grid gap-x-4 gap-y-4 sm:grid-cols-2">
              <Field label="Estado">
                <Select
                  label="Estado del lead"
                  value={lead.status}
                  options={LEAD_STATUSES.map((st) => ({ value: st, label: LEAD_STATUS_LABELS[st] }))}
                  disabled={!canWrite}
                  onValueChange={(v) => v && v !== lead.status && void persist({ status: v as LeadStatus }, `Estado: ${LEAD_STATUS_LABELS[v as LeadStatus]}`)}
                />
              </Field>
              <Field label="Temperatura">
                <Select
                  label="Temperatura"
                  value={lead.temperature}
                  emptyLabel="Sin definir"
                  options={LEAD_TEMPERATURES.map((t) => ({ value: t, label: LEAD_TEMPERATURE_LABELS[t] }))}
                  disabled={!canWrite}
                  onValueChange={(v) => void persist({ temperature: v as LeadTemperature | null }, v ? `Temperatura cambiada a ${LEAD_TEMPERATURE_LABELS[v as LeadTemperature]}` : "Temperatura borrada")}
                />
              </Field>
              <Field label="Funnel">
                <Select
                  label="Funnel"
                  value={lead.funnel}
                  emptyLabel="Sin definir"
                  options={LEAD_FUNNELS.map((f) => ({ value: f, label: LEAD_FUNNEL_LABELS[f] }))}
                  disabled={!canWrite}
                  onValueChange={(v) => void persist({ funnel: v as LeadFunnel | null }, "Funnel actualizado")}
                />
              </Field>
              <Field label="Source" htmlFor="lead-source">
                <EditableText id="lead-source" label="Origen" className={boxed} value={lead.source} minLength={2} disabled={!canWrite} onSave={(v) => persist({ source: v ?? "Manual" }, "Origen guardado")} />
              </Field>
              <Field label="Setter">
                <Select label="Setter" value={lead.setter?.id ?? null} emptyLabel="Sin asignar" options={people} disabled={!canWrite} placeholder={lead.setter?.name ?? "Sin asignar"} onValueChange={(v) => void persist({ setterUserId: v }, "Setter actualizado")} />
              </Field>
              <Field label="Closer">
                <Select label="Closer" value={lead.closer?.id ?? null} emptyLabel="Sin asignar" options={people} disabled={!canWrite} placeholder={lead.closer?.name ?? "Sin asignar"} onValueChange={(v) => void persist({ closerUserId: v }, "Closer actualizado")} />
              </Field>
              <Field label="Submission" htmlFor="lead-submission">
                <DatePicker id="lead-submission" label="Fecha de submission" disabled={!canWrite} value={lead.submittedAt} onValueChange={(v) => void persist({ submittedAt: v }, v ? `Submission: ${formatDate(v)}` : "Submission borrada")} />
              </Field>
              <Field label="Reunión" htmlFor="lead-reunion">
                <DatePicker id="lead-reunion" label="Fecha de reunión" placeholder="Elegir fecha" disabled={!canWrite} value={lead.meetingAt} onValueChange={(v) => void persist({ meetingAt: v }, v ? `Reunión: ${formatDate(v)}` : "Reunión borrada")} />
              </Field>
              <Field label="Propuesta (web)" htmlFor="lead-proposal-url">
                <EditableText id="lead-proposal-url" label="Enlace de la propuesta" className={boxed} type="url" value={lead.proposalUrl} placeholder="https://…" disabled={!canWrite} onSave={(v) => persist({ proposalUrl: v }, "Enlace guardado")} />
              </Field>
              {project ? (
                <Field label="Proyecto">
                  <Link to={`/operativa/${project.id}`} className="flex h-control items-center text-sm font-medium text-primary hover:underline">
                    {project.name} ({STAGE_LABELS[project.stage]})
                  </Link>
                </Field>
              ) : (
                <div className="max-sm:hidden" />
              )}
              {lead.status === "lost" && (
                <Field label="Motivo de pérdida" htmlFor="lead-lost" className="sm:col-span-2">
                  <EditableText id="lead-lost" label="Motivo de la pérdida" className={boxed} value={lead.lostReason} placeholder="Sin presupuesto, eligió otra opción…" disabled={!canWrite} onSave={(v) => persist({ lostReason: v }, "Motivo guardado")} />
                </Field>
              )}
            </div>
          </Panel>

          <Panel title="Contacto">
            <div className="grid gap-x-4 gap-y-4 sm:grid-cols-2">
              <Field label="Correo">
                <ContactLink kind="email" value={lead.email} canWrite={canWrite} onEdit={(v) => persist({ email: v }, "Correo guardado")} />
              </Field>
              <Field label="Teléfono">
                <ContactLink kind="phone" value={lead.phone} canWrite={canWrite} onEdit={(v) => persist({ phone: v }, "Teléfono guardado")} />
              </Field>
              <Field label="Empresa" htmlFor="lead-company">
                <EditableText id="lead-company" label="Empresa" className="-ml-2 font-semibold" value={lead.company || null} placeholder="Agregar empresa" disabled={!canWrite} onSave={(v) => persist({ company: v ?? "" }, "Empresa guardada")} />
              </Field>
              <Field label="Contacto" htmlFor="lead-contact">
                <div className="flex min-w-0 items-center gap-2">
                  <EditableText id="lead-contact" label="Persona de contacto" className="-ml-2 font-semibold" value={lead.contactName || null} placeholder="Agregar nombre" disabled={!canWrite} onSave={(v) => persist({ contactName: v ?? "" }, "Contacto guardado")} />
                  {lead.contactRef ? (
                    <Link to={`/comercial/contactos/${lead.contactRef.id}`} className="shrink-0 text-sm font-semibold text-primary underline underline-offset-4 hover:opacity-80">
                      Ver ficha
                    </Link>
                  ) : null}
                </div>
              </Field>
              {canWrite && (
                <Field label="Contacto enlazado" className="sm:col-span-2">
                  <Select
                    label="Contacto enlazado"
                    value={lead.contactRef?.id ?? null}
                    emptyLabel="Sin enlazar"
                    searchable
                    options={contacts.map((c) => ({ value: c.id, label: c.name, description: c.company ?? undefined }))}
                    onValueChange={(v) => void persist({ contactId: v }, v ? "Contacto enlazado" : "Contacto desenlazado")}
                  />
                </Field>
              )}
            </div>
          </Panel>

          <Card ref={tabsRef} className="scroll-mt-20 gap-0 pt-2 pb-0">
            <div role="tablist" aria-label="Secciones del lead" className="flex gap-1 overflow-x-auto border-b border-border px-3">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  type="button"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    "-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-3 text-sm font-semibold whitespace-nowrap transition-colors",
                    tab === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t.label}
                  {t.count !== undefined && <span className="text-xs font-medium text-muted-foreground tabular-nums">{t.count}</span>}
                </button>
              ))}
            </div>
            <div role="tabpanel" className="min-h-64 p-5">
              {tab === "updates" && <UpdatesPanel base={leadBase(lead.id)} canWork={canWrite} onPosted={refresh} />}
              {tab === "activities" && <ActivitiesTable leadId={lead.id} prefix="a." />}
              {tab === "demos" && <DemosTab key={`demos-${adding?.n ?? 0}`} leadId={lead.id} demos={demos} canWrite={canWrite} startAdding={startAdding("demos")} />}
              {tab === "proposals" && <ProposalsTab key={`proposals-${adding?.n ?? 0}`} leadId={lead.id} proposals={proposals} canWrite={canWrite} startAdding={startAdding("proposals")} />}
              {tab === "deals" && <DealsTab data={data} canWrite={canWrite} />}
              {tab === "meetings" && <MeetingsPanel base={leadBase(lead.id)} canWork={canWrite} deals={deals.map((d) => ({ id: d.id, dealCode: d.dealCode, title: d.title }))} />}
              {tab === "data" && <SourceDataTab lead={lead} />}
            </div>
          </Card>
        </div>

        <aside className="space-y-5" aria-label="Siguiente paso">
          <DealCard data={data} canWrite={canWrite} onOpenProposals={() => open("proposals", canWrite)} />
          <ResponseCard lead={lead} onFixDates={() => focusDate(lead.submittedAt ? "reunion" : "submission")} />
          <Panel title="Notas">
            <EditableText label="Notas del lead" multiline className="-mx-2 w-[calc(100%+1rem)]" value={lead.notes || null} placeholder="Qué necesita, contexto, próximos pasos…" disabled={!canWrite} onSave={(v) => persist({ notes: v ?? "" }, "Notas guardadas")} />
          </Panel>
        </aside>
      </div>
    </div>
  );
}
