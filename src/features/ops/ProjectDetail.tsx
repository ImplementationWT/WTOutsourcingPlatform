import { useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, ExternalLink, Plus } from "lucide-react";
import { ChartCard, ColumnChart, LineChart } from "@/components/charts/charts";
import { useCrumbs } from "@/components/layout/crumbs";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { DetailModal, ProtoCard } from "@/components/ui/detail-modal";
import { Kpi, KpiRow } from "@/components/ui/kpi";
import { AvatarStack, PersonAvatar } from "@/components/ui/person-avatar";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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
  HEALTH_CHIP,
  HEALTH_LABELS,
  stageStyle,
  MAX_DEVELOPERS,
  STAGE_LABELS,
  STAGES,
  daysBetween,
  moneyShort,
  stageAge,
  todayIso,
  useStageSla,
  opsKeys,
  PAYMENT_TYPE_LABELS,
  PAYMENT_TYPES,
  PRIORITIES,
  PRIORITY_LABELS,
  updateProject,
  useClientOptions,
  useOpsProject,
  useTeamMembers,
  accountsQuery,
  type OpsProject,
  type StageSla,
} from "./api";
import { useProjectDeals } from "@/features/core/api";
import { HealthBadge, PriorityBadge, StageBadge, StageStepper } from "./OpsBadges";
import { AccountsTab, MeetingsTab, ProposalsTab, UpdatesTab } from "./OpsTabs";
import { ProjectDeals } from "./ProjectDeals";
import { MeetingsBoard } from "@/features/activity/MeetingsBoard";
import { useComms } from "@/features/communications/api";
import { apiFetch } from "@/lib/api-client";
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

  const grid = "grid gap-x-4 gap-y-4 sm:grid-cols-2 xl:grid-cols-3";
  const fieldBox = "flex h-11 w-full min-w-0 items-center rounded-[10px] border border-border bg-muted px-3 text-sm";
  const primary = project.contacts[0] ?? null;
  const contactOptions = [...clients.map((c) => ({ value: c.id, label: c.name, description: c.company ?? undefined })), ...project.contacts.filter((c) => !clients.some((x) => x.id === c.id)).map((c) => ({ value: c.id, label: c.name ?? "—" }))];
  const devOptions = [...members.filter((m) => m.role === "developer").map((m) => ({ id: m.id, name: m.name })), ...project.developers.filter((d) => !members.some((m) => m.id === d.id)).map((d) => ({ id: d.id, name: d.name ?? "—" }))];
  const devIds = project.developers.map((d) => d.id);
  const toggleDev = (id: string) => {
    const next = devIds.includes(id) ? devIds.filter((x) => x !== id) : [...devIds, id];
    if (next.length > MAX_DEVELOPERS) return toast.error(`Máximo ${MAX_DEVELOPERS} developers por proyecto.`);
    void save({ developerUserIds: next });
  };
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <ProtoCard title="Información del proyecto">
        <div className={grid}>
          <Field label="Priority">{select("Prioridad", project.priority, PRIORITIES, PRIORITY_LABELS, (v) => v && void save({ priority: v }))}</Field>
          <Field label="Etapa">
            <select aria-label="Etapa" value={project.stage} disabled={!canManage} onChange={(e) => void save({ stage: e.target.value as OpsProject["stage"] })} className="native-caret h-11 w-full cursor-pointer rounded-[10px] border-0 pl-3 text-sm font-semibold outline-none disabled:cursor-default" style={stageStyle(project.stage)}>
              {STAGES.map((st) => (
                <option key={st} value={st} className="bg-card text-foreground">
                  {STAGE_LABELS[st]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Sentiment">
            <select aria-label="Health" value={project.health} disabled={!canManage} onChange={(e) => void save({ health: e.target.value as OpsProject["health"] })} className={cn("native-caret h-11 w-full cursor-pointer rounded-[10px] border-0 pl-3 text-sm font-semibold outline-none disabled:cursor-default", `chip-${HEALTH_CHIP[project.health]}`)}>
              {HEALTH.map((h) => (
                <option key={h} value={h} className="bg-card text-foreground">
                  {HEALTH_LABELS[h]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Contacto">
            {picksClient ? (
              <Select
                label="Contactos"
                value={primary?.id ?? null}
                placeholder="Elige el contacto"
                searchable
                options={contactOptions.map((o) => ({ ...o, icon: <PersonAvatar person={{ id: o.value, name: o.label }} size={20} /> }))}
                onValueChange={(v) => v && v !== primary?.id && void save({ contactIds: [v, ...project.contacts.map((c) => c.id).filter((id) => id !== v)] })}
              />
            ) : (
              <ClientValue project={project} />
            )}
          </Field>
          <Field label="Account">
            <p className={fieldBox} title="La empresa del contacto del proyecto">
              <span className="truncate">{project.client?.company ?? "—"}</span>
            </p>
          </Field>
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
            <p className="flex h-11 items-center rounded-[10px] chip-purple px-3 font-semibold">{project.team.name ?? "Sin equipo"}</p>
          </Field>
          <Field label="Lead">
            {canManage ? (
              <Select label="Team Leader" value={project.lead?.id ?? null} placeholder={project.lead?.name ?? "Elige el Team Leader"} options={members.filter((m) => m.role === "lead").map((m) => ({ value: m.id, label: m.name, icon: <PersonAvatar person={{ id: m.id, name: m.name }} size={22} /> }))} onValueChange={(v) => v && void save({ leadUserId: v })} />
            ) : (
              <p className={cn(fieldBox, "gap-2 font-semibold")}>
                {project.lead && <PersonAvatar person={project.lead} size={22} />}
                {project.lead?.name ?? "Sin asignar"}
              </p>
            )}
          </Field>
          <Field label={`Developers (máx. ${MAX_DEVELOPERS})`}>
            {canManage ? (
              <DropdownMenu>
                <DropdownMenuTrigger aria-label="Developers" className={cn(fieldBox, "gap-2 text-left hover:border-line-strong")}>
                  <AvatarStack people={project.developers} size={22} empty="" />
                  <span className="min-w-0 flex-1 truncate font-semibold">{project.developers.map((d) => d.name).join(", ") || <span className="font-normal text-muted-foreground">Elegir developers</span>}</span>
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={6} className="w-60">
                  {devOptions.map((d) => (
                    <DropdownMenuCheckboxItem key={d.id} checked={devIds.includes(d.id)} closeOnClick={false} onCheckedChange={() => toggleDev(d.id)}>
                      <PersonAvatar person={d} size={20} /> {d.name}
                    </DropdownMenuCheckboxItem>
                  ))}
                  {!devOptions.length && <p className="px-2 py-1.5 text-sm text-muted-foreground">El equipo no tiene developers.</p>}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <p className={cn(fieldBox, "gap-2")}>
                <AvatarStack people={project.developers} size={22} empty="Sin asignar" />
                <span className="truncate font-semibold">{project.developers.map((d) => d.name).join(", ")}</span>
              </p>
            )}
          </Field>
          <Field label="Kickoff date">
            {canManage ? <DatePicker label="Kickoff" placeholder="dd/mm/aaaa" value={project.kickoffDate} onValueChange={(v) => void save({ kickoffDate: v })} /> : <Value>{project.kickoffDate ? formatDate(project.kickoffDate) : "—"}</Value>}
          </Field>
          <Field label="Tipo de pago">
            {canManage ? <Select label="Tipo de pago" value={project.paymentType} placeholder="Seleccionar" options={PAYMENT_TYPES.map((t) => ({ value: t, label: PAYMENT_TYPE_LABELS[t] }))} onValueChange={(v) => v && void save({ paymentType: v as OpsProject["paymentType"] })} /> : <Value>{project.paymentType ? PAYMENT_TYPE_LABELS[project.paymentType] : "—"}</Value>}
          </Field>
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

/** Hourly Rate editable (CEO/CCO y Team Leader): se escribe en dólares y es la tarifa de los deals nuevos. */
function RateKpi({ projectId, cents }: { projectId: string; cents: number | null }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const save = async () => {
    if (draft === null) return;
    const value = draft.trim() === "" ? null : Math.round(Number(draft) * 100);
    setDraft(null);
    if (value !== null && (!Number.isFinite(value) || value < 0)) return toast.error("Escribe una tarifa válida.");
    if (value === cents) return;
    try {
      await updateProject(projectId, { hourlyRateCents: value });
      await Promise.all([queryClient.invalidateQueries({ queryKey: opsKeys.project(projectId) }), queryClient.invalidateQueries({ queryKey: opsKeys.allProjects })]);
      toast.success(value === null ? "Hourly rate: se calcula de los deals" : `Hourly rate: ${moneyShort(value)} / h`, { description: "Los deals nuevos usan esta tarifa." });
    } catch (err) {
      toast.error("No se pudo guardar la tarifa.", { description: errorText(err, "Inténtalo de nuevo.") });
    }
  };
  return (
    <div className="flex min-w-0 flex-col justify-between gap-3.5 rounded-[14px] border border-border bg-card p-4 transition-colors hover:border-line-strong sm:p-[18px]">
      <label htmlFor="hourly-rate" className="text-caps-label leading-snug">
        Hourly rate
      </label>
      <p className="flex items-baseline gap-1 text-xl font-bold tracking-tight tabular-nums sm:text-[28px] sm:leading-tight">
        <span>$</span>
        <input
          id="hourly-rate"
          inputMode="decimal"
          value={draft ?? (cents === null ? "" : String(cents / 100))}
          placeholder="—"
          onChange={(e) => setDraft(e.target.value.replace(/[^\d.]/g, ""))}
          onBlur={() => void save()}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className="w-full min-w-0 rounded-md bg-transparent outline-none hover:bg-muted focus:bg-muted"
          style={{ width: `${Math.max(2, (draft ?? String((cents ?? 0) / 100)).length + 1)}ch` }}
        />
        <span className="text-sm font-medium tracking-normal text-muted-foreground">/h</span>
      </p>
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
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[36rem] text-sm">
        <caption className="sr-only">Historial de etapas</caption>
        <thead>
          <tr className="text-left">
            {["Etapa", "Entró", "Días", "Esperado", "Estado"].map((h) => (
              <th key={h} scope="col" className="text-caps-label border-b border-border px-4 py-3 font-semibold">
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
                <td className="px-4 py-3">
                  <span className="inline-flex items-center gap-1.5">
                    <StageBadge value={h.stage} />
                    {current && <span className="text-xs font-semibold">· actual</span>}
                  </span>
                </td>
                <td className="px-4 py-3 whitespace-nowrap tabular-nums">
                  {h.at.slice(0, 10)}
                  {"estimated" in h && h.estimated ? <span className="ml-1 text-xs text-muted-foreground">(estimado)</span> : null}
                </td>
                <td className="px-4 py-3 tabular-nums">{days} d</td>
                <td className="px-4 py-3 tabular-nums">{limit === null ? "—" : `${limit} d`}</td>
                <td className="px-4 py-3">
                  <Chip color={tone === "danger" ? "red" : tone === "warn" ? "amber" : tone === "ok" ? "green" : "gray"}>{status}</Chip>
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
  // Contadores de las pestañas conectadas: Meetings, Comunicaciones y Cuentas del proyecto.
  const meetings = useQuery({ queryKey: ["meetings", "for-lead"], queryFn: () => apiFetch<{ rows: { project: { id: string } | null }[] }>("/api/meetings?page=1&pageSize=100") });
  const comms = useComms({ projectId: id });
  const accounts = useQuery({ ...accountsQuery(id, Boolean(data?.permissions.work)) });
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
    { id: "meetings", label: "Reuniones", visible: true, count: meetings.data?.rows?.filter((m) => m.project?.id === project.id).length },
    { id: "comms", label: "Comunicaciones", visible: true, count: comms.data?.communications?.length },
    // Comercial y Financiera no ven las cuentas: la API tampoco se las da.
    { id: "accounts", label: "Cuentas", visible: permissions.work, count: accounts.data?.length },
    { id: "stages", label: "Etapas", visible: true, count: Math.max(1, project.stageHistory.length) },
    { id: "proposals", label: "Propuestas", visible: true },
    { id: "updates", label: "Updates", visible: true },
  ];
  const showLead = Boolean(project.leadId) && (session?.role === "boss" || session?.role === "commercial");
  const step = STAGES.indexOf(project.stage) + 1;
  // Hourly Rate: el del proyecto si se fijó; si no, el promedio de sus deals.
  const rate = project.hourlyRateCents ?? (s.soldHours ? Math.round(s.amountCents / s.soldHours) : null);
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
          {permissions.manage ? <RateKpi projectId={project.id} cents={rate} /> : <Kpi label="Hourly rate" value={rate === null ? "—" : moneyShort(rate)} unit={rate === null ? undefined : "/h"} />}
          <Kpi label="Total closed deals" value={moneyShort(s.amountCents)} />
          <Kpi label="Total hours approved" value={s.soldHours.toLocaleString("en-US")} unit="h" />
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
            {tab === "deals" && <ProjectDeals key={newDeal} projectId={project.id} teamId={project.team.id} startCreating={newDeal > 0} hideCreate={permissions.manage} />}
            {tab === "tasks" && <ProjectTasksPanel projectId={project.id} />}
            {tab === "accounts" && permissions.work && <AccountsTab projectId={project.id} canManage={permissions.manage} />}
            {tab === "proposals" && <ProposalsTab projectId={project.id} canManage={permissions.manage} />}
            {tab === "meetings" && (
              <div className="space-y-6">
                <MeetingsBoard target={{ kind: "project", id: project.id, name: project.name }} canWrite={permissions.manage} />
                {/* El procesamiento con Claude (action items → tareas o change orders) sigue aquí. */}
                <details className="rounded-xl border border-border">
                  <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Action items de las reuniones (Claude)</summary>
                  <div className="border-t border-border p-4">
                    <MeetingsTab projectId={project.id} canWork={permissions.work} />
                  </div>
                </details>
              </div>
            )}
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
