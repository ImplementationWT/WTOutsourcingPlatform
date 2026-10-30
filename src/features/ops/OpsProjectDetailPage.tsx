import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { selectClass } from "@/features/admin/TeamAssignCard";
import { useSession } from "@/features/auth/auth";
import { cn } from "@/lib/utils";
import {
  HEALTH,
  HEALTH_LABELS,
  opsKeys,
  PRIORITIES,
  PRIORITY_LABELS,
  STAGE_LABELS,
  STAGES,
  updateProject,
  useOpsProject,
  useTeamMembers,
  type Health,
  type OpsProject,
  type Priority,
  type Stage,
} from "./api";
import { HealthBadge, PriorityBadge, SentimentBar, StageTrack } from "./OpsBadges";
import { AccountsTab, DealsTab, MeetingsTab, TasksTab, UpdatesTab } from "./OpsTabs";

type TabId = "deals" | "tasks" | "accounts" | "meetings" | "updates";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="text-sm">{children}</div>
    </div>
  );
}

/** Controles de etapa, health, prioridad, sentimiento y responsables (solo CEO/CCO y Team Leader del equipo). */
function ProjectControls({ project }: { project: OpsProject }) {
  const queryClient = useQueryClient();
  const members = useTeamMembers(project.team.id).data ?? [];
  const [error, setError] = useState<string | null>(null);
  // Borrador mientras se escribe; sin borrador se muestra el valor guardado.
  const [draft, setDraft] = useState<string | null>(null);
  const sentiment = draft ?? String(project.sentimentScore);

  async function save(patch: Parameters<typeof updateProject>[1]) {
    setError(null);
    try {
      await updateProject(project.id, patch);
      await Promise.all([queryClient.invalidateQueries({ queryKey: opsKeys.project(project.id) }), queryClient.invalidateQueries({ queryKey: opsKeys.allProjects })]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el cambio.");
    } finally {
      setDraft(null);
    }
  }

  const commitSentiment = () => {
    const value = Number(sentiment);
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      setError("El sentiment score es un entero de 0 a 100.");
      setDraft(null);
      return;
    }
    if (value !== project.sentimentScore) void save({ sentimentScore: value });
    else setDraft(null);
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="Etapa">
          <select aria-label="Etapa" className={cn(selectClass, "w-full")} value={project.stage} onChange={(e) => void save({ stage: e.target.value as Stage })}>
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Health">
          <select aria-label="Health" className={cn(selectClass, "w-full")} value={project.health} onChange={(e) => void save({ health: e.target.value as Health })}>
            {HEALTH.map((h) => (
              <option key={h} value={h}>
                {HEALTH_LABELS[h]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Sentiment (0–100)">
          <Input
            aria-label="Sentiment score"
            inputMode="numeric"
            value={sentiment}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitSentiment}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
        </Field>
        <Field label="Prioridad">
          <select aria-label="Prioridad" className={cn(selectClass, "w-full")} value={project.priority} onChange={(e) => void save({ priority: e.target.value as Priority })}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
        </Field>
        <div className="hidden lg:block" />
        <Field label="Team Leader">
          <select aria-label="Team Leader" className={cn(selectClass, "w-full")} value={project.lead?.id ?? ""} onChange={(e) => void save({ leadUserId: e.target.value || null })}>
            <option value="">Sin asignar</option>
            {members
              .filter((m) => m.role === "lead")
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Developer">
          <select aria-label="Developer" className={cn(selectClass, "w-full")} value={project.developer?.id ?? ""} onChange={(e) => void save({ developerUserId: e.target.value || null })}>
            <option value="">Sin asignar</option>
            {members
              .filter((m) => m.role === "developer")
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
          </select>
        </Field>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
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
      <div className="mx-auto max-w-6xl space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="mx-auto max-w-6xl space-y-4">
        <Link to="/operativa" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
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
    // Comercial y Financiera no ven las cuentas: la API tampoco se las da.
    { id: "accounts", label: "Cuentas", visible: permissions.work },
    { id: "meetings", label: "Reuniones", visible: true },
    { id: "updates", label: "Updates", visible: true },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <Link to="/operativa" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Proyectos
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{project.name}</h1>
          <HealthBadge value={project.health} />
          <PriorityBadge value={project.priority} />
        </div>
        <p className="text-sm text-muted-foreground">
          {project.customerName} · {project.team.name ?? "Sin equipo"}
        </p>
      </div>

      <Card>
        <CardContent className="space-y-4 pt-4">
          <StageTrack stage={project.stage} />
          {permissions.manage ? (
            <ProjectControls project={project} />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Sentiment">
                <SentimentBar value={project.sentimentScore} />
              </Field>
              <Field label="Team Leader">{project.lead?.name ?? "Sin asignar"}</Field>
              <Field label="Developer">{project.developer?.name ?? "Sin asignar"}</Field>
            </div>
          )}
          <div className="flex flex-wrap gap-4 text-sm">
            {project.proposalUrl && (
              <a className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline" href={project.proposalUrl} target="_blank" rel="noreferrer">
                Propuesta <ExternalLink className="size-3.5" />
              </a>
            )}
            {project.clientSlug && (
              <Link className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline" to={`/projects/${project.clientSlug}`}>
                App en Infraestructura
              </Link>
            )}
          </div>
        </CardContent>
      </Card>

      <div role="tablist" aria-label="Secciones del proyecto" className="flex flex-wrap gap-1 border-b border-foreground/10">
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
                "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
                tab === t.id ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
      </div>

      <div role="tabpanel">
        {tab === "deals" && <DealsTab projectId={project.id} canManage={permissions.manage} />}
        {tab === "tasks" && <TasksTab projectId={project.id} teamId={project.team.id} canWork={permissions.work} canManage={permissions.manage} currentUserId={session?.id ?? ""} />}
        {tab === "accounts" && permissions.work && <AccountsTab projectId={project.id} canManage={permissions.manage} />}
        {tab === "meetings" && <MeetingsTab projectId={project.id} canWork={permissions.work} />}
        {tab === "updates" && <UpdatesTab projectId={project.id} canWork={permissions.work} />}
      </div>
    </div>
  );
}
