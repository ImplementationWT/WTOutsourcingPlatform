import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useTeams } from "@/features/admin/api";
import { selectClass } from "@/features/admin/TeamAssignCard";
import { useSession } from "@/features/auth/auth";
import { cn } from "@/lib/utils";
import {
  createProject,
  HEALTH,
  HEALTH_LABELS,
  hoursText,
  money,
  opsKeys,
  PRIORITIES,
  PRIORITY_LABELS,
  STAGE_LABELS,
  STAGES,
  useOpsProjects,
  useTeamMembers,
  type Health,
  type Priority,
  type ProjectFilters,
  type Stage,
} from "./api";
import { HealthBadge, PriorityBadge, SentimentBar, StageBadge } from "./OpsBadges";

function NewProjectForm({ onClose }: { onClose: () => void }) {
  const session = useSession().data;
  const isBoss = session?.role === "boss";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const teams = useTeams().data ?? [];
  const [name, setName] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [teamId, setTeamId] = useState("");
  const [leadId, setLeadId] = useState("");
  const [developerId, setDeveloperId] = useState("");
  const [proposalUrl, setProposalUrl] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveTeam = isBoss ? teamId : (session?.teamId ?? "");
  const members = useTeamMembers(effectiveTeam || null, Boolean(effectiveTeam)).data ?? [];
  const valid = name.trim().length >= 3 && customerName.trim().length >= 2 && Boolean(effectiveTeam);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const { project } = await createProject({
        name: name.trim(),
        customerName: customerName.trim(),
        ...(isBoss ? { teamId } : {}),
        leadUserId: leadId || null,
        developerUserId: developerId || null,
        proposalUrl: proposalUrl.trim() || null,
        priority,
      });
      await queryClient.invalidateQueries({ queryKey: opsKeys.allProjects });
      navigate(`/operativa/${project.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear el proyecto.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Nuevo proyecto</CardTitle>
        <Button size="icon-sm" variant="ghost" aria-label="Cerrar" onClick={onClose}>
          <X />
        </Button>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="op-name">Nombre del proyecto</Label>
              <Input id="op-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Automatización de pedidos" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="op-customer">Cliente</Label>
              <Input id="op-customer" value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Manpersa SAC" />
            </div>
            {isBoss && (
              <div className="space-y-1.5">
                <Label htmlFor="op-team">Equipo</Label>
                <select
                  id="op-team"
                  className={cn(selectClass, "w-full")}
                  value={teamId}
                  onChange={(e) => {
                    setTeamId(e.target.value);
                    setLeadId("");
                    setDeveloperId("");
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
            )}
            <div className="space-y-1.5">
              <Label htmlFor="op-priority">Prioridad</Label>
              <select id="op-priority" className={cn(selectClass, "w-full")} value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABELS[p]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="op-lead">Team Leader</Label>
              <select id="op-lead" className={cn(selectClass, "w-full")} value={leadId} disabled={!effectiveTeam} onChange={(e) => setLeadId(e.target.value)}>
                <option value="">{isBoss ? "Sin asignar" : "Yo"}</option>
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
              <Label htmlFor="op-dev">Developer</Label>
              <select id="op-dev" className={cn(selectClass, "w-full")} value={developerId} disabled={!effectiveTeam} onChange={(e) => setDeveloperId(e.target.value)}>
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
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="op-proposal">Propuesta (enlace, opcional)</Label>
              <Input id="op-proposal" value={proposalUrl} onChange={(e) => setProposalUrl(e.target.value)} placeholder="https://…" />
            </div>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={!valid || busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Plus />}
              Crear proyecto
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export default function OpsProjectsPage() {
  const session = useSession().data;
  const [filters, setFilters] = useState<ProjectFilters>({});
  const [creating, setCreating] = useState(false);
  const { data: projects, isLoading, error } = useOpsProjects(filters);
  const canCreate = session?.role === "boss" || session?.role === "lead";
  const set = <K extends keyof ProjectFilters>(key: K, value: string) => setFilters((f) => ({ ...f, [key]: value || undefined }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Proyectos del cliente</h1>
          <p className="mt-1 text-sm text-muted-foreground sm:text-base">Proyectos de los clientes: etapa, salud, deals y tareas.</p>
        </div>
        {canCreate && !creating && (
          <Button onClick={() => setCreating(true)}>
            <Plus />
            Nuevo proyecto
          </Button>
        )}
      </div>

      {creating && <NewProjectForm onClose={() => setCreating(false)} />}

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filtros">
        <select aria-label="Filtrar por etapa" className={selectClass} value={filters.stage ?? ""} onChange={(e) => set("stage", e.target.value)}>
          <option value="">Todas las etapas</option>
          {STAGES.map((s: Stage) => (
            <option key={s} value={s}>
              {STAGE_LABELS[s]}
            </option>
          ))}
        </select>
        <select aria-label="Filtrar por health" className={selectClass} value={filters.health ?? ""} onChange={(e) => set("health", e.target.value)}>
          <option value="">Todo el health</option>
          {HEALTH.map((h: Health) => (
            <option key={h} value={h}>
              {HEALTH_LABELS[h]}
            </option>
          ))}
        </select>
        <select aria-label="Filtrar por prioridad" className={selectClass} value={filters.priority ?? ""} onChange={(e) => set("priority", e.target.value)}>
          <option value="">Todas las prioridades</option>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </select>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error instanceof Error ? error.message : "No se pudieron cargar los proyectos."}
        </p>
      ) : isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : !projects?.length ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {Object.values(filters).some(Boolean) ? "Ningún proyecto coincide con los filtros." : "Aún no hay proyectos operativos."}
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                to={`/operativa/${p.id}`}
                className="grid items-center gap-3 rounded-xl border border-foreground/10 bg-foreground/[0.02] p-4 transition-colors hover:bg-foreground/[0.05] md:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,1.2fr)_minmax(0,1fr)]"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{p.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {p.customerName} · {p.team.name ?? "Sin equipo"}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <StageBadge value={p.stage} />
                  <HealthBadge value={p.health} />
                  <PriorityBadge value={p.priority} />
                </div>
                <SentimentBar value={p.sentimentScore} />
                <div className="text-xs text-muted-foreground md:text-right">
                  <p>
                    {p.summary.deals} deal{p.summary.deals === 1 ? "" : "s"} · {hoursText(p.summary.hours)}
                  </p>
                  <p>
                    {money(p.summary.amountCents)} · {p.summary.tasksDone}/{p.summary.tasks} tareas
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
