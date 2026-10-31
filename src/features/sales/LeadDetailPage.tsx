import { useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, ChevronRight, CircleAlert, ExternalLink, FilePlus2, Handshake, ListPlus, Loader2, Mail, MessageSquarePlus, Phone, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DatePicker, DateTimePicker } from "@/components/ui/date-picker";
import { CopyButton, EditableText, FieldRow } from "@/components/ui/editable";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Empty, ErrorLine, MeetingsPanel, UpdatesPanel } from "@/features/activity/ActivityPanels";
import { activityKeys, dateText } from "@/features/activity/api";
import { ActivitiesTable } from "@/features/commercial/ActivitiesTable";
import { createDeal, useContactOptions } from "@/features/core/api";
import { DealStatusBadge } from "@/features/core/DealsTable";
import { money, PROPOSAL_STATUS_LABELS, PROPOSAL_STATUSES, STAGE_LABELS, type Proposal, type ProposalStatus } from "@/features/ops/api";
import { formatDate } from "@/lib/format";
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
  LEAD_STATUS_TONE,
  LEAD_STATUSES,
  LEAD_TEMPERATURE_LABELS,
  LEAD_TEMPERATURE_TONE,
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

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <Card size="sm">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-section-title">{title}</CardTitle>
        {action}
      </CardHeader>
      <CardContent className="space-y-1.5">{children}</CardContent>
    </Card>
  );
}

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
    <div className="flex min-w-0 items-center gap-1 px-2">
      <a href={href} className="inline-flex min-w-0 items-center gap-1.5 text-sm text-foreground underline-offset-4 transition-colors hover:text-primary hover:underline">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">{value}</span>
      </a>
      <CopyButton value={value} label={label} />
      {canWrite && (
        <button type="button" className="ml-auto rounded px-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => setEditing(true)}>
          Editar
        </button>
      )}
    </div>
  );
}

/** Indicadores del lead: respuesta, demos, propuestas, actividades y deals. */
function Kpis({ data, onOpen, onFixDates }: { data: NonNullable<ReturnType<typeof useLead>["data"]>; onOpen: (tab: TabId) => void; onFixDates: () => void }) {
  const { lead, demos, proposals, deals, pendingActivities } = data;
  const items: { label: string; value: ReactNode; tab?: TabId; hint?: ReactNode }[] = [
    {
      label: "Respuesta",
      value: lead.responseDays === null ? "—" : `${lead.responseDays} d`,
      hint:
        lead.responseDays === null ? (
          <button type="button" onClick={onFixDates} className="inline-flex items-center gap-1 text-left text-xs text-muted-foreground hover:text-primary">
            <CircleAlert className="size-3 shrink-0" aria-hidden />
            Agrega {lead.submittedAt ? "la fecha de reunión" : "la fecha de submission"} para calcularla
          </button>
        ) : (
          <span className="text-xs text-muted-foreground">Desde la submission hasta la reunión</span>
        ),
    },
    { label: "Actividades pendientes", value: pendingActivities, tab: "activities" },
    { label: "Demos", value: demos.length, tab: "demos" },
    { label: "Propuestas", value: proposals.length, tab: "proposals" },
    { label: "Deals", value: deals.length, tab: "deals" },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {items.map((k) =>
        k.tab ? (
          <button
            key={k.label}
            type="button"
            onClick={() => onOpen(k.tab!)}
            className="flex min-h-20 flex-col justify-between rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-accent/40"
          >
            <span className="text-field-label">{k.label}</span>
            <span className="text-xl font-semibold tabular-nums">{k.value}</span>
          </button>
        ) : (
          <div key={k.label} className="col-span-2 flex min-h-20 flex-col justify-between rounded-xl border border-border bg-card p-3 sm:col-span-1">
            <span className="text-field-label">{k.label}</span>
            <span className="text-xl font-semibold tabular-nums">{k.value}</span>
            {k.hint}
          </div>
        ),
      )}
    </div>
  );
}

/** Deals del lead, con acceso directo a crear uno nuevo. */
function DealsTab({ data, canWrite }: { data: NonNullable<ReturnType<typeof useLead>["data"]>; canWrite: boolean }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const { lead, deals } = data;
  async function create() {
    setBusy(true);
    try {
      const { deal } = await createDeal({ title: lead.title.length >= 3 ? lead.title : `Deal ${lead.title}`, leadId: lead.id, contactIds: lead.contactId ? [lead.contactId] : [] });
      toast.success(`Deal ${deal.dealCode} creado`);
      navigate(`/deals/${deal.id}`);
    } catch (err) {
      toast.error("No se pudo crear el deal.", { description: errorText(err, "Inténtalo de nuevo.") });
    } finally {
      setBusy(false);
    }
  }
  if (!deals.length) {
    return (
      <EmptyState
        icon={Handshake}
        title="Este lead aún no tiene deals"
        description="Crea el deal cuando haya algo concreto que vender: horas, tarifa y probabilidad se completan después."
        action={
          canWrite ? (
            <Button onClick={() => void create()} loading={busy}>
              {!busy && <Plus />}
              Crear deal
            </Button>
          ) : undefined
        }
      />
    );
  }
  return (
    <div className="space-y-3">
      {canWrite && (
        <Button size="sm" variant="outline" onClick={() => void create()} loading={busy}>
          {!busy && <Plus />}
          Crear deal
        </Button>
      )}
      <ul className="divide-y divide-border rounded-xl border border-border">
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
    </div>
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

function DemosTab({ leadId, demos, canWrite }: { leadId: string; demos: Demo[]; canWrite: boolean }) {
  const refresh = useRefresh(leadId);
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
      {canWrite && <form onSubmit={add} className="grid items-end gap-3 rounded-lg border border-foreground/10 p-4 sm:grid-cols-2 lg:grid-cols-[2fr_1.3fr_2fr_auto]">
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
        <Empty>Aún no hay demos.</Empty>
      ) : (
        <ul className="space-y-2">
          {demos.map((d) => (
            <li key={d.id} className="grid items-center gap-3 rounded-lg border border-foreground/10 p-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_10rem]">
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

function ProposalsTab({ leadId, proposals, canWrite }: { leadId: string; proposals: Proposal[]; canWrite: boolean }) {
  const refresh = useRefresh(leadId);
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
      <p className="text-sm text-muted-foreground">
        La web de la propuesta que se le envía al prospecto. Al marcarla como enviada, el lead pasa a «Propuesta enviada». En su detalle se cargan las líneas (producto, horas y tarifa).
      </p>
      {canWrite && <form onSubmit={add} className="grid items-end gap-3 rounded-lg border border-foreground/10 p-4 sm:grid-cols-2 lg:grid-cols-[1.5fr_2fr_0.8fr_auto]">
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
        <Empty>Aún no hay propuestas.</Empty>
      ) : (
        <ul className="space-y-2">
          {proposals.map((p) => (
            <li key={p.id} className="grid items-center gap-3 rounded-lg border border-foreground/10 p-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_10rem]">
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
  const { data, isLoading, error } = useLead(id);
  const refresh = useRefresh(id);
  const [tab, setTab] = useState<TabId>("updates");
  const tabsRef = useRef<HTMLDivElement>(null);
  const datesRef = useRef<HTMLDivElement>(null);
  const canWrite = data?.canWrite ?? false;
  const owners = useOwners(canWrite).data ?? [];
  const contacts = useContactOptions(canWrite).data ?? [];
  const save = useSaveLead(data?.lead ?? ({} as LeadDetail));

  const open = (next: TabId) => {
    setTab(next);
    tabsRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };
  const persist = (patch: Partial<LeadInput>, what?: string) =>
    save(patch, what).catch((err: unknown) => toast.error("No se pudo guardar el cambio.", { description: errorText(err, "Inténtalo de nuevo.") }));

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="space-y-4">
        <nav aria-label="Migas de pan" className="text-sm text-muted-foreground">
          <Link to="/comercial" className="hover:text-foreground">
            Leads
          </Link>
        </nav>
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
    { id: "updates", label: "Actividad" },
    { id: "activities", label: "Pendientes", count: data.pendingActivities },
    { id: "demos", label: "Demos", count: demos.length },
    { id: "proposals", label: "Propuestas", count: proposals.length },
    { id: "deals", label: "Deals", count: deals.length },
    { id: "meetings", label: "Reuniones" },
    ...(hasSourceData ? [{ id: "data" as const, label: "Datos de origen" }] : []),
  ];

  return (
    <div className="space-y-6">
      <nav aria-label="Migas de pan" className="flex items-center gap-1 text-sm text-muted-foreground">
        <Link to="/comercial" className="hover:text-foreground">
          Leads
        </Link>
        <ChevronRight className="size-3.5" aria-hidden />
        <span className="truncate text-foreground">{lead.title}</span>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <h1 className="text-page-title break-words">{lead.title}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              label="Estado del lead"
              value={lead.status}
              options={LEAD_STATUSES.map((st) => ({ value: st, label: LEAD_STATUS_LABELS[st] }))}
              disabled={!canWrite}
              size="sm"
              className="w-auto border-transparent bg-transparent px-1 hover:border-input dark:bg-transparent"
              renderValue={() => <StatusBadge tone={LEAD_STATUS_TONE[lead.status]}>{LEAD_STATUS_LABELS[lead.status]}</StatusBadge>}
              onValueChange={(v) => v && v !== lead.status && void persist({ status: v as LeadStatus }, `Estado: ${LEAD_STATUS_LABELS[v as LeadStatus]}`)}
            />
            <Select
              label="Temperatura"
              value={lead.temperature}
              emptyLabel="Sin temperatura"
              options={LEAD_TEMPERATURES.map((t) => ({ value: t, label: LEAD_TEMPERATURE_LABELS[t] }))}
              disabled={!canWrite}
              size="sm"
              className="w-auto border-transparent bg-transparent px-1 hover:border-input dark:bg-transparent"
              renderValue={() =>
                lead.temperature ? (
                  <StatusBadge tone={LEAD_TEMPERATURE_TONE[lead.temperature]} dot>
                    {LEAD_TEMPERATURE_LABELS[lead.temperature]}
                  </StatusBadge>
                ) : (
                  <span className="text-xs text-muted-foreground">Sin temperatura</span>
                )
              }
              onValueChange={(v) => void persist({ temperature: v as LeadTemperature | null }, "Temperatura actualizada")}
            />
            <StatusBadge tone="outline">{lead.source}</StatusBadge>
            <span className="text-xs text-muted-foreground">Creado {dateText(lead.createdAt)}</span>
          </div>
        </div>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => open("updates")}>
              <MessageSquarePlus />
              Nota
            </Button>
            <Button variant="outline" size="sm" onClick={() => open("activities")}>
              <ListPlus />
              Actividad
            </Button>
            <Button variant="outline" size="sm" onClick={() => open("demos")}>
              <CalendarPlus />
              Demo
            </Button>
            <Button variant="outline" size="sm" onClick={() => open("proposals")}>
              <FilePlus2 />
              Propuesta
            </Button>
            <Button size="sm" onClick={() => open("deals")}>
              <Handshake />
              Deal
            </Button>
          </div>
        )}
      </header>

      <Kpis data={data} onOpen={open} onFixDates={() => datesRef.current?.querySelector<HTMLButtonElement>("button")?.focus()} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Contacto">
          <FieldRow label="Empresa">
            <EditableText label="Empresa" value={lead.company || null} placeholder="Agregar empresa" disabled={!canWrite} onSave={(v) => persist({ company: v ?? "" }, "Empresa guardada")} />
          </FieldRow>
          <FieldRow label="Persona">
            <EditableText label="Persona de contacto" value={lead.contactName || null} placeholder="Agregar nombre" disabled={!canWrite} onSave={(v) => persist({ contactName: v ?? "" }, "Contacto guardado")} />
          </FieldRow>
          <FieldRow label="Correo">
            <ContactLink kind="email" value={lead.email} canWrite={canWrite} onEdit={(v) => persist({ email: v }, "Correo guardado")} />
          </FieldRow>
          <FieldRow label="Teléfono">
            <ContactLink kind="phone" value={lead.phone} canWrite={canWrite} onEdit={(v) => persist({ phone: v }, "Teléfono guardado")} />
          </FieldRow>
          <FieldRow label="Contacto enlazado" hint={lead.contactRef ? <Link to={`/comercial/contactos/${lead.contactRef.id}`} className="text-xs text-primary hover:underline">Ver contacto</Link> : undefined}>
            {canWrite ? (
              <Select
                label="Contacto enlazado"
                value={lead.contactRef?.id ?? null}
                emptyLabel="Sin enlazar"
                searchable
                options={contacts.map((c) => ({ value: c.id, label: c.name, description: c.company ?? undefined }))}
                onValueChange={(v) => void persist({ contactId: v }, v ? "Contacto enlazado" : "Contacto desenlazado")}
              />
            ) : (
              <span className="px-2 text-sm">{lead.contactRef?.name ?? "—"}</span>
            )}
          </FieldRow>
        </Section>

        <Section title="Comercial">
          <FieldRow label="Setter">
            <Select label="Setter" value={lead.setter?.id ?? null} emptyLabel="Sin asignar" options={people} disabled={!canWrite} placeholder={lead.setter?.name ?? "Sin asignar"} onValueChange={(v) => void persist({ setterUserId: v }, "Setter actualizado")} />
          </FieldRow>
          <FieldRow label="Closer">
            <Select label="Closer" value={lead.closer?.id ?? null} emptyLabel="Sin asignar" options={people} disabled={!canWrite} placeholder={lead.closer?.name ?? "Sin asignar"} onValueChange={(v) => void persist({ closerUserId: v }, "Closer actualizado")} />
          </FieldRow>
          <FieldRow label="Funnel">
            <Select
              label="Funnel"
              value={lead.funnel}
              emptyLabel="Sin definir"
              options={LEAD_FUNNELS.map((f) => ({ value: f, label: LEAD_FUNNEL_LABELS[f] }))}
              disabled={!canWrite}
              onValueChange={(v) => void persist({ funnel: v as LeadFunnel | null }, "Funnel actualizado")}
            />
          </FieldRow>
          <FieldRow label="Origen">
            <EditableText label="Origen" value={lead.source} minLength={2} disabled={!canWrite} onSave={(v) => persist({ source: v ?? "Manual" }, "Origen guardado")} />
          </FieldRow>
          <FieldRow label="Propuesta (web)">
            <EditableText label="Enlace de la propuesta" type="url" value={lead.proposalUrl} placeholder="https://…" disabled={!canWrite} onSave={(v) => persist({ proposalUrl: v }, "Enlace guardado")} />
          </FieldRow>
          {lead.status === "lost" && (
            <FieldRow label="Motivo de pérdida">
              <EditableText label="Motivo de la pérdida" value={lead.lostReason} placeholder="Sin presupuesto, eligió otra opción…" disabled={!canWrite} onSave={(v) => persist({ lostReason: v }, "Motivo guardado")} />
            </FieldRow>
          )}
          {project && (
            <FieldRow label="Proyecto">
              <Link to={`/operativa/${project.id}`} className="px-2 text-sm text-primary hover:underline">
                {project.name} ({STAGE_LABELS[project.stage]})
              </Link>
            </FieldRow>
          )}
        </Section>

        <Section title="Fechas">
          <div ref={datesRef} className="space-y-1.5">
            <FieldRow label="Submission">
              <DatePicker label="Fecha de submission" disabled={!canWrite} value={lead.submittedAt} onValueChange={(v) => void persist({ submittedAt: v }, v ? `Submission: ${formatDate(v)}` : "Submission borrada")} />
            </FieldRow>
            <FieldRow label="Reunión">
              <DatePicker label="Fecha de reunión" disabled={!canWrite} value={lead.meetingAt} onValueChange={(v) => void persist({ meetingAt: v }, v ? `Reunión: ${formatDate(v)}` : "Reunión borrada")} />
            </FieldRow>
          </div>
        </Section>

        <Section title="Notas">
          <EditableText label="Notas del lead" multiline value={lead.notes || null} placeholder="Qué necesita, contexto, próximos pasos…" disabled={!canWrite} onSave={(v) => persist({ notes: v ?? "" }, "Notas guardadas")} />
        </Section>
      </div>

      <div ref={tabsRef} role="tablist" aria-label="Secciones del lead" className="-mx-4 flex scroll-mt-4 gap-1 overflow-x-auto border-b border-foreground/10 px-4 sm:mx-0 sm:px-0">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors",
              tab === t.id ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
            {t.count !== undefined && <span className="rounded-full bg-foreground/10 px-1.5 text-[11px] tabular-nums">{t.count}</span>}
          </button>
        ))}
      </div>

      <div role="tabpanel" className="min-h-64">
        {tab === "updates" && <UpdatesPanel base={leadBase(lead.id)} canWork={canWrite} onPosted={refresh} />}
        {tab === "activities" && <ActivitiesTable leadId={lead.id} prefix="a." />}
        {tab === "demos" && <DemosTab leadId={lead.id} demos={demos} canWrite={canWrite} />}
        {tab === "proposals" && <ProposalsTab leadId={lead.id} proposals={proposals} canWrite={canWrite} />}
        {tab === "deals" && <DealsTab data={data} canWrite={canWrite} />}
        {tab === "meetings" && <MeetingsPanel base={leadBase(lead.id)} canWork={canWrite} deals={deals.map((d) => ({ id: d.id, dealCode: d.dealCode, title: d.title }))} />}
        {tab === "data" && <SourceDataTab lead={lead} />}
      </div>
    </div>
  );
}
