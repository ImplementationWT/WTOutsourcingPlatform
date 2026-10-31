import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { DatePicker } from "@/components/ui/date-picker";
import { Select } from "@/components/ui/select";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/features/auth/auth";
import { TotalCell } from "@/components/data-table/cells";
import { useContactOptions } from "@/features/core/api";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
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
  useOpsProject,
  useTeamMembers,
  type OpsProject,
} from "./api";
import { HealthBadge, PriorityBadge, SentimentBar, StageTrack } from "./OpsBadges";
import { AccountsTab, DealsTab, MeetingsTab, ProposalsTab, TasksTab, UpdatesTab } from "./OpsTabs";

type TabId = "deals" | "tasks" | "proposals" | "accounts" | "meetings" | "updates";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="text-sm">{children}</div>
    </div>
  );
}

/** Enlace editable (Project Plan, SOW, propuesta): guarda al salir del campo. */
function UrlField({ label, value, onSave }: { label: string; value: string | null; onSave: (v: string | null) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const next = draft.trim() || null;
    setDraft(null);
    if (next !== value) onSave(next);
  };
  return (
    <Field label={label}>
      <Input aria-label={label} value={draft ?? value ?? ""} placeholder="https://…" onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
    </Field>
  );
}

/**
 * Controles del proyecto (solo CEO/CCO y Team Leader del equipo). El Sentiment no se edita: sale
 * del Health (§5.5).
 */
function ProjectControls({ project }: { project: OpsProject }) {
  const queryClient = useQueryClient();
  const role = useSession().data?.role;
  const members = useTeamMembers(project.team.id).data ?? [];
  // Los contactos los lista el CEO/CCO (el Team Leader los ve en el proyecto, pero no la lista completa).
  const picksContacts = role === "boss";
  const contacts = useContactOptions(picksContacts).data ?? [];
  const [customer, setCustomer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(patch: Parameters<typeof updateProject>[1]) {
    setError(null);
    try {
      await updateProject(project.id, patch);
      await Promise.all([queryClient.invalidateQueries({ queryKey: opsKeys.project(project.id) }), queryClient.invalidateQueries({ queryKey: opsKeys.allProjects })]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el cambio.");
    }
  }

  const select = <V extends string>(label: string, value: V | null, options: readonly V[], labels: Record<V, string>, onChange: (v: V | null) => void, empty?: string) => (
    <Field label={label}>
      <Select
        label={label}
        value={value ?? null}
        emptyLabel={empty}
        options={options.map((o) => ({ value: o, label: labels[o] }))}
        onValueChange={(v) => onChange(v as V | null)}
      />
    </Field>
  );

  return (
    <div className="space-y-3">
      <StageTrack stage={project.stage} onChange={(stage) => void save({ stage })} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {select("Health", project.health, HEALTH, HEALTH_LABELS, (v) => v && void save({ health: v }))}
        <Field label="Sentiment (del Health)">
          <SentimentBar value={project.sentimentScore} />
        </Field>
        {select("Prioridad", project.priority, PRIORITIES, PRIORITY_LABELS, (v) => v && void save({ priority: v }))}
        <Field label="Kickoff">
          <DatePicker label="Kickoff" value={project.kickoffDate} onValueChange={(v) => void save({ kickoffDate: v })} />
        </Field>
        <Field label="Team Leader">
          <Select
            label="Team Leader"
            value={project.lead?.id ?? null}
            emptyLabel="Sin asignar"
            options={members.filter((m) => m.role === "lead").map((m) => ({ value: m.id, label: m.name }))}
            onValueChange={(v) => void save({ leadUserId: v })}
          />
        </Field>
        <Field label="Developer">
          <Select
            label="Developer"
            value={project.developer?.id ?? null}
            emptyLabel="Sin asignar"
            options={members.filter((m) => m.role === "developer").map((m) => ({ value: m.id, label: m.name }))}
            onValueChange={(v) => void save({ developerUserId: v })}
          />
        </Field>
        {select("Tipo de pago", project.paymentType, PAYMENT_TYPES, PAYMENT_TYPE_LABELS, (v) => void save({ paymentType: v }), "Sin definir")}
        {select("Siguiente acción", project.nextAction, NEXT_ACTIONS, NEXT_ACTION_LABELS, (v) => void save({ nextAction: v }), "Sin definir")}
        <Field label="Cliente">
          <Input
            aria-label="Cliente"
            value={customer ?? project.customerName}
            onChange={(e) => setCustomer(e.target.value)}
            onBlur={() => {
              const next = customer?.trim();
              setCustomer(null);
              if (next && next.length >= 2 && next !== project.customerName) void save({ customerName: next });
            }}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
        </Field>
        <Field label="Contactos">
          <div className="space-y-1.5">
            <ContactLinks project={project} />
            {picksContacts && (
              <Select
                label="Agregar contacto"
                value={null}
                placeholder="Agregar contacto…"
                searchable
                size="sm"
                options={contacts.filter((c) => !project.contacts.some((x) => x.id === c.id)).map((c) => ({ value: c.id, label: c.name, description: c.company ?? undefined }))}
                onValueChange={(v) => v && void save({ contactIds: [...project.contacts.map((x) => x.id), v] })}
              />
            )}
          </div>
        </Field>
        <UrlField label="Propuesta" value={project.proposalUrl} onSave={(v) => void save({ proposalUrl: v })} />
        <UrlField label="Project Plan" value={project.projectPlanUrl} onSave={(v) => void save({ projectPlanUrl: v })} />
        <UrlField label="SOW" value={project.sowUrl} onSave={(v) => void save({ sowUrl: v })} />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function ContactLinks({ project }: { project: OpsProject }) {
  const role = useSession().data?.role;
  if (!project.contacts.length) return <span className="text-muted-foreground">Sin contactos</span>;
  const linkable = role === "boss" || role === "commercial" || role === "finance";
  return (
    <span className="flex flex-wrap gap-x-2">
      {project.contacts.map((c) =>
        linkable ? (
          <Link key={c.id} className="text-primary underline-offset-4 hover:underline" to={`/comercial/contactos/${c.id}`}>
            {c.name ?? "Contacto"}
          </Link>
        ) : (
          <span key={c.id}>{c.name ?? "Contacto"}</span>
        ),
      )}
    </span>
  );
}

/** Resumen calculado en el servidor: horas vendidas, facturables y avance (§4.2). */
function ProjectSummary({ project }: { project: OpsProject }) {
  const s = project.summary;
  const items = [
    { label: "Horas vendidas", value: <TotalCell hours={s.soldHours} strong /> },
    { label: "Horas facturables", value: <TotalCell hours={s.billableHours} strong /> },
    { label: "Facturable vs deals", value: <TotalCell hours={s.billableVsSold} strong /> },
    { label: "Avance", value: <span className="font-medium">{s.progress}%</span>, hint: `${s.tasksDone}/${s.tasks} tareas` },
    { label: "Valor vendido", value: <TotalCell cents={s.amountCents} strong /> },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {items.map((k) => (
        <div key={k.label} className="rounded-lg border border-foreground/10 p-3">
          <p className="text-xs text-muted-foreground">{k.label}</p>
          <p className="mt-1">{k.value}</p>
          {k.hint && <p className="text-xs text-muted-foreground">{k.hint}</p>}
        </div>
      ))}
    </div>
  );
}

export default function OpsProjectDetailPage() {
  const { id = "" } = useParams();
  const session = useSession().data;
  const { data, isLoading, error } = useOpsProject(id);
  const [tab, setTab] = useState<TabId>("deals");

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
        <Link to="/operativa" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Proyectos del cliente
        </Link>
        <p role="alert" className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Proyecto no encontrado."}
        </p>
      </div>
    );
  }

  const { project, permissions } = data;
  const links = (
    [
      ["Propuesta", project.proposalUrl],
      ["Project Plan", project.projectPlanUrl],
      ["SOW", project.sowUrl],
    ] as [string, string | null][]
  ).filter((l): l is [string, string] => Boolean(l[1]));
  const tabs: { id: TabId; label: string; visible: boolean }[] = [
    { id: "deals", label: "Deals", visible: true },
    { id: "tasks", label: "Tasks", visible: true },
    { id: "proposals", label: "Propuestas", visible: true },
    // Comercial y Financiera no ven las cuentas: la API tampoco se las da.
    { id: "accounts", label: "Cuentas", visible: permissions.work },
    { id: "meetings", label: "Reuniones", visible: true },
    { id: "updates", label: "Updates", visible: true },
  ];

  return (
    <div className="space-y-6">
      <div>
        <Link to="/operativa" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Proyectos del cliente
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{project.name}</h1>
          <HealthBadge value={project.health} />
          <PriorityBadge value={project.priority} />
        </div>
        <p className="text-sm text-muted-foreground">
          {project.customerName} · {project.team.name ?? "Sin equipo"}
        </p>
      </div>

      <Card>
        <CardContent className="space-y-4 pt-4">
          {permissions.manage ? (
            <ProjectControls project={project} />
          ) : (
            <>
              <StageTrack stage={project.stage} />
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Sentiment (del Health)">
                  <SentimentBar value={project.sentimentScore} />
                </Field>
                <Field label="Team Leader">{project.lead?.name ?? "Sin asignar"}</Field>
                <Field label="Developer">{project.developer?.name ?? "Sin asignar"}</Field>
                <Field label="Kickoff">{project.kickoffDate ? formatDate(project.kickoffDate) : "—"}</Field>
                <Field label="Tipo de pago">{project.paymentType ? PAYMENT_TYPE_LABELS[project.paymentType] : "—"}</Field>
                <Field label="Siguiente acción">{project.nextAction ? NEXT_ACTION_LABELS[project.nextAction] : "—"}</Field>
                <Field label="Contactos">
                  <ContactLinks project={project} />
                </Field>
              </div>
            </>
          )}
          <ProjectSummary project={project} />
          {(links.length > 0 || project.clientSlug || project.leadId) && <div className="flex flex-wrap gap-4 border-t border-border pt-3 text-sm">
            {links.map(([label, href]) => (
              <a key={label} className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline" href={href} target="_blank" rel="noreferrer">
                {label} <ExternalLink className="size-3.5" />
              </a>
            ))}
            {project.leadId && (session?.role === "boss" || session?.role === "commercial") && (
              <Link className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline" to={`/comercial/leads/${project.leadId}`}>
                Lead en Comercial
              </Link>
            )}
            {project.clientSlug && (
              <Link className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline" to={`/projects/${project.clientSlug}`}>
                App en Infraestructura
              </Link>
            )}
          </div>}
        </CardContent>
      </Card>

      <div role="tablist" aria-label="Secciones del proyecto" className="-mx-4 flex gap-1 overflow-x-auto border-b border-foreground/10 px-4 sm:mx-0 sm:px-0">
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
                "-mb-px shrink-0 border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors",
                tab === t.id ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
      </div>

      <div role="tabpanel">
        {tab === "deals" && <DealsTab projectId={project.id} />}
        {tab === "tasks" && <TasksTab projectId={project.id} teamId={project.team.id} canWork={permissions.work} canManage={permissions.manage} currentUserId={session?.id ?? ""} />}
        {tab === "accounts" && permissions.work && <AccountsTab projectId={project.id} canManage={permissions.manage} />}
        {tab === "proposals" && <ProposalsTab projectId={project.id} canManage={permissions.manage} />}
        {tab === "meetings" && <MeetingsTab projectId={project.id} canWork={permissions.work} />}
        {tab === "updates" && <UpdatesTab projectId={project.id} canWork={permissions.work} />}
      </div>
    </div>
  );
}
