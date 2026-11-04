import { useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, ExternalLink } from "lucide-react";
import { TotalCell } from "@/components/data-table/cells";
import { useCrumbs } from "@/components/layout/crumbs";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { MultiPicker } from "@/components/ui/multi-picker";
import { StatusBadge } from "@/components/ui/status-badge";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/features/auth/auth";
import { formatDate } from "@/lib/format";
import { errorText, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  clientLabel,
  HEALTH,
  HEALTH_LABELS,
  MAX_DEVELOPERS,
  STAGE_LABELS,
  daysBetween,
  money,
  stageAge,
  todayIso,
  useStageSla,
  NEXT_ACTION_LABELS,
  NEXT_ACTIONS,
  opsKeys,
  PAYMENT_TYPE_LABELS,
  PAYMENT_TYPES,
  PRIORITIES,
  PRIORITY_LABELS,
  updateProject,
  useClientOptions,
  useOpsProject,
  useTeamMembers,
  type OpsProject,
  type StageSla,
} from "./api";
import { HealthBadge, PriorityBadge, SentimentBar, StageTrack } from "./OpsBadges";
import { AccountsTab, DealsTab, MeetingsTab, ProposalsTab, UpdatesTab } from "./OpsTabs";
import { ProjectTasksPanel } from "@/features/tasks/TasksPage";
import { CommsTab } from "@/features/communications/CommsList";

type TabId = "deals" | "tasks" | "proposals" | "accounts" | "meetings" | "comms" | "updates" | "stages";
const TAB_IDS: readonly TabId[] = ["deals", "tasks", "proposals", "accounts", "meetings", "comms", "updates", "stages"];

/** Tarjeta de sección del detalle. */
function Panel({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** Campo con etiqueta en mayúsculas sobre el control (o el valor, en lectura). */
function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <p className="text-caps-label">{label}</p>
      <div className="min-h-control text-sm">{children}</div>
    </div>
  );
}

/** Valor de un campo en lectura, alineado con los controles. */
const Value = ({ children }: { children: ReactNode }) => <p className="flex min-h-control items-center font-medium">{children}</p>;

/** Enlace editable (SOW): guarda al salir del campo. */
function UrlInput({ label, value, onSave }: { label: string; value: string | null; onSave: (v: string | null) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const next = draft.trim() || null;
    setDraft(null);
    if (next !== value) onSave(next);
  };
  return <Input aria-label={label} value={draft ?? value ?? ""} placeholder="https://…" onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />;
}

/** Cliente: el contacto del proyecto, con enlace a su ficha para quien ve Contactos. */
function ClientValue({ project }: { project: OpsProject }) {
  const role = useSession().data?.role;
  const linkable = role === "boss" || role === "commercial" || role === "finance";
  if (project.client && linkable) {
    return (
      <Value>
        <Link className="text-primary underline-offset-4 hover:underline" to={`/comercial/contactos/${project.client.id}`}>
          {clientLabel(project)}
        </Link>
      </Value>
    );
  }
  return <Value>{clientLabel(project)}</Value>;
}

/**
 * Datos del proyecto. CEO/CCO y Team Leader del equipo los editan (guardan al cambiar); el resto
 * los lee. El Sentiment no se edita: sale del Health (§5.5).
 */
function ProjectData({ project, canManage }: { project: OpsProject; canManage: boolean }) {
  const queryClient = useQueryClient();
  const role = useSession().data?.role;
  const members = useTeamMembers(project.team.id, canManage).data ?? [];
  // El cliente lo eligen quienes crean proyectos (CEO/CCO y Team Leader).
  const picksClient = canManage && (role === "boss" || role === "lead");
  const clients = useClientOptions(picksClient).data ?? [];

  async function save(patch: Parameters<typeof updateProject>[1]) {
    try {
      await updateProject(project.id, patch);
      await Promise.all([queryClient.invalidateQueries({ queryKey: opsKeys.project(project.id) }), queryClient.invalidateQueries({ queryKey: opsKeys.allProjects })]);
    } catch (err) {
      toast.error("No se pudo guardar el cambio.", { description: errorText(err, "Inténtalo de nuevo.") });
    }
  }

  const select = <V extends string>(label: string, value: V | null, options: readonly V[], labels: Record<V, string>, onChange: (v: V | null) => void, empty?: string) =>
    canManage ? (
      <Select label={label} value={value ?? null} emptyLabel={empty} options={options.map((o) => ({ value: o, label: labels[o] }))} onValueChange={(v) => onChange(v as V | null)} />
    ) : (
      <Value>{value ? labels[value] : (empty ?? "—")}</Value>
    );

  const person = (label: string, value: OpsProject["lead"], role_: "lead" | "developer", key: "leadUserId" | "developerUserId") =>
    canManage ? (
      <Select
        label={label}
        value={value?.id ?? null}
        emptyLabel="Sin asignar"
        placeholder={value?.name ?? "Sin asignar"}
        options={members.filter((m) => m.role === role_).map((m) => ({ value: m.id, label: m.name }))}
        onValueChange={(v) => void save({ [key]: v })}
      />
    ) : (
      <Value>{value?.name ?? "Sin asignar"}</Value>
    );

  return (
    <div className="grid gap-x-4 gap-y-4 sm:grid-cols-2">
      <Field label="Contactos" className="sm:col-span-2">
        {picksClient ? (
          <MultiPicker
            label="Contactos"
            values={project.contacts.map((c) => c.id)}
            min={1}
            addLabel="Agregar contacto"
            options={[...clients.map((c) => ({ value: c.id, label: c.name, description: c.company ?? undefined })), ...project.contacts.filter((c) => !clients.some((x) => x.id === c.id)).map((c) => ({ value: c.id, label: c.name ?? "—" }))]}
            onChange={(ids) => void save({ contactIds: ids })}
          />
        ) : (
          <ClientValue project={project} />
        )}
      </Field>
      <Field label="Health">{select("Health", project.health, HEALTH, HEALTH_LABELS, (v) => v && void save({ health: v }))}</Field>
      <Field label="Sentiment (del Health)">
        <div className="flex min-h-control items-center">
          <SentimentBar value={project.sentimentScore} />
        </div>
      </Field>
      <Field label="Prioridad">{select("Prioridad", project.priority, PRIORITIES, PRIORITY_LABELS, (v) => v && void save({ priority: v }))}</Field>
      <Field label="Kickoff">
        {canManage ? <DatePicker label="Kickoff" value={project.kickoffDate} onValueChange={(v) => void save({ kickoffDate: v })} /> : <Value>{project.kickoffDate ? formatDate(project.kickoffDate) : "—"}</Value>}
      </Field>
      <Field label="Team Leader">{person("Team Leader", project.lead, "lead", "leadUserId")}</Field>
      <Field label={`Developers (máx. ${MAX_DEVELOPERS})`}>
        {canManage ? (
          <MultiPicker
            label="Developers"
            values={project.developers.map((d) => d.id)}
            max={MAX_DEVELOPERS}
            addLabel="Agregar developer"
            options={[...members.filter((m) => m.role === "developer").map((m) => ({ value: m.id, label: m.name })), ...project.developers.filter((d) => !members.some((m) => m.id === d.id)).map((d) => ({ value: d.id, label: d.name ?? "—" }))]}
            onChange={(ids) => void save({ developerUserIds: ids })}
          />
        ) : (
          <Value>{project.developers.map((d) => d.name).join(", ") || "Sin asignar"}</Value>
        )}
      </Field>
      <Field label="Tipo de pago">{select("Tipo de pago", project.paymentType, PAYMENT_TYPES, PAYMENT_TYPE_LABELS, (v) => void save({ paymentType: v }), "Sin definir")}</Field>
      <Field label="Siguiente acción">{select("Siguiente acción", project.nextAction, NEXT_ACTIONS, NEXT_ACTION_LABELS, (v) => void save({ nextAction: v }), "Sin definir")}</Field>
      <Field label="SOW" className="sm:col-span-2">
        {canManage ? (
          <UrlInput label="SOW" value={project.sowUrl} onSave={(v) => void save({ sowUrl: v })} />
        ) : project.sowUrl ? (
          <Value>
            <a className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline" href={project.sowUrl} target="_blank" rel="noreferrer">
              Abrir SOW <ExternalLink className="size-3.5" />
            </a>
          </Value>
        ) : (
          <Value>—</Value>
        )}
      </Field>
    </div>
  );
}

/** Resumen calculado en el servidor: horas vendidas, facturables y avance (§4.2). */
function SummaryCard({ project }: { project: OpsProject }) {
  const s = project.summary;
  const rows: [string, ReactNode][] = [
    ["Horas vendidas", <TotalCell hours={s.soldHours} strong />],
    ["Horas facturables", <TotalCell hours={s.billableHours} strong />],
    ["Facturable vs deals", <TotalCell hours={s.billableVsSold} strong />],
    ["Valor vendido", <TotalCell cents={s.amountCents} strong />],
    ["Hourly rate", <span className="font-semibold tabular-nums">{s.soldHours ? `${money(Math.round(s.amountCents / s.soldHours))} / h` : "—"}</span>],
  ];
  return (
    <Panel title="Resumen">
      <div className="space-y-4">
        <div>
          <div className="flex items-baseline justify-between">
            <p className="text-3xl font-bold tracking-tight tabular-nums">{s.progress}%</p>
            <p className="text-sm text-muted-foreground">
              {s.tasksDone}/{s.tasks} tareas
            </p>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Avance" aria-valuenow={s.progress} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, Math.max(0, s.progress))}%` }} />
          </div>
        </div>
        <dl className="space-y-0.5 rounded-xl border border-border bg-muted/30 px-4 py-2">
          {rows.map(([label, value]) => (
            <div key={label} className="flex min-h-9 items-center justify-between gap-3 text-sm">
              <dt className="text-muted-foreground">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Panel>
  );
}

/** Tiempo en la etapa actual contra su plazo, con acceso al historial. */
function StageAlert({ project, sla, onHistory }: { project: OpsProject; sla: StageSla | undefined; onHistory: () => void }) {
  if (!sla) return null;
  const limit = sla[project.stage];
  const age = stageAge(project.stageSince, limit);
  const name = STAGE_LABELS[project.stage];
  const title = limit === null ? `Etapa ${name}` : age.over > 0 ? `Atrasado en ${name}` : age.tone === "warn" ? `Cerca del límite en ${name}` : `En tiempo en ${name}`;
  const estimated = project.stageHistory.at(-1)?.estimated;
  return (
    <div className={cn("flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3", age.tone === "danger" ? "border-danger/40 bg-danger/5" : age.tone === "warn" ? "border-warn/40 bg-warn/5" : "border-border")} aria-label="Tiempo en etapa">
      {age.tone === "danger" && <AlertTriangle className="size-4 text-danger" aria-hidden />}
      <StatusBadge tone={age.tone}>{limit === null ? `${age.days} d` : age.text}</StatusBadge>
      <div className="min-w-52 flex-1 text-sm">
        <p className="font-semibold">{title}</p>
        <p className="text-muted-foreground">
          Desde {formatDate(project.stageSince)}
          {estimated ? " (estimado)" : ""} · {age.days} días{limit !== null ? ` de ${limit} esperados` : ""}
          {age.over > 0 ? `, +${age.over} de atraso. Revisa el bloqueo para que los developers tengan trabajo.` : "."}
        </p>
      </div>
      <button type="button" onClick={onHistory} className="text-sm font-semibold text-primary underline-offset-4 hover:underline">
        Ver histórico
      </button>
    </div>
  );
}

/** Historial de etapas: cuándo entró a cada una, cuántos días estuvo y si cumplió el plazo. */
function StagesTab({ project, sla }: { project: OpsProject; sla: StageSla | undefined }) {
  const history = project.stageHistory.length ? project.stageHistory : [{ stage: project.stage, at: project.stageSince, by: "—" }];
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] text-sm">
        <caption className="sr-only">Historial de etapas</caption>
        <thead>
          <tr className="text-left">
            {["Etapa", "Entró", "Días", "Esperado", "Estado"].map((h) => (
              <th key={h} scope="col" className="text-caps-label border-b border-border px-3 py-2 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {history.map((h, i) => {
            const current = i === history.length - 1;
            const days = daysBetween(h.at, history[i + 1]?.at ?? todayIso());
            const limit = sla?.[h.stage] ?? null;
            const over = limit === null ? 0 : days - limit;
            const tone = limit === null ? "neutral" : over > 0 ? "danger" : current && days >= limit * 0.75 ? "warn" : "ok";
            const status = limit === null ? "Sin límite" : over > 0 ? `+${over} d de atraso` : current ? "En tiempo" : "Cumplida";
            return (
              <tr key={`${h.stage}-${h.at}-${i}`} className="border-b border-border last:border-0">
                <td className="px-3 py-2.5 font-medium">
                  {STAGE_LABELS[h.stage]}
                  {current && <span className="ml-1.5 text-xs text-muted-foreground">· actual</span>}
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  {formatDate(h.at)}
                  {"estimated" in h && h.estimated ? <span className="ml-1 text-xs text-muted-foreground">(estimado)</span> : null}
                </td>
                <td className="px-3 py-2.5 tabular-nums">{days} d</td>
                <td className="px-3 py-2.5 tabular-nums">{limit === null ? "—" : `${limit} d`}</td>
                <td className="px-3 py-2.5">
                  <StatusBadge tone={tone}>{status}</StatusBadge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function OpsProjectDetailPage() {
  const { id = "" } = useParams();
  const session = useSession().data;
  const { data, isLoading, error } = useOpsProject(id);
  useCrumbs([data && { label: data.project.name }]);
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const asked = params.get("tab") as TabId | null;
  const [tab, setTab] = useState<TabId>(asked && TAB_IDS.includes(asked) ? asked : "deals");
  const sla = useStageSla().data?.days;
  const updateStage = async (stage: OpsProject["stage"]) => {
    try {
      await updateProject(id, { stage });
      await Promise.all([queryClient.invalidateQueries({ queryKey: opsKeys.project(id) }), queryClient.invalidateQueries({ queryKey: opsKeys.allProjects })]);
    } catch (err) {
      toast.error("No se pudo cambiar la etapa.", { description: errorText(err, "Inténtalo de nuevo.") });
    }
  };

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
        <Link to="/operativa" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground lg:hidden">
          <ArrowLeft className="size-4" /> Proyectos
        </Link>
        <p role="alert" className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Proyecto no encontrado."}
        </p>
      </div>
    );
  }

  const { project, permissions } = data;
  const tabs: { id: TabId; label: string; visible: boolean }[] = [
    { id: "deals", label: "Deals", visible: true },
    { id: "tasks", label: "Tasks", visible: true },
    { id: "proposals", label: "Propuestas", visible: true },
    // Comercial y Financiera no ven las cuentas: la API tampoco se las da.
    { id: "accounts", label: "Cuentas", visible: permissions.work },
    { id: "meetings", label: "Reuniones", visible: true },
    { id: "comms", label: "Comunicaciones", visible: true },
    { id: "updates", label: "Updates", visible: true },
    { id: "stages", label: "Etapas", visible: true },
  ];
  const showLead = Boolean(project.leadId) && (session?.role === "boss" || session?.role === "commercial");
  const linkClass = "flex items-center justify-between gap-2 rounded-lg px-1 py-1.5 text-sm font-medium transition-colors hover:bg-accent";

  return (
    <div className="space-y-6">
      <Link to="/operativa" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground lg:hidden">
        <ArrowLeft className="size-4" /> Proyectos
      </Link>
      <PageHeader
        title={project.name}
        badges={
          <>
            <HealthBadge value={project.health} />
            <PriorityBadge value={project.priority} />
          </>
        }
        description={`${clientLabel(project)} · ${project.team.name ?? "Sin equipo"}`}
      />

      <Card size="sm">
        <CardContent className="space-y-2">
          <p className="text-caps-label">Etapa</p>
          <StageTrack stage={project.stage} onChange={permissions.manage ? (stage) => void updateStage(stage) : undefined} />
          <StageAlert project={project} sla={sla} onHistory={() => setTab("stages")} />
        </CardContent>
      </Card>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-5">
          <Panel title="Datos del proyecto">
            <ProjectData project={project} canManage={permissions.manage} />
          </Panel>

          <Card className="gap-0 pt-2 pb-0">
            <div role="tablist" aria-label="Secciones del proyecto" className="flex gap-1 overflow-x-auto border-b border-border px-3">
              {tabs
                .filter((t) => t.visible)
                .map((t) => (
                  <button
                    key={t.id}
                    role="tab"
                    type="button"
                    aria-selected={tab === t.id}
                    onClick={() => setTab(t.id)}
                    className={cn(
                      "-mb-px shrink-0 border-b-2 px-3 py-3 text-sm font-semibold whitespace-nowrap transition-colors",
                      tab === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t.label}
                  </button>
                ))}
            </div>
            <div role="tabpanel" className="min-h-64 p-5">
              {tab === "deals" && <DealsTab projectId={project.id} />}
              {tab === "tasks" && <ProjectTasksPanel projectId={project.id} />}
              {tab === "accounts" && permissions.work && <AccountsTab projectId={project.id} canManage={permissions.manage} />}
              {tab === "proposals" && <ProposalsTab projectId={project.id} canManage={permissions.manage} />}
              {tab === "meetings" && <MeetingsTab projectId={project.id} canWork={permissions.work} />}
              {tab === "updates" && <UpdatesTab projectId={project.id} canWork={permissions.work} />}
              {tab === "stages" && <StagesTab project={project} sla={sla} />}
              {tab === "comms" && <CommsTab scope={{ projectId: project.id }} defaultContact={project.client?.name ?? ""} />}
            </div>
          </Card>
        </div>

        <aside className="space-y-5" aria-label="Resumen del proyecto">
          <SummaryCard project={project} />
          {(project.sowUrl || showLead || project.clientSlug) && (
            <Panel title="Enlaces">
              <div className="-mx-1 space-y-0.5">
                {project.sowUrl && (
                  <a className={linkClass} href={project.sowUrl} target="_blank" rel="noreferrer">
                    SOW <ExternalLink className="size-3.5 text-muted-foreground" />
                  </a>
                )}
                {showLead && (
                  <Link className={linkClass} to={`/comercial/leads/${project.leadId}`}>
                    Lead en Comercial
                  </Link>
                )}
                {project.clientSlug && (
                  <Link className={linkClass} to={`/projects/${project.clientSlug}`}>
                    App en Infraestructura
                  </Link>
                )}
              </div>
            </Panel>
          )}
        </aside>
      </div>
    </div>
  );
}
