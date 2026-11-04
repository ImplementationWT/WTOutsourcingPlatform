import { useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, Plus } from "lucide-react";
import { ChartCard, ColumnChart, LineChart } from "@/components/charts/charts";
import { useCrumbs } from "@/components/layout/crumbs";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { DetailModal, ProtoCard } from "@/components/ui/detail-modal";
import { Kpi, KpiRow } from "@/components/ui/kpi";
import { AvatarStack } from "@/components/ui/person-avatar";
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
  STAGES,
  daysBetween,
  moneyShort,
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
import { useProjectDeals } from "@/features/core/api";
import { HealthBadge, PriorityBadge, SentimentBar, StageBadge, StageStepper } from "./OpsBadges";
import { AccountsTab, DealsTab, MeetingsTab, ProposalsTab, UpdatesTab } from "./OpsTabs";
import { ProjectTasksPanel } from "@/features/tasks/TasksPage";
import { CommsTab } from "@/features/communications/CommsList";

type TabId = "deals" | "tasks" | "proposals" | "accounts" | "meetings" | "comms" | "updates" | "stages";
const TAB_IDS: readonly TabId[] = ["deals", "tasks", "proposals", "accounts", "meetings", "comms", "updates", "stages"];

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
function ProjectData({ project, canManage, onDeals }: { project: OpsProject; canManage: boolean; onDeals: () => void }) {
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

  const grid = "grid gap-x-4 gap-y-4 sm:grid-cols-2 xl:grid-cols-3";
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <ProtoCard title="Información del proyecto">
        <div className={grid}>
          <Field label="Priority">{select("Prioridad", project.priority, PRIORITIES, PRIORITY_LABELS, (v) => v && void save({ priority: v }))}</Field>
          <Field label="Etapa">{select("Etapa", project.stage, STAGES, STAGE_LABELS, (v) => v && void save({ stage: v }))}</Field>
          <Field label="Health">{select("Health", project.health, HEALTH, HEALTH_LABELS, (v) => v && void save({ health: v }))}</Field>
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
          <Field label="Account">
            <Value>{project.client?.company ?? "—"}</Value>
          </Field>
          <Field label="Sentiment (del Health)">
            <div className="flex min-h-control items-center">
              <SentimentBar value={project.sentimentScore} />
            </div>
          </Field>
          <Field label="Siguiente acción">{select("Siguiente acción", project.nextAction, NEXT_ACTIONS, NEXT_ACTION_LABELS, (v) => void save({ nextAction: v }), "Sin definir")}</Field>
          <Field label="SOW">
            {canManage ? (
              <UrlInput label="SOW" value={project.sowUrl} onSave={(v) => void save({ sowUrl: v })} />
            ) : project.sowUrl ? (
              <Value>
                <a className="inline-flex items-center gap-1 text-accent-text underline-offset-4 hover:underline" href={project.sowUrl} target="_blank" rel="noreferrer">
                  Abrir SOW <ExternalLink className="size-3.5" />
                </a>
              </Value>
            ) : (
              <Value>—</Value>
            )}
          </Field>
        </div>
      </ProtoCard>
      <ProtoCard title="Equipo y pagos">
        <div className={grid}>
          <Field label="Team">
            <p className="flex h-control items-center rounded-[10px] chip-amber px-3 font-semibold">{project.team.name ?? "Sin equipo"}</p>
          </Field>
          <Field label="Lead">{person("Team Leader", project.lead, "lead", "leadUserId")}</Field>
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
              <div className="flex min-h-control items-center gap-2">
                <AvatarStack people={project.developers} size={28} empty="Sin asignar" />
                <span className="truncate font-medium">{project.developers.map((d) => d.name).join(", ")}</span>
              </div>
            )}
          </Field>
          <Field label="Kickoff date">
            {canManage ? <DatePicker label="Kickoff" value={project.kickoffDate} onValueChange={(v) => void save({ kickoffDate: v })} /> : <Value>{project.kickoffDate ? formatDate(project.kickoffDate) : "—"}</Value>}
          </Field>
          <Field label="Tipo de pago">{select("Tipo de pago", project.paymentType, PAYMENT_TYPES, PAYMENT_TYPE_LABELS, (v) => void save({ paymentType: v }), "Sin definir")}</Field>
          {canManage && (
            <Field label="Deals">
              <Button size="lg" className="w-full" onClick={onDeals}>
                <Plus /> Nuevo deal
              </Button>
            </Field>
          )}
        </div>
      </ProtoCard>
    </div>
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
    <div className={cn("flex flex-wrap items-center gap-3 rounded-[14px] border bg-card px-5 py-4", age.tone === "danger" ? "border-[var(--chip-red-fg)]" : age.tone === "warn" ? "border-[var(--chip-amber-fg)]" : age.tone === "ok" ? "border-[var(--chip-green-fg)]" : "border-border")} aria-label="Tiempo en etapa">
      {age.tone === "danger" && <AlertTriangle className="size-4 text-[var(--chip-red-fg)]" aria-hidden />}
      <Chip color={age.tone === "danger" ? "red" : age.tone === "warn" ? "amber" : age.tone === "ok" ? "green" : "gray"}>{limit === null ? `${age.days} d` : age.text}</Chip>
      <div className="min-w-52 flex-1 text-sm">
        <p className="font-semibold">{title}</p>
        <p className="text-muted-foreground">
          Desde {formatDate(project.stageSince)}
          {estimated ? " (estimado)" : ""} · {age.days} días{limit !== null ? ` de ${limit} esperados` : ""}
          {age.over > 0 ? `, +${age.over} de atraso. Revisa el bloqueo para que los developers tengan trabajo.` : "."}
        </p>
      </div>
      <Button variant="outline" onClick={onHistory}>
        Ver histórico
      </Button>
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

const SOLD = new Set(["approved", "in_progress", "delivered", "invoiced", "paid"]);
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** Ventas del cliente por mes (deals aprobados en adelante, por fecha de cierre): mensual y acumulado. */
function SalesCharts({ projectId }: { projectId: string }) {
  const { data: deals } = useProjectDeals(projectId);
  const sold = (deals ?? []).filter((d) => SOLD.has(d.status));
  if (!sold.length) return null;
  const month = (d: (typeof sold)[number]) => (d.actualCloseDate ?? d.updatedAt).slice(0, 7);
  const keys = sold.map(month).sort();
  // De la primera venta al mes actual (o a la última venta, si es posterior), máximo 3 años.
  const end = [keys.at(-1)!, todayIso().slice(0, 7)].sort().at(-1)!;
  const months: string[] = [];
  for (let [y, m] = keys[0].split("-").map(Number); months.length < 37; m++) {
    if (m > 12) [y, m] = [y + 1, 1];
    const k = `${y}-${String(m).padStart(2, "0")}`;
    months.push(k);
    if (k >= end) break;
  }
  const label = (k: string) => `${MONTHS[Number(k.slice(5)) - 1]} ${k.slice(2, 4)}`;
  const byMonth = months.map((k) => sold.filter((d) => month(d) === k).reduce((n, d) => n + d.amountCents, 0) / 100);
  let run = 0;
  const cumulative = byMonth.map((v) => (run += v));
  const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
  const every = Math.max(1, Math.ceil(months.length / 8));
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <ChartCard title="Client Cumulative Sales by Month" sub="Deals aprobados en adelante, por mes de cierre" table={{ columns: ["Mes", "Acumulado"], rows: months.map((k, i) => [label(k), usd(cumulative[i])]) }} className="rounded-[14px] shadow-none">
        <LineChart points={months.map((k, i) => ({ label: label(k), value: cumulative[i] }))} color="var(--viz-4)" format={usd} labelEvery={every} />
      </ChartCard>
      <ChartCard title="Client Monthly Sales" sub="Valor de los deals cerrados en cada mes" table={{ columns: ["Mes", "Ventas"], rows: months.map((k, i) => [label(k), usd(byMonth[i])]) }} className="rounded-[14px] shadow-none">
        <ColumnChart columns={months.map((k, i) => ({ label: label(k), values: { won: byMonth[i] } }))} series={[{ key: "won", label: "Ventas", color: "var(--viz-4)" }]} format={usd} />
      </ChartCard>
    </div>
  );
}

/**
 * Detalle del proyecto en una ventana grande (prototipo): etapas como pasos, tiempo en la etapa,
 * indicadores, «Información del proyecto» y «Equipo y pagos», pestañas y las ventas del cliente.
 * CEO/CCO y Team Leader del equipo editan; el resto lee.
 */
export function ProjectDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const session = useSession().data;
  const { data, isLoading, error } = useOpsProject(id);
  useCrumbs([data && { label: data.project.name }]);
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const asked = params.get("tab") as TabId | null;
  const [tab, setTab] = useState<TabId>(asked && TAB_IDS.includes(asked) ? asked : "deals");
  // «+ Nuevo deal» abre la pestaña Deals con el formulario a la vista (la clave lo vuelve a montar).
  const [newDeal, setNewDeal] = useState(0);
  const sla = useStageSla().data?.days;
  const tabsRef = useRef<HTMLElement>(null);
  const openTab = (t: TabId) => {
    setTab(t);
    tabsRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };
  const updateStage = async (stage: OpsProject["stage"]) => {
    try {
      await updateProject(id, { stage });
      await Promise.all([queryClient.invalidateQueries({ queryKey: opsKeys.project(id) }), queryClient.invalidateQueries({ queryKey: opsKeys.allProjects })]);
    } catch (err) {
      toast.error("No se pudo cambiar la etapa.", { description: errorText(err, "Inténtalo de nuevo.") });
    }
  };

  if (isLoading || error || !data) {
    return (
      <DetailModal title={isLoading ? "Cargando…" : "Proyecto"} onClose={onClose}>
        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-32 w-full rounded-2xl" />
            <Skeleton className="h-64 w-full rounded-2xl" />
          </div>
        ) : (
          <p role="alert" className="text-sm text-destructive">
            {error instanceof Error ? error.message : "Proyecto no encontrado."}
          </p>
        )}
      </DetailModal>
    );
  }

  const { project, permissions } = data;
  const s = project.summary;
  const tabs: { id: TabId; label: string; visible: boolean; count?: number }[] = [
    { id: "deals", label: "Deals", visible: true, count: s.deals },
    { id: "tasks", label: "Tasks", visible: true, count: s.tasks },
    { id: "meetings", label: "Reuniones", visible: true },
    { id: "comms", label: "Comunicaciones", visible: true },
    // Comercial y Financiera no ven las cuentas: la API tampoco se las da.
    { id: "accounts", label: "Cuentas", visible: permissions.work },
    { id: "stages", label: "Etapas", visible: true, count: Math.max(1, project.stageHistory.length) },
    { id: "proposals", label: "Propuestas", visible: true },
    { id: "updates", label: "Updates", visible: true },
  ];
  const showLead = Boolean(project.leadId) && (session?.role === "boss" || session?.role === "commercial");
  const step = STAGES.indexOf(project.stage) + 1;
  const rate = s.soldHours ? Math.round(s.amountCents / s.soldHours) : null;
  const finance = data.finance;
  const link = "inline-flex items-center gap-1 font-semibold text-accent-text underline-offset-4 hover:underline";

  return (
    <DetailModal
      onClose={onClose}
      title={project.name}
      badges={
        <>
          <HealthBadge value={project.health} />
          <PriorityBadge value={project.priority} />
          <StageBadge value={project.stage} />
        </>
      }
      description={
        <span className="flex flex-wrap gap-x-5 gap-y-1">
          {project.client?.name && <span>{project.client.name}</span>}
          {project.client?.company && <span>{project.client.company}</span>}
          {!project.client && <span>{project.customerName}</span>}
          <span>{[project.team.name ?? "Sin equipo", project.lead?.name].filter(Boolean).join(" · ")}</span>
          {showLead && (
            <Link className={link} to={`/comercial/leads/${project.leadId}`}>
              Lead en Comercial
            </Link>
          )}
          {project.clientSlug && (
            <Link className={link} to={`/projects/${project.clientSlug}`}>
              App en Infraestructura
            </Link>
          )}
        </span>
      }
    >
      <div className="proto-form space-y-5">
        <ProtoCard label="Etapa">
          <p className="mb-5 flex items-center gap-4">
            <span className="text-caps-label">Etapa</span>
            <span className="text-sm text-muted-foreground">
              Paso {step} de {STAGES.length}
            </span>
          </p>
          <StageStepper stage={project.stage} onChange={permissions.manage ? (st) => void updateStage(st) : undefined} />
        </ProtoCard>
        <StageAlert project={project} sla={sla} onHistory={() => openTab("stages")} />

        <KpiRow label="Indicadores del proyecto">
          <Kpi label="Hourly rate" value={rate === null ? "—" : moneyShort(rate)} unit={rate === null ? undefined : "/h"} />
          <Kpi label="Total closed deals" value={moneyShort(s.amountCents)} />
          <Kpi label="Total hours approved" value={s.soldHours.toLocaleString("en-US")} unit="h" />
          <Kpi label="Horas facturables" value={s.billableHours.toLocaleString("en-US")} unit="h" />
          {finance && (
            <>
              <Kpi label="Hours paid" value={finance.paidHours.toLocaleString("en-US")} unit="h" />
              <Kpi label="Paid vs deals" value={s.amountCents ? `${Math.min(100, Math.round((finance.paidCents / s.amountCents) * 100))} %` : "—"} />
            </>
          )}
          <Kpi label="Master tasks" value={`${s.progress} %`} sub={`${s.tasksDone}/${s.tasks} tareas`} />
        </KpiRow>

        <ProjectData
          project={project}
          canManage={permissions.manage}
          onDeals={() => {
            setNewDeal((n) => n + 1);
            openTab("deals");
          }}
        />

        <section ref={tabsRef} aria-label="Secciones del proyecto" className="scroll-mt-4 rounded-[14px] border border-border bg-card">
          <div role="tablist" aria-label="Secciones del proyecto" className="flex overflow-x-auto border-b border-border px-5">
            {tabs
              .filter((t) => t.visible)
              .map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  type="button"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  className={cn("-mb-px mr-[18px] inline-flex h-[52px] shrink-0 items-center gap-1.5 border-b-2 px-1 text-sm whitespace-nowrap transition-colors", tab === t.id ? "border-primary font-semibold text-foreground" : "border-transparent font-medium text-muted-foreground hover:text-foreground")}
                >
                  {t.label}
                  {t.count !== undefined && <span className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11.5px] tabular-nums", tab === t.id ? "bg-accent-soft text-accent-text" : "bg-muted text-muted-foreground")}>{t.count}</span>}
                </button>
              ))}
          </div>
          <div role="tabpanel" className="min-h-64 p-5 sm:p-6">
            {tab === "deals" && <DealsTab key={newDeal} projectId={project.id} startCreating={newDeal > 0} />}
            {tab === "tasks" && <ProjectTasksPanel projectId={project.id} />}
            {tab === "accounts" && permissions.work && <AccountsTab projectId={project.id} canManage={permissions.manage} />}
            {tab === "proposals" && <ProposalsTab projectId={project.id} canManage={permissions.manage} />}
            {tab === "meetings" && <MeetingsTab projectId={project.id} canWork={permissions.work} />}
            {tab === "updates" && <UpdatesTab projectId={project.id} canWork={permissions.work} />}
            {tab === "stages" && <StagesTab project={project} sla={sla} />}
            {tab === "comms" && <CommsTab scope={{ projectId: project.id }} defaultContact={project.client?.name ?? ""} />}
          </div>
        </section>

        <SalesCharts projectId={project.id} />
      </div>
    </DetailModal>
  );
}
