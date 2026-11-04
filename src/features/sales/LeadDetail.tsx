import { useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { CommsTab } from "@/features/communications/CommsList";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, ExternalLink, FileText, Handshake, Loader2, Mail, MonitorPlay, Pencil, Phone, Plus, X } from "lucide-react";
import { useCrumbs } from "@/components/layout/crumbs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DatePicker, DateTimePicker } from "@/components/ui/date-picker";
import { CopyButton, EditableText } from "@/components/ui/editable";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, ErrorLine, MeetingsPanel } from "@/features/activity/ActivityPanels";
import { activityKeys, createUpdate, dateText, updatesQuery } from "@/features/activity/api";
import { ActivitiesTable } from "@/features/commercial/ActivitiesTable";
import { useContactOptions } from "@/features/core/api";
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
import { ResponseNotice } from "./ResponseNotice";
import { LeadStatusBadge } from "./SalesBadges";
import { useCreateDeal } from "./use-create-deal";
import { slugify, useSites, useSitesConfig } from "@/features/sites/api";
import { UploadSiteDialog } from "@/features/sites/SiteDialogs";
import { SitesList } from "@/features/sites/SitesList";

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

/** Updates del lead (columna derecha del prototipo): notas internas, la más reciente arriba. */
function UpdatesColumn({ base, canWrite, onPosted }: { base: string; canWrite: boolean; onPosted: () => Promise<unknown> }) {
  const queryClient = useQueryClient();
  const { data: updates, isLoading } = useQuery(updatesQuery(base));
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const publish = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await createUpdate(base, body.trim());
      setBody("");
      await queryClient.invalidateQueries({ queryKey: activityKeys.updates(base) });
      await onPosted();
    } catch (err) {
      toast.error("No se pudo publicar el update.", { description: errorText(err, "Inténtalo de nuevo.") });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Updates" className="flex flex-col rounded-[14px] border border-border bg-card lg:min-h-0">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-lg font-bold">Updates</h2>
        <p className="text-xs text-muted-foreground">Notas internas sobre este lead</p>
      </div>
      {canWrite && (
        <div className="border-b border-border p-4">
          <Textarea aria-label="Nuevo update" rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Escribe un update…" className="rounded-[10px] bg-muted dark:bg-muted" />
        </div>
      )}
      <div className="flex-1 p-4 lg:min-h-0 lg:overflow-y-auto">
        {isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : !updates?.length ? (
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
            <b>Aún no hay updates</b>
            <p className="text-sm text-muted-foreground">Publica el primero: llamadas, acuerdos o próximos pasos.</p>
          </div>
        ) : (
          <ol className="space-y-3">
            {updates.map((u) => (
              <li key={u.id} className={cn("rounded-xl border p-3", u.kind === "system" ? "border-dashed border-border bg-muted/50" : "border-border")}>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">{u.kind === "system" ? "Sistema" : u.authorName}</span>
                  <span className="ml-auto">{dateText(u.createdAt)}</span>
                </div>
                <p className="mt-1 text-sm whitespace-pre-wrap">{u.body}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
      {canWrite && (
        <div className="flex justify-end border-t border-border p-4">
          <Button size="lg" disabled={!body.trim()} loading={busy} onClick={() => void publish()}>
            Publicar
          </Button>
        </div>
      )}
    </section>
  );
}

/** Sección de la pestaña Información: título y cuadrícula de 3 columnas (prototipo). */
function InfoSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-bold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}
const grid3 = "grid gap-x-4 gap-y-4 sm:grid-cols-2 lg:grid-cols-3";

/** Encabezado de una pestaña con su acción principal («+ Nueva actividad»…). */
function TabHead({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-lg font-bold">{title}</h3>
      {action}
    </div>
  );
}

function InfoTab({ data, canWrite, persist }: { data: LeadData; canWrite: boolean; persist: (patch: Partial<LeadInput>, what?: string) => Promise<unknown> }) {
  const { lead, project } = data;
  const owners = useOwners(canWrite).data ?? [];
  const contacts = useContactOptions(canWrite).data ?? [];
  const people = owners.map((o) => ({ value: o.id, label: o.name }));
  const focusDate = (which: "submission" | "reunion") => document.getElementById(`lead-${which}`)?.focus();
  const hasSourceData = lead.fields.length > 0 || Boolean(lead.rawJson);
  return (
    <div className="space-y-8">
      <InfoSection title="Datos comerciales">
        <div className={grid3}>
          <Field label="Estado">
            <Select label="Estado del lead" value={lead.status} options={LEAD_STATUSES.map((st) => ({ value: st, label: LEAD_STATUS_LABELS[st] }))} disabled={!canWrite} onValueChange={(v) => v && v !== lead.status && void persist({ status: v as LeadStatus }, `Estado: ${LEAD_STATUS_LABELS[v as LeadStatus]}`)} />
          </Field>
          <Field label="Temperatura">
            <Select label="Temperatura" value={lead.temperature} emptyLabel="Sin definir" options={LEAD_TEMPERATURES.map((t) => ({ value: t, label: LEAD_TEMPERATURE_LABELS[t] }))} disabled={!canWrite} onValueChange={(v) => void persist({ temperature: v as LeadTemperature | null }, v ? `Temperatura cambiada a ${LEAD_TEMPERATURE_LABELS[v as LeadTemperature]}` : "Temperatura borrada")} />
          </Field>
          <Field label="Funnel">
            <Select label="Funnel" value={lead.funnel} emptyLabel="Sin definir" options={LEAD_FUNNELS.map((f) => ({ value: f, label: LEAD_FUNNEL_LABELS[f] }))} disabled={!canWrite} onValueChange={(v) => void persist({ funnel: v as LeadFunnel | null }, "Funnel actualizado")} />
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
          <Field label="Source" htmlFor="lead-source">
            <EditableText id="lead-source" label="Origen" className={boxed} value={lead.source} minLength={2} disabled={!canWrite} onSave={(v) => persist({ source: v ?? "Manual" }, "Origen guardado")} />
          </Field>
          <Field label="Respuesta">
            <p className="flex h-control items-center text-sm font-semibold tabular-nums">{lead.responseDays === null ? "—" : `${lead.responseDays} d`}</p>
          </Field>
          {project && (
            <Field label="Proyecto">
              <Link to={`/operativa/${project.id}`} className="flex h-control items-center text-sm font-semibold text-accent-text hover:underline">
                {project.name} ({STAGE_LABELS[project.stage]})
              </Link>
            </Field>
          )}
          {lead.status === "lost" && (
            <Field label="Motivo de pérdida" htmlFor="lead-lost" className="sm:col-span-2">
              <EditableText id="lead-lost" label="Motivo de la pérdida" className={boxed} value={lead.lostReason} placeholder="Sin presupuesto, eligió otra opción…" disabled={!canWrite} onSave={(v) => persist({ lostReason: v }, "Motivo guardado")} />
            </Field>
          )}
        </div>
        {lead.responseDays === null && <ResponseNotice lead={lead} onFix={() => focusDate(lead.submittedAt ? "reunion" : "submission")} />}
      </InfoSection>

      <InfoSection title="Contacto">
        <div className={grid3}>
          <Field label="Correo">
            <ContactLink kind="email" value={lead.email} canWrite={canWrite} onEdit={(v) => persist({ email: v }, "Correo guardado")} />
          </Field>
          <Field label="Teléfono">
            <ContactLink kind="phone" value={lead.phone} canWrite={canWrite} onEdit={(v) => persist({ phone: v }, "Teléfono guardado")} />
          </Field>
          <Field label="Empresa" htmlFor="lead-company">
            <EditableText id="lead-company" label="Empresa" className={boxed} value={lead.company || null} placeholder="Agregar empresa" disabled={!canWrite} onSave={(v) => persist({ company: v ?? "" }, "Empresa guardada")} />
          </Field>
          <Field label="Contacto" htmlFor="lead-contact">
            <EditableText id="lead-contact" label="Persona de contacto" className={boxed} value={lead.contactName || null} placeholder="Agregar nombre" disabled={!canWrite} onSave={(v) => persist({ contactName: v ?? "" }, "Contacto guardado")} />
          </Field>
          {canWrite ? (
            <Field label="Contacto enlazado">
              <Select label="Contacto enlazado" value={lead.contactRef?.id ?? null} emptyLabel="Sin enlazar" searchable options={contacts.map((c) => ({ value: c.id, label: c.name, description: c.company ?? undefined }))} onValueChange={(v) => void persist({ contactId: v }, v ? "Contacto enlazado" : "Contacto desenlazado")} />
            </Field>
          ) : (
            lead.contactRef && (
              <Field label="Contacto enlazado">
                <Link to={`/comercial/contactos/${lead.contactRef.id}`} className="flex h-control items-center text-sm font-semibold text-accent-text hover:underline">
                  Ver ficha
                </Link>
              </Field>
            )
          )}
        </div>
      </InfoSection>

      <InfoSection title="Notas">
        <EditableText label="Notas del lead" multiline className="-mx-2 w-[calc(100%+1rem)]" value={lead.notes || null} placeholder="Qué necesita, contexto, próximos pasos…" disabled={!canWrite} onSave={(v) => persist({ notes: v ?? "" }, "Notas guardadas")} />
      </InfoSection>

      {hasSourceData && (
        <InfoSection title="Respuestas del formulario" action={<span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-muted px-3 text-xs font-semibold text-muted-foreground"><FileText className="size-3.5" aria-hidden />{lead.source}</span>}>
          <SourceDataTab lead={lead} />
        </InfoSection>
      )}
    </div>
  );
}

/**
 * Propuestas del lead (prototipo): los sitios publicados en WTProposalPlatform ligados al lead y
 * «Subir propuesta» con el lead ya elegido. Debajo, las propuestas que solo tienen un enlace.
 */
function LeadSites({ data, canWrite, adding, onAdd }: { data: LeadData; canWrite: boolean; adding: number; onAdd: () => void }) {
  const { lead } = data;
  const sites = useSites("live", { leadId: lead.id });
  const configured = useSitesConfig().data?.configured;
  const linked = new Set((sites.data?.items ?? []).map((s) => s.proposalId));
  const others = data.proposals.filter((p) => !linked.has(p.id));
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-6">
      <TabHead
        title="Propuestas"
        action={
          canWrite &&
          configured && (
            <Button onClick={() => setOpen(true)}>
              <Plus /> Subir propuesta
            </Button>
          )
        }
      />
      {configured !== false && <SitesList sites={sites.data?.items} isLoading={sites.isLoading} canWrite={canWrite && (sites.data?.canWrite ?? false)} showLinks={false} empty="Aún no hay propuestas publicadas para este lead." />}
      {(others.length > 0 || configured === false) && (
        <div className="space-y-3">
          <h4 className="text-caps-label">Enlaces y cotizaciones</h4>
          <ProposalsTab key={`proposals-${adding}`} leadId={lead.id} proposals={others} canWrite={canWrite} startAdding={adding > 0 && configured === false} />
          {configured === false && canWrite && !others.length && (
            <Button variant="outline" onClick={onAdd}>
              <Plus /> Agregar enlace
            </Button>
          )}
        </div>
      )}
      {open && <UploadSiteDialog open onClose={() => setOpen(false)} lead={{ id: lead.id, name: lead.title }} suggestedName={slugify(`demo-prospecto-${lead.company || lead.title}`)} />}
    </div>
  );
}

type ModalTab = "info" | "activities" | "meetings" | "proposals" | "comms" | "demos" | "deals";

/**
 * Detalle del lead en una ventana grande (prototipo): encabezado con el estado, pestañas
 * (Información, Actividades, Reuniones, Propuestas, Comunicaciones, Demos y Deals) y los Updates
 * a la derecha. Todo se edita en el lugar con guardado automático y «Deshacer». Financiera solo lee.
 */
export function LeadDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isLoading, error } = useLead(id);
  const refresh = useRefresh(id);
  const [tab, setTab] = useState<ModalTab>("info");
  const [adding, setAdding] = useState<{ tab: ModalTab; n: number } | null>(null);
  const canWrite = data?.canWrite ?? false;
  const save = useSaveLead(data?.lead ?? ({} as LeadDetail));
  const { create: createDealNow, busy: creatingDeal } = useCreateDeal(data?.lead ?? null);
  useCrumbs([data && { label: data.lead.title }]);
  const persist = (patch: Partial<LeadInput>, what?: string) => save(patch, what).catch((err: unknown) => toast.error("No se pudo guardar el cambio.", { description: errorText(err, "Inténtalo de nuevo.") }));
  const add = (t: ModalTab) => {
    setTab(t);
    setAdding((a) => ({ tab: t, n: (a?.n ?? 0) + 1 }));
  };

  const tabs: { id: ModalTab; label: string; count?: number }[] = data
    ? [
        { id: "info", label: "Información" },
        { id: "activities", label: "Actividades", count: data.pendingActivities },
        { id: "meetings", label: "Reuniones" },
        { id: "proposals", label: "Propuestas", count: data.proposals.length || undefined },
        { id: "comms", label: "Comunicaciones" },
        { id: "demos", label: "Demos", count: data.demos.length },
        { id: "deals", label: "Deals", count: data.deals.length },
      ]
    : [];

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup className="fixed inset-2 z-50 mx-auto flex max-w-[1320px] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-overlay outline-none sm:inset-x-6 sm:top-[46px] sm:bottom-[46px] lg:inset-x-[60px]">
          {isLoading || !data ? (
            <div className="space-y-4 p-8">
              <Dialog.Title className="sr-only">Lead</Dialog.Title>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error instanceof Error ? error.message : "Lead no encontrado."}
                </p>
              ) : (
                <>
                  <Skeleton className="h-9 w-64" />
                  <Skeleton className="h-80 w-full rounded-2xl" />
                </>
              )}
              <Button variant="outline" onClick={onClose}>
                Cerrar
              </Button>
            </div>
          ) : (
            <>
              <div className="flex items-start gap-3 px-4 pt-5 pb-4 sm:px-8 sm:pt-8 sm:pb-5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-3">
                    <Dialog.Title className="truncate text-2xl font-bold tracking-tight sm:text-[2rem]">{data.lead.title}</Dialog.Title>
                    <LeadStatusBadge value={data.lead.status} />
                  </div>
                  <Dialog.Description className="mt-1.5 text-sm text-muted-foreground">{[data.lead.contactName, `creado ${formatDate(data.lead.createdAt)}`].filter(Boolean).join(" · ")}</Dialog.Description>
                </div>
                {canWrite && (
                  <Button size="lg" variant="outline" loading={creatingDeal} onClick={() => void createDealNow()} className="max-sm:hidden">
                    {!creatingDeal && <Handshake />}
                    Crear deal
                  </Button>
                )}
                <Dialog.Close aria-label="Cerrar" className="inline-flex size-11 shrink-0 items-center justify-center rounded-[10px] border border-border bg-card transition-colors hover:border-line-strong hover:bg-muted">
                  <X className="size-5" />
                </Dialog.Close>
              </div>
              <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-5 overflow-y-auto px-4 pb-6 sm:px-8 sm:pb-8 lg:grid-cols-[minmax(0,1fr)_20rem] lg:content-stretch lg:overflow-hidden">
                <section className="flex flex-col rounded-[14px] border border-border bg-card lg:min-h-0">
                  <div role="tablist" aria-label="Secciones del lead" className="flex shrink-0 overflow-x-auto border-b border-border px-5">
                    {tabs.map((t) => (
                      <button
                        key={t.id}
                        role="tab"
                        type="button"
                        aria-selected={tab === t.id}
                        onClick={() => setTab(t.id)}
                        className={cn("-mb-px mr-4 inline-flex h-[52px] shrink-0 items-center gap-1.5 border-b-2 px-1 text-sm whitespace-nowrap transition-colors", tab === t.id ? "border-primary font-semibold text-foreground" : "border-transparent font-medium text-muted-foreground hover:text-foreground")}
                      >
                        {t.label}
                        {t.count !== undefined && <span className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11.5px] tabular-nums", tab === t.id ? "bg-accent-soft text-accent-text" : "bg-muted text-muted-foreground")}>{t.count}</span>}
                      </button>
                    ))}
                  </div>
                  <div role="tabpanel" className="proto-form min-h-64 flex-1 p-4 sm:p-6 lg:min-h-0 lg:overflow-y-auto">
                    {tab === "info" && <InfoTab data={data} canWrite={canWrite} persist={persist} />}
                    {tab === "activities" && (
                      <>
                        <TabHead title="Actividades" />
                        <ActivitiesTable leadId={data.lead.id} prefix="a." />
                      </>
                    )}
                    {tab === "meetings" && (
                      <>
                        <TabHead title="Reuniones" />
                        <MeetingsPanel base={leadBase(data.lead.id)} canWork={canWrite} deals={data.deals.map((d) => ({ id: d.id, dealCode: d.dealCode, title: d.title }))} />
                      </>
                    )}
                    {tab === "proposals" && <LeadSites data={data} canWrite={canWrite} adding={adding?.tab === "proposals" ? adding.n : 0} onAdd={() => add("proposals")} />}
                    {tab === "comms" && (
                      <>
                        <TabHead title="Comunicaciones" />
                        <CommsTab scope={{ leadId: data.lead.id }} defaultContact={data.lead.contactName ?? ""} />
                      </>
                    )}
                    {tab === "demos" && (
                      <>
                        <TabHead
                          title="Demos"
                          action={
                            canWrite && (
                              <Button onClick={() => add("demos")}>
                                <Plus /> Nueva demo
                              </Button>
                            )
                          }
                        />
                        <DemosTab key={`demos-${adding?.n ?? 0}`} leadId={data.lead.id} demos={data.demos} canWrite={canWrite} startAdding={adding?.tab === "demos"} />
                      </>
                    )}
                    {tab === "deals" && (
                      <>
                        <TabHead title="Deals" />
                        <DealsTab data={data} canWrite={canWrite} />
                      </>
                    )}
                  </div>
                </section>
                <UpdatesColumn base={leadBase(data.lead.id)} canWrite={canWrite} onPosted={refresh} />
              </div>
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
