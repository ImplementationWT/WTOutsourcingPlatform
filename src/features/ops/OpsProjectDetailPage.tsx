import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { TotalCell } from "@/components/data-table/cells";
import { useCrumbs } from "@/components/layout/crumbs";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
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
} from "./api";
import { HealthBadge, PriorityBadge, SentimentBar, StageTrack } from "./OpsBadges";
import { AccountsTab, DealsTab, MeetingsTab, ProposalsTab, TasksTab, UpdatesTab } from "./OpsTabs";

type TabId = "deals" | "tasks" | "proposals" | "accounts" | "meetings" | "updates";

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
      <Field label="Cliente" className="sm:col-span-2">
        {picksClient ? (
          <Select
            label="Cliente"
            value={project.client?.id ?? null}
            placeholder={project.customerName}
            searchable
            options={clients.map((c) => ({ value: c.id, label: c.name, description: c.company ?? undefined }))}
            onValueChange={(v) => v && v !== project.client?.id && void save({ contactIds: [v] })}
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
      <Field label="Developer">{person("Developer", project.developer, "developer", "developerUserId")}</Field>
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

export default function OpsProjectDetailPage() {
  const { id = "" } = useParams();
  const session = useSession().data;
  const { data, isLoading, error } = useOpsProject(id);
  useCrumbs([data && { label: data.project.name }]);
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<TabId>("deals");
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
    { id: "updates", label: "Updates", visible: true },
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
              {tab === "tasks" && <TasksTab projectId={project.id} teamId={project.team.id} canWork={permissions.work} canManage={permissions.manage} currentUserId={session?.id ?? ""} />}
              {tab === "accounts" && permissions.work && <AccountsTab projectId={project.id} canManage={permissions.manage} />}
              {tab === "proposals" && <ProposalsTab projectId={project.id} canManage={permissions.manage} />}
              {tab === "meetings" && <MeetingsTab projectId={project.id} canWork={permissions.work} />}
              {tab === "updates" && <UpdatesTab projectId={project.id} canWork={permissions.work} />}
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
