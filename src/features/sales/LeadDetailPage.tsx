import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useConfirm } from "@/components/ui/confirm-context";
import { DatePicker, DateTimePicker } from "@/components/ui/date-picker";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Loader2, Plus, UserCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useTeams } from "@/features/admin/api";
import { Empty, ErrorLine, MeetingsPanel, UpdatesPanel } from "@/features/activity/ActivityPanels";
import { activityKeys, dateText } from "@/features/activity/api";
import { money, opsKeys, PROPOSAL_STATUS_LABELS, PROPOSAL_STATUSES, STAGE_LABELS, useTeamMembers, type Proposal, type ProposalStatus } from "@/features/ops/api";
import { cn } from "@/lib/utils";
import { ActivitiesTable } from "@/features/commercial/ActivitiesTable";
import { useCompanyOptions, useContactOptions } from "@/features/core/api";
import {
  addDemoLearning,
  convertLead,
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
  type LeadStatus,
  type LeadTemperature,
} from "./api";
import { LeadStatusBadge } from "./SalesBadges";

type TabId = "demos" | "proposals" | "activities" | "meetings" | "updates" | "data";

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

/**
 * Estado, temperatura, funnel, Setter y Closer, fechas y enlaces del lead (§4.1). "Ganado" no se
 * elige: se llega al convertir. Financiera ve todo en lectura.
 */
function LeadControls({ lead, canWrite }: { lead: LeadDetail; canWrite: boolean }) {
  const refresh = useRefresh(lead.id);
  const owners = useOwners(canWrite).data ?? [];
  const companies = useCompanyOptions(canWrite).data ?? [];
  const contacts = useContactOptions(lead.companyRef?.id ?? null, canWrite).data ?? [];
  const [error, setError] = useState<string | null>(null);
  const [lostReason, setLostReason] = useState(lead.lostReason ?? "");
  const [proposalUrl, setProposalUrl] = useState(lead.proposalUrl ?? "");
  const won = lead.status === "won";
  const disabled = !canWrite;

  async function save(patch: Parameters<typeof updateLead>[1]) {
    setError(null);
    try {
      await updateLead(lead.id, patch);
      await refresh();
    } catch (err) {
      setError(message(err, "No se pudo guardar el cambio."));
    }
  }

  const people = (label: string, value: { id: string; name: string | null } | null, key: "setterUserId" | "closerUserId") => (
    <Field label={label}>
      {canWrite ? (
        <Select
          label={label}
          value={value?.id ?? null}
          emptyLabel="Sin asignar"
          options={owners.map((o) => ({ value: o.id, label: o.name }))}
          onValueChange={(v) => void save({ [key]: v })}
        />
      ) : (
        (value?.name ?? "Sin asignar")
      )}
    </Field>
  );

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Estado">
          <Select
            label="Estado del lead"
            value={lead.status}
            options={LEAD_STATUSES.filter((s) => s !== "won" || won).map((s) => ({ value: s, label: LEAD_STATUS_LABELS[s] }))}
            disabled={won || disabled}
            onValueChange={(v) => void save({ status: (v ?? "") as LeadStatus, ...((v ?? "") === "lost" && lostReason.trim() ? { lostReason: lostReason.trim() } : {}) })}
          />
        </Field>
        <Field label="Temperatura">
          <Select
            label="Temperatura"
            value={lead.temperature ?? null}
            emptyLabel="Sin definir"
            options={LEAD_TEMPERATURES.map((t) => ({ value: t, label: LEAD_TEMPERATURE_LABELS[t] }))}
            disabled={disabled}
            onValueChange={(v) => void save({ temperature: v as LeadTemperature | null })}
          />
        </Field>
        <Field label="Funnel">
          <Select
            label="Funnel"
            value={lead.funnel ?? null}
            emptyLabel="Sin definir"
            options={LEAD_FUNNELS.map((f) => ({ value: f, label: LEAD_FUNNEL_LABELS[f] }))}
            disabled={disabled}
            onValueChange={(v) => void save({ funnel: v as LeadFunnel | null })}
          />
        </Field>
        <Field label="Respuesta">
          {lead.responseDays === null ? <span className="text-muted-foreground">Falta la fecha de submission o de reunión</span> : `${lead.responseDays} días`}
        </Field>
        {people("Setter", lead.setter, "setterUserId")}
        {people("Closer", lead.closer, "closerUserId")}
        <Field label="Submission">
          <DatePicker label="Fecha de submission" disabled={disabled} value={lead.submittedAt} onValueChange={(v) => void save({ submittedAt: v })} />
        </Field>
        <Field label="Reunión">
          <DatePicker label="Fecha de reunión" disabled={disabled} value={lead.meetingAt} onValueChange={(v) => void save({ meetingAt: v })} />
        </Field>
        <Field label="Empresa">
          {canWrite ? (
            <Select
              label="Empresa"
              value={lead.companyRef?.id ?? null}
              emptyLabel={lead.company ? `${lead.company} (sin enlazar)` : "Sin empresa"}
              options={companies.map((c) => ({ value: c.id, label: c.name }))}
              onValueChange={(v) => void save({ companyId: v })}
            />
          ) : lead.companyRef ? (
            <Link className="text-primary underline-offset-4 hover:underline" to={`/comercial/empresas/${lead.companyRef.id}`}>
              {lead.companyRef.name}
            </Link>
          ) : (
            lead.company || "—"
          )}
        </Field>
        <Field label="Contacto">
          {canWrite ? (
            <Select
              label="Contacto"
              value={lead.contactRef?.id ?? null}
              emptyLabel={lead.contactName ? `${lead.contactName} (sin enlazar)` : "Sin contacto"}
              options={contacts.map((c) => ({ value: c.id, label: c.name }))}
              onValueChange={(v) => void save({ contactId: v })}
            />
          ) : lead.contactRef ? (
            <Link className="text-primary underline-offset-4 hover:underline" to={`/comercial/contactos/${lead.contactRef.id}`}>
              {lead.contactRef.name}
            </Link>
          ) : (
            lead.contactName || "—"
          )}
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
      {canWrite ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save({ proposalUrl: proposalUrl.trim() || null });
          }}
        >
          <div className="min-w-64 flex-1 space-y-1.5">
            <Label htmlFor="lead-proposal-url">Propuesta (enlace)</Label>
            <Input id="lead-proposal-url" value={proposalUrl} onChange={(e) => setProposalUrl(e.target.value)} placeholder="https://…" />
          </div>
          <Button type="submit" size="sm" variant="outline" disabled={(proposalUrl.trim() || null) === lead.proposalUrl}>
            Guardar enlace
          </Button>
        </form>
      ) : (
        lead.proposalUrl && (
          <a className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline" href={lead.proposalUrl} target="_blank" rel="noreferrer">
            Propuesta <ExternalLink className="size-3.5" />
          </a>
        )
      )}
      {lead.status === "lost" && canWrite && (
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
      {lead.status === "lost" && !canWrite && lead.lostReason && <p className="text-sm">Motivo de la pérdida: {lead.lostReason}</p>}
      {lead.notes && <p className="text-sm whitespace-pre-wrap text-muted-foreground">{lead.notes}</p>}
      <ErrorLine error={error} />
    </div>
  );
}

/**
 * Convertir en cliente (§5.3): crea la empresa y el contacto (si no existen), el proyecto en Kick Off
 * con la propuesta aceptada y su deal aprobado. Se pregunta antes de crear.
 */
function ConvertCard({ lead, proposals }: { lead: LeadDetail; proposals: Proposal[] }) {
  const confirm = useConfirm();
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
    const proposal = usable.find((p) => p.id === proposalId);
    const question = [
      `Se marcará el lead como ganado y la propuesta «${proposal?.title ?? ""}» como aceptada, y se creará:`,
      `• la empresa «${lead.company || lead.contactName || lead.title}» y su contacto (si aún no existen),`,
      `• el proyecto «${projectName.trim()}» en Kick Off,`,
      "• un deal aprobado ligado al proyecto.",
    ].join("\n");
    const ok = await confirm({ title: `¿Convertir «${lead.title}» en cliente?`, description: question, confirmLabel: "Convertir en cliente" });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const { project } = await convertLead(lead.id, { teamId, projectName: projectName.trim(), proposalId, leadUserId: leadUserId || null, developerUserId: developerUserId || null });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: salesKeys.all }),
        queryClient.invalidateQueries({ queryKey: opsKeys.allProjects }),
        queryClient.invalidateQueries({ queryKey: ["core"] }),
      ]);
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
        <CardDescription>Crea la empresa, el contacto, el proyecto en Kick Off con la propuesta aceptada y su deal aprobado. Te pedirá confirmación.</CardDescription>
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
                <Select
                  id="conv-proposal"
                  value={proposalId}
                  options={usable.map((p) => ({ value: p.id, label: `${p.title} (${PROPOSAL_STATUS_LABELS[p.status]})` }))}
                  onValueChange={(v) => setProposalId((v ?? ""))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="conv-team">Equipo</Label>
                <Select
                  id="conv-team"
                  value={teamId || null}
                  emptyLabel="Elige un equipo"
                  options={teams.map((t) => ({ value: t.id, label: t.name }))}
                  onValueChange={(v) => {
                    setTeamId((v ?? ""));
                    setLeadUserId("");
                    setDeveloperUserId("");
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="conv-lead">Team Leader</Label>
                <Select
                  id="conv-lead"
                  value={leadUserId || null}
                  emptyLabel="Sin asignar"
                  options={members.filter((m) => m.role === "lead").map((m) => ({ value: m.id, label: m.name }))}
                  disabled={!teamId}
                  onValueChange={(v) => setLeadUserId((v ?? ""))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="conv-dev">Developer</Label>
                <Select
                  id="conv-dev"
                  value={developerUserId || null}
                  emptyLabel="Sin asignar"
                  options={members.filter((m) => m.role === "developer").map((m) => ({ value: m.id, label: m.name }))}
                  disabled={!teamId}
                  onValueChange={(v) => setDeveloperUserId((v ?? ""))}
                />
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

  const { lead, demos, proposals, project, company, deal, canWrite } = data;
  const tabs: { id: TabId; label: string }[] = [
    { id: "demos", label: `Demos (${demos.length})` },
    { id: "proposals", label: `Propuestas (${proposals.length})` },
    { id: "activities", label: "Actividades" },
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
          <LeadControls key={lead.updatedAt} lead={lead} canWrite={canWrite} />
          {project && (
            <p className="text-sm">
              Cliente{" "}
              {company ? (
                <Link className="font-medium text-primary underline-offset-4 hover:underline" to={`/comercial/empresas/${company.id}`}>
                  {company.name}
                </Link>
              ) : (
                <span className="font-medium">—</span>
              )}{" "}
              · proyecto{" "}
              <Link className="text-primary underline-offset-4 hover:underline" to={`/operativa/${project.id}`}>
                {project.name}
              </Link>{" "}
              <span className="text-muted-foreground">({STAGE_LABELS[project.stage]})</span>
              {deal && (
                <>
                  {" "}
                  · deal{" "}
                  <Link className="text-primary underline-offset-4 hover:underline" to={`/deals/${deal.id}`}>
                    {deal.dealCode}
                  </Link>
                </>
              )}
            </p>
          )}
        </CardContent>
      </Card>

      {lead.status !== "won" && canWrite && <ConvertCard key={proposals.map((p) => p.id + p.status).join()} lead={lead} proposals={proposals} />}

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
        {tab === "demos" && <DemosTab leadId={lead.id} demos={demos} canWrite={canWrite} />}
        {tab === "proposals" && <ProposalsTab leadId={lead.id} proposals={proposals} canWrite={canWrite} />}
        {tab === "activities" && <ActivitiesTable leadId={lead.id} prefix="a." />}
        {tab === "meetings" && <MeetingsPanel base={leadBase(lead.id)} canWork={canWrite} deals={deal ? [deal] : []} />}
        {tab === "updates" && <UpdatesPanel base={leadBase(lead.id)} canWork={canWrite} onPosted={refresh} />}
        {tab === "data" && <SourceDataTab lead={lead} />}
      </div>
    </div>
  );
}
