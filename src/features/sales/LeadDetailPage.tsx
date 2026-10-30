import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Loader2, Plus, UserCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useTeams } from "@/features/admin/api";
import { selectClass } from "@/features/admin/TeamAssignCard";
import { Empty, ErrorLine, MeetingsPanel, UpdatesPanel } from "@/features/activity/ActivityPanels";
import { activityKeys, dateText } from "@/features/activity/api";
import { money, opsKeys, PROPOSAL_STATUS_LABELS, PROPOSAL_STATUSES, STAGE_LABELS, useTeamMembers, type Proposal, type ProposalStatus } from "@/features/ops/api";
import { cn } from "@/lib/utils";
import {
  convertLead,
  createDemo,
  createLeadProposal,
  DEMO_STATUS_LABELS,
  DEMO_STATUSES,
  LEAD_STATUS_LABELS,
  LEAD_STATUSES,
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
  type LeadStatus,
} from "./api";
import { LeadStatusBadge } from "./SalesBadges";

type TabId = "demos" | "proposals" | "meetings" | "updates" | "data";

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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="text-sm">{children}</div>
    </div>
  );
}

/** Estado, responsable y datos de contacto. "Ganado" no se elige: se llega al convertir. */
function LeadControls({ lead }: { lead: LeadDetail }) {
  const refresh = useRefresh(lead.id);
  const owners = useOwners().data ?? [];
  const [error, setError] = useState<string | null>(null);
  const [lostReason, setLostReason] = useState(lead.lostReason ?? "");
  const won = lead.status === "won";

  async function save(patch: Parameters<typeof updateLead>[1]) {
    setError(null);
    try {
      await updateLead(lead.id, patch);
      await refresh();
    } catch (err) {
      setError(message(err, "No se pudo guardar el cambio."));
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Estado">
          <select
            aria-label="Estado del lead"
            className={cn(selectClass, "w-full")}
            value={lead.status}
            disabled={won}
            onChange={(e) => void save({ status: e.target.value as LeadStatus, ...(e.target.value === "lost" && lostReason.trim() ? { lostReason: lostReason.trim() } : {}) })}
          >
            {LEAD_STATUSES.filter((s) => s !== "won" || won).map((s) => (
              <option key={s} value={s}>
                {LEAD_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Responsable">
          <select aria-label="Responsable" className={cn(selectClass, "w-full")} value={lead.owner?.id ?? ""} onChange={(e) => void save({ ownerUserId: e.target.value || null })}>
            <option value="">Sin responsable</option>
            {owners.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Correo">
          {lead.email ? (
            <a className="break-all text-primary underline-offset-4 hover:underline" href={`mailto:${lead.email}`}>
              {lead.email}
            </a>
          ) : (
            "—"
          )}
        </Field>
        <Field label="Teléfono">
          {lead.phone ? (
            <a className="text-primary underline-offset-4 hover:underline" href={`tel:${lead.phone.replace(/[^\d+]/g, "")}`}>
              {lead.phone}
            </a>
          ) : (
            "—"
          )}
        </Field>
      </div>
      {lead.status === "lost" && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save({ lostReason: lostReason.trim() || null });
          }}
        >
          <div className="min-w-64 flex-1 space-y-1.5">
            <Label htmlFor="lost-reason">Motivo de la pérdida</Label>
            <Input id="lost-reason" value={lostReason} onChange={(e) => setLostReason(e.target.value)} placeholder="Sin presupuesto, eligió otra opción…" />
          </div>
          <Button type="submit" size="sm" variant="outline">
            Guardar motivo
          </Button>
        </form>
      )}
      {lead.notes && <p className="text-sm whitespace-pre-wrap text-muted-foreground">{lead.notes}</p>}
      <ErrorLine error={error} />
    </div>
  );
}

/** Convertir en cliente: crea el cliente y el proyecto en Operativa (Kick Off) con la propuesta aceptada. */
function ConvertCard({ lead, proposals }: { lead: LeadDetail; proposals: Proposal[] }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const teams = useTeams().data ?? [];
  const usable = proposals.filter((p) => p.status !== "rejected");
  const [teamId, setTeamId] = useState("");
  const [projectName, setProjectName] = useState(lead.company ? `Proyecto ${lead.company}` : "");
  const [proposalId, setProposalId] = useState(usable.find((p) => p.status === "accepted")?.id ?? usable[0]?.id ?? "");
  const [leadUserId, setLeadUserId] = useState("");
  const [developerUserId, setDeveloperUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const members = useTeamMembers(teamId || null, Boolean(teamId)).data ?? [];
  const valid = Boolean(teamId && projectName.trim().length >= 3 && proposalId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const { project } = await convertLead(lead.id, { teamId, projectName: projectName.trim(), proposalId, leadUserId: leadUserId || null, developerUserId: developerUserId || null });
      await Promise.all([queryClient.invalidateQueries({ queryKey: salesKeys.all }), queryClient.invalidateQueries({ queryKey: opsKeys.allProjects })]);
      navigate(`/operativa/${project.id}`);
    } catch (err) {
      setError(message(err, "No se pudo convertir el lead."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Convertir en cliente</CardTitle>
        <CardDescription>Crea el cliente y su proyecto en Operativa, en Kick Off, con la propuesta aceptada.</CardDescription>
      </CardHeader>
      <CardContent>
        {!usable.length ? (
          <p className="text-sm text-muted-foreground">Primero registra la propuesta que el cliente aceptó (pestaña Propuestas).</p>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="conv-name">Nombre del proyecto</Label>
                <Input id="conv-name" value={projectName} onChange={(e) => setProjectName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="conv-proposal">Propuesta aceptada</Label>
                <select id="conv-proposal" className={cn(selectClass, "w-full")} value={proposalId} onChange={(e) => setProposalId(e.target.value)}>
                  {usable.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title} ({PROPOSAL_STATUS_LABELS[p.status]})
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="conv-team">Equipo</Label>
                <select
                  id="conv-team"
                  className={cn(selectClass, "w-full")}
                  value={teamId}
                  onChange={(e) => {
                    setTeamId(e.target.value);
                    setLeadUserId("");
                    setDeveloperUserId("");
                  }}
                >
                  <option value="">Elige un equipo</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="conv-lead">Team Leader</Label>
                <select id="conv-lead" className={cn(selectClass, "w-full")} value={leadUserId} disabled={!teamId} onChange={(e) => setLeadUserId(e.target.value)}>
                  <option value="">Sin asignar</option>
                  {members
                    .filter((m) => m.role === "lead")
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="conv-dev">Developer</Label>
                <select id="conv-dev" className={cn(selectClass, "w-full")} value={developerUserId} disabled={!teamId} onChange={(e) => setDeveloperUserId(e.target.value)}>
                  <option value="">Sin asignar</option>
                  {members
                    .filter((m) => m.role === "developer")
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                </select>
              </div>
            </div>
            <ErrorLine error={error} />
            <Button type="submit" disabled={!valid || busy}>
              {busy ? <Loader2 className="animate-spin" /> : <UserCheck />}
              Convertir en cliente
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function DemosTab({ leadId, demos }: { leadId: string; demos: Demo[] }) {
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
      <form onSubmit={add} className="grid items-end gap-3 rounded-lg border border-foreground/10 p-4 sm:grid-cols-2 lg:grid-cols-[2fr_1.3fr_2fr_auto]">
        <div className="space-y-1.5">
          <Label htmlFor="demo-title">Demo</Label>
          <Input id="demo-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Demo del portal de pedidos" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="demo-date">Fecha y hora</Label>
          <Input id="demo-date" type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="demo-url">Enlace de la demo (opcional)</Label>
          <Input id="demo-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </div>
        <Button type="submit" disabled={!valid || busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}
          Agendar
        </Button>
      </form>
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
              <select aria-label={`Estado de ${d.title}`} className={cn(selectClass, "w-full")} value={d.status} onChange={(e) => void setStatus(d, e.target.value as DemoStatus)}>
                {DEMO_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {DEMO_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProposalsTab({ leadId, proposals }: { leadId: string; proposals: Proposal[] }) {
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
      <p className="text-sm text-muted-foreground">La web de la propuesta que se le envía al prospecto. Al marcarla como enviada, el lead pasa a «Propuesta enviada».</p>
      <form onSubmit={add} className="grid items-end gap-3 rounded-lg border border-foreground/10 p-4 sm:grid-cols-2 lg:grid-cols-[1.5fr_2fr_0.8fr_auto]">
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
      </form>
      <ErrorLine error={error} />
      {!proposals.length ? (
        <Empty>Aún no hay propuestas.</Empty>
      ) : (
        <ul className="space-y-2">
          {proposals.map((p) => (
            <li key={p.id} className="grid items-center gap-3 rounded-lg border border-foreground/10 p-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_10rem]">
              <a className="inline-flex min-w-0 items-center gap-1 truncate font-medium text-primary underline-offset-4 hover:underline" href={p.url} target="_blank" rel="noreferrer">
                {p.title} <ExternalLink className="size-3.5 shrink-0" />
              </a>
              <p className="text-sm tabular-nums">{p.amountCents !== null ? money(p.amountCents, p.currency) : "—"}</p>
              <p className="text-xs text-muted-foreground">{p.area === "operations" ? "Desde Operativa" : p.sentAt ? `Enviada ${dateText(p.sentAt)}` : ""}</p>
              <select aria-label={`Estado de ${p.title}`} className={cn(selectClass, "w-full")} value={p.status} onChange={(e) => void setStatus(p, e.target.value as ProposalStatus)}>
                {PROPOSAL_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {PROPOSAL_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
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
      <p className="text-sm text-muted-foreground">Datos recibidos desde {lead.source.name}. Lo que no encaja en los campos del lead queda aquí.</p>
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

export default function LeadDetailPage() {
  const { id = "" } = useParams();
  const { data, isLoading, error } = useLead(id);
  const refresh = useRefresh(id);
  const [tab, setTab] = useState<TabId>("demos");

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
        <Link to="/comercial" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Leads
        </Link>
        <p role="alert" className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Lead no encontrado."}
        </p>
      </div>
    );
  }

  const { lead, demos, proposals, project, customer } = data;
  const tabs: { id: TabId; label: string }[] = [
    { id: "demos", label: `Demos (${demos.length})` },
    { id: "proposals", label: `Propuestas (${proposals.length})` },
    { id: "meetings", label: "Reuniones" },
    { id: "updates", label: "Updates" },
    { id: "data", label: "Datos del source" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <Link to="/comercial" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Leads
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{lead.title}</h1>
          <LeadStatusBadge value={lead.status} />
          <Badge variant="outline">{lead.source.name}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {lead.contactName || "Sin contacto"} · creado {dateText(lead.createdAt)}
        </p>
      </div>

      <Card>
        <CardContent className="space-y-4 pt-4">
          <LeadControls key={lead.updatedAt} lead={lead} />
          {project && (
            <p className="text-sm">
              Cliente <span className="font-medium">{customer?.name}</span> · proyecto{" "}
              <Link className="text-primary underline-offset-4 hover:underline" to={`/operativa/${project.id}`}>
                {project.name}
              </Link>{" "}
              <span className="text-muted-foreground">({STAGE_LABELS[project.stage]})</span>
            </p>
          )}
        </CardContent>
      </Card>

      {lead.status !== "won" && <ConvertCard key={proposals.map((p) => p.id + p.status).join()} lead={lead} proposals={proposals} />}

      <div role="tablist" aria-label="Secciones del lead" className="-mx-4 flex gap-1 overflow-x-auto border-b border-foreground/10 px-4 sm:mx-0 sm:px-0">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "-mb-px shrink-0 border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors",
              tab === t.id ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {tab === "demos" && <DemosTab leadId={lead.id} demos={demos} />}
        {tab === "proposals" && <ProposalsTab leadId={lead.id} proposals={proposals} />}
        {tab === "meetings" && <MeetingsPanel base={leadBase(lead.id)} canWork />}
        {tab === "updates" && <UpdatesPanel base={leadBase(lead.id)} canWork onPosted={refresh} />}
        {tab === "data" && <SourceDataTab lead={lead} />}
      </div>
    </div>
  );
}
