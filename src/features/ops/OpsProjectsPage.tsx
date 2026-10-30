import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, X } from "lucide-react";
import { DataTable, type Column } from "@/components/data-table/DataTable";
import { InlineSelect, RelationCell, TotalCell } from "@/components/data-table/cells";
import { useTableState } from "@/components/data-table/table-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTeams } from "@/features/admin/api";
import { selectClass } from "@/features/admin/TeamAssignCard";
import { useSession } from "@/features/auth/auth";
import { useCompanyOptions } from "@/features/core/api";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  createProject,
  HEALTH,
  HEALTH_LABELS,
  NEXT_ACTION_LABELS,
  opsKeys,
  PRIORITIES,
  PRIORITY_LABELS,
  PROJECT_FILTERS,
  STAGE_LABELS,
  STAGES,
  updateProject,
  useOpsProjects,
  useTeamMembers,
  type OpsProjectRow,
  type Priority,
  type ProjectInput,
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
  // El CEO/CCO elige la empresa cliente; quien no ve Empresas escribe el nombre del cliente.
  const companies = useCompanyOptions(isBoss).data ?? [];
  const [companyId, setCompanyId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [leadId, setLeadId] = useState("");
  const [developerId, setDeveloperId] = useState("");
  const [proposalUrl, setProposalUrl] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveTeam = isBoss ? teamId : (session?.teamId ?? "");
  const members = useTeamMembers(effectiveTeam || null, Boolean(effectiveTeam)).data ?? [];
  const valid = name.trim().length >= 3 && (Boolean(companyId) || customerName.trim().length >= 2) && Boolean(effectiveTeam);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const { project } = await createProject({
        name: name.trim(),
        ...(companyId ? { companyId } : { customerName: customerName.trim() }),
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
            {isBoss && (
              <div className="space-y-1.5">
                <Label htmlFor="op-company">Empresa cliente</Label>
                <select id="op-company" className={cn(selectClass, "w-full")} value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
                  <option value="">Otra (escribir el nombre)</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {!companyId && (
              <div className="space-y-1.5">
                <Label htmlFor="op-customer">Cliente</Label>
                <Input id="op-customer" value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Manpersa SAC" />
              </div>
            )}
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
  const queryClient = useQueryClient();
  const table = useTableState({ filterKeys: PROJECT_FILTERS });
  const { data, isLoading, isFetching, error } = useOpsProjects(table.query);
  const [creating, setCreating] = useState(false);
  const seesCompanies = session?.role === "boss" || session?.role === "commercial" || session?.role === "finance";
  const save = async (p: OpsProjectRow, patch: Partial<ProjectInput>) => {
    await updateProject(p.id, patch);
    await Promise.all([queryClient.invalidateQueries({ queryKey: opsKeys.allProjects }), queryClient.invalidateQueries({ queryKey: opsKeys.project(p.id) })]);
  };
  const totals = data?.totals ?? {};

  const columns: Column<OpsProjectRow>[] = [
    {
      id: "name",
      header: "Proyecto",
      sortKey: "name",
      card: "title",
      cell: (p) => (
        <span className="flex min-w-0 flex-col">
          <span className="font-medium">{p.name}</span>
          <span className="text-xs text-muted-foreground">
            {p.company && seesCompanies ? <RelationCell to={`/comercial/empresas/${p.company.id}`}>{p.customerName}</RelationCell> : p.customerName} · {p.team.name ?? "Sin equipo"}
          </span>
        </span>
      ),
    },
    {
      id: "stage",
      header: "Etapa",
      sortKey: "stage",
      cell: (p) => <InlineSelect label={`Etapa de ${p.name}`} value={p.stage} options={STAGES} labels={STAGE_LABELS} disabled={!p.canManage} display={<StageBadge value={p.stage} />} onSave={(v) => save(p, { stage: v ?? p.stage })} />,
    },
    {
      id: "health",
      header: "Health",
      sortKey: "health",
      cell: (p) => <InlineSelect label={`Health de ${p.name}`} value={p.health} options={HEALTH} labels={HEALTH_LABELS} disabled={!p.canManage} display={<HealthBadge value={p.health} />} onSave={(v) => save(p, { health: v ?? p.health })} />,
    },
    { id: "sentiment", header: "Sentiment", cell: (p) => <SentimentBar value={p.sentimentScore} /> },
    {
      id: "priority",
      header: "Prioridad",
      sortKey: "priority",
      cell: (p) => (
        <InlineSelect label={`Prioridad de ${p.name}`} value={p.priority} options={PRIORITIES} labels={PRIORITY_LABELS} disabled={!p.canManage} display={<PriorityBadge value={p.priority} />} onSave={(v) => save(p, { priority: v ?? p.priority })} />
      ),
    },
    { id: "soldHours", header: "Horas vendidas", align: "right", footer: <TotalCell hours={totals.soldHours ?? 0} strong />, cell: (p) => <TotalCell hours={p.summary.soldHours} /> },
    { id: "billableHours", header: "Horas facturables", align: "right", footer: <TotalCell hours={totals.billableHours ?? 0} strong />, cell: (p) => <TotalCell hours={p.summary.billableHours} /> },
    { id: "billableVsSold", header: "Facturable vs deals", align: "right", cell: (p) => <TotalCell hours={p.summary.billableVsSold} /> },
    { id: "progress", header: "Avance", align: "right", cell: (p) => <span title={`${p.summary.tasksDone}/${p.summary.tasks} tareas`}>{p.summary.progress}%</span> },
    { id: "amount", header: "Valor vendido", align: "right", footer: <TotalCell cents={totals.amountCents ?? 0} strong />, cell: (p) => <TotalCell cents={p.summary.amountCents} /> },
    { id: "kickoff", header: "Kickoff", sortKey: "kickoffDate", card: false, cell: (p) => (p.kickoffDate ? formatDate(p.kickoffDate) : <span className="text-muted-foreground">—</span>) },
    { id: "nextAction", header: "Siguiente acción", card: false, cell: (p) => (p.nextAction ? NEXT_ACTION_LABELS[p.nextAction] : <span className="text-muted-foreground">—</span>) },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Proyectos del cliente</h1>
        <p className="mt-1 text-sm text-muted-foreground sm:text-base">Etapa, health, horas vendidas y facturables, y avance de cada proyecto.</p>
      </div>

      {creating && <NewProjectForm onClose={() => setCreating(false)} />}

      <DataTable
        label="Proyectos"
        columns={columns}
        table={table}
        data={data}
        isLoading={isLoading}
        isFetching={isFetching}
        error={error}
        rowKey={(p) => p.id}
        rowHref={(p) => `/operativa/${p.id}`}
        empty="Aún no hay proyectos operativos."
        searchPlaceholder="Buscar por proyecto o cliente"
        filters={[
          { key: "stage", label: "Filtrar por etapa", all: "Todas las etapas", options: STAGES.map((s) => ({ value: s, label: STAGE_LABELS[s] })) },
          { key: "health", label: "Filtrar por health", all: "Todo el health", options: HEALTH.map((h) => ({ value: h, label: HEALTH_LABELS[h] })) },
          { key: "priority", label: "Filtrar por prioridad", all: "Todas las prioridades", options: PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] })) },
        ]}
        grouping={{ label: "Agrupar por etapa", value: (p) => p.stage, order: STAGES, labels: STAGE_LABELS }}
        actions={
          data?.canCreate && !creating ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus />
              Nuevo proyecto
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}
