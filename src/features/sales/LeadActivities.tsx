import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, CheckCircle2, Clock, Flag, FilePlus2, Monitor, Phone, Plus, RefreshCw, Send, Timer, User, Users, Video, X, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PersonAvatar } from "@/components/ui/person-avatar";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ACTIVITY_KIND_LABELS, commercialKeys, createActivity, durationText, updateActivity, useActivities, type Activity, type ActivityKind } from "@/features/commercial/api";
import { errorText, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { salesKeys, useOwners } from "./api";

/** Los 8 tipos comerciales del prototipo, con su icono. */
const KINDS: { kind: ActivityKind; icon: LucideIcon }[] = [
  { kind: "triage_call", icon: Phone },
  { kind: "create_demo", icon: Monitor },
  { kind: "demo_meeting", icon: Video },
  { kind: "create_proposal", icon: FilePlus2 },
  { kind: "send_proposal", icon: Send },
  { kind: "closing_meeting", icon: Users },
  { kind: "send_onboarding", icon: CheckCircle2 },
  { kind: "follow_up", icon: RefreshCw },
];
const KIND_ICON: Partial<Record<ActivityKind, LucideIcon>> = Object.fromEntries(KINDS.map((k) => [k.kind, k.icon]));

type State = "open" | "closed" | "overdue";
const stateOf = (a: Activity): State => (a.status === "done" ? "closed" : a.overdue ? "overdue" : "open");
const STATE_LABEL: Record<State, string> = { open: "Open", closed: "Closed", overdue: "Overdue" };
const STATE_CHIP: Record<State, string> = { open: "chip-blue", closed: "chip-green", overdue: "chip-red" };
const STATE_DOT: Record<State, string> = { open: "bg-[var(--chip-blue-fg)]", closed: "bg-[var(--chip-green-fg)]", overdue: "bg-[var(--chip-red-fg)]" };

const MONTHS = ["ene.", "feb.", "mar.", "abr.", "may.", "jun.", "jul.", "ago.", "sep.", "oct.", "nov.", "dic."];
const pad = (n: number) => String(n).padStart(2, "0");
/** «4 nov. 2026 · 18:06» (con `short`, sin el año). */
const when = (iso: string, short = false) => {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${short ? "" : ` ${d.getFullYear()}`} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
/** Valor de un <input type="datetime-local"> en la hora local. */
const localValue = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function useRefresh(leadId: string) {
  const queryClient = useQueryClient();
  return () => Promise.all([queryClient.invalidateQueries({ queryKey: commercialKeys.activities }), queryClient.invalidateQueries({ queryKey: salesKeys.lead(leadId) })]);
}

/** «Nueva actividad» (prototipo): tipo con icono, estado Open, responsable e inicio automático. */
function NewActivity({ leadId, me, owners, onClose }: { leadId: string; me: string | undefined; owners: { id: string; name: string }[]; onClose: () => void }) {
  const [kind, setKind] = useState<ActivityKind>("triage_call");
  const [owner, setOwner] = useState<string | null>(me && owners.some((o) => o.id === me) ? me : (owners[0]?.id ?? null));
  const [started] = useState(() => new Date().toISOString());
  const [busy, setBusy] = useState(false);
  const refresh = useRefresh(leadId);
  const create = async () => {
    setBusy(true);
    try {
      await createActivity({ title: ACTIVITY_KIND_LABELS[kind], kind, leadId, ownerUserId: owner, status: "pending", startedAt: started });
      await refresh();
      toast.success(`Actividad creada: ${ACTIVITY_KIND_LABELS[kind]}`);
      onClose();
    } catch (err) {
      toast.error("No se pudo crear la actividad.", { description: errorText(err, "Inténtalo de nuevo.") });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Nueva actividad" className="mb-6 overflow-hidden rounded-[14px] border border-primary bg-card shadow-[0_0_0_3px_var(--accent-soft)]">
      <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h4 className="font-bold">Nueva actividad</h4>
          <p className="text-xs text-muted-foreground">
            Inicio automático: <b className="text-foreground">{when(started)}</b>
          </p>
        </div>
        <button type="button" aria-label="Cerrar" onClick={onClose} className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>
      <div className="space-y-5 px-5 py-5">
        <div>
          <p className="text-caps-label mb-2">Tipo de actividad</p>
          <div role="radiogroup" aria-label="Tipo de actividad" className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
            {KINDS.map(({ kind: k, icon: Icon }) => {
              const on = k === kind;
              return (
                <button key={k} type="button" role="radio" aria-checked={on} onClick={() => setKind(k)} className={cn("flex min-h-12 items-center gap-2.5 rounded-xl border py-1.5 pr-3 pl-2 text-left text-sm transition-colors", on ? "border-primary bg-accent-soft font-semibold text-accent-text shadow-[0_0_0_3px_var(--accent-soft)]" : "border-border bg-card font-medium hover:border-line-strong hover:bg-muted")}>
                  <span aria-hidden className={cn("flex size-8 shrink-0 items-center justify-center rounded-[10px]", on ? "bg-primary text-primary-foreground" : "bg-accent-soft text-accent-text")}>
                    <Icon className="size-4" />
                  </span>
                  {ACTIVITY_KIND_LABELS[k]}
                </button>
              );
            })}
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-caps-label mb-2">Estado</p>
            <div className="flex rounded-[10px] bg-muted p-[3px]" aria-label="Estado: Open (se cierra después)">
              {(["open", "closed", "overdue"] as const).map((st) => (
                <span key={st} className={cn("flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg text-sm", st === "open" ? "bg-card font-semibold shadow-sm" : "text-muted-foreground opacity-60")}>
                  <span aria-hidden className={cn("size-2 rounded-full", STATE_DOT[st])} />
                  {STATE_LABEL[st]}
                </span>
              ))}
            </div>
          </div>
          <div>
            <p className="text-caps-label mb-2">Responsable</p>
            <div className="flex items-center gap-2">
              <span aria-hidden className="flex size-11 shrink-0 items-center justify-center rounded-[10px] bg-accent-soft text-accent-text">
                <User className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <Select label="Responsable" value={owner} emptyLabel="Sin asignar" options={owners.map((o) => ({ value: o.id, label: o.name }))} onValueChange={setOwner} />
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
        <Button variant="outline" size="lg" onClick={onClose}>
          Cancelar
        </Button>
        <Button size="lg" loading={busy} onClick={() => void create()}>
          {!busy && <Check />} Crear actividad
        </Button>
      </div>
    </section>
  );
}

/** Una actividad de la línea de tiempo: estado, responsable, inicio, fin y tiempo invertido. */
function ActivityItem({ a, last, canWrite, owners, leadId }: { a: Activity; last: boolean; canWrite: boolean; owners: { id: string; name: string }[]; leadId: string }) {
  const refresh = useRefresh(leadId);
  const state = stateOf(a);
  const Icon = KIND_ICON[a.kind] ?? Clock;
  const editable = canWrite && a.status !== "done";
  const save = async (patch: Parameters<typeof updateActivity>[1], done?: (fresh: Activity) => void) => {
    try {
      const { activity } = await updateActivity(a.id, patch);
      await refresh();
      done?.(activity);
    } catch (err) {
      toast.error("No se pudo guardar el cambio.", { description: errorText(err, "Inténtalo de nuevo.") });
    }
  };
  const close = () => void save({ status: "done" }, (fresh) => toast.success(`Completada · ${durationText(fresh.investedMinutes ?? 0)} invertidos`));
  const cell = "flex min-w-0 flex-col gap-1 px-4 py-3";
  const label = "flex items-center gap-1.5 text-[10.5px] font-semibold tracking-[0.06em] text-muted-foreground uppercase";
  return (
    <li className="relative grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-4">
      {!last && <span aria-hidden className="absolute top-10 bottom-[-1rem] left-[1.1rem] border-l border-dashed border-line-strong" />}
      <span aria-hidden className={cn("relative z-[1] flex size-9 items-center justify-center rounded-[10px]", STATE_CHIP[state])}>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 pb-6">
        <div className="flex min-h-9 flex-wrap items-center justify-between gap-2">
          <h4 className="font-bold">{ACTIVITY_KIND_LABELS[a.kind]}</h4>
          {editable ? (
            <select aria-label={`Estado de ${ACTIVITY_KIND_LABELS[a.kind]}`} value="pending" onChange={(e) => e.target.value === "done" && close()} className={cn("native-caret h-8 cursor-pointer rounded-full border-0 pl-3.5 text-sm font-semibold outline-none", STATE_CHIP[state])}>
              <option value="pending">{STATE_LABEL[state]}</option>
              <option value="done">Closed</option>
            </select>
          ) : (
            <span className={cn("inline-flex h-8 items-center rounded-full px-3.5 text-sm font-semibold", STATE_CHIP[state])}>{STATE_LABEL[state]}</span>
          )}
        </div>
        <div className="mt-2 grid overflow-hidden rounded-xl border border-border sm:grid-cols-[minmax(9rem,0.8fr)_1fr_1fr]">
          <div className="flex items-center gap-2 border-border px-4 py-3 max-sm:border-b sm:row-span-2 sm:border-r">
            {a.owner && <PersonAvatar person={a.owner} size={22} />}
            {editable ? (
              <select aria-label={`Responsable de ${ACTIVITY_KIND_LABELS[a.kind]}`} value={a.owner?.id ?? ""} onChange={(e) => void save({ ownerUserId: e.target.value || null })} className="native-caret min-w-0 flex-1 cursor-pointer truncate rounded-md bg-transparent py-1 pl-1 text-sm font-semibold outline-none hover:bg-muted">
                <option value="">Sin asignar</option>
                {owners.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            ) : (
              <b className="truncate text-sm">{a.owner?.name ?? "Sin asignar"}</b>
            )}
          </div>
          <div className={cn(cell, "border-b border-border sm:border-r")}>
            <span className={label}>
              <Clock className="size-3.5" aria-hidden /> Inicio
            </span>
            {editable ? (
              <input type="datetime-local" aria-label={`Inicio de ${ACTIVITY_KIND_LABELS[a.kind]}`} max={localValue(new Date().toISOString())} defaultValue={localValue(a.startedAt)} onBlur={(e) => e.target.value && localValue(a.startedAt) !== e.target.value && void save({ startedAt: new Date(e.target.value).toISOString() })} className="-ml-1 rounded-md bg-transparent px-1 text-sm font-bold outline-none hover:bg-muted" />
            ) : (
              <b className="text-sm">{when(a.startedAt)}</b>
            )}
          </div>
          <div className={cn(cell, "border-b border-border")}>
            <span className={label}>
              <Flag className="size-3.5" aria-hidden /> Fin
            </span>
            <b className="text-sm">{a.completedAt ? when(a.completedAt, true) : "-"}</b>
          </div>
          <div className={cn(cell, "sm:col-span-2")}>
            <span className={label}>
              <Timer className="size-3.5" aria-hidden /> Tiempo invertido
            </span>
            <b className="text-sm">{a.investedMinutes === null ? "-" : durationText(a.investedMinutes)}</b>
          </div>
        </div>
      </div>
    </li>
  );
}

/** Pestaña Actividades del lead (prototipo): línea de tiempo, de la más reciente a la más antigua. */
export function LeadActivities({ leadId, canWrite, me }: { leadId: string; canWrite: boolean; me?: string }) {
  const { data, isLoading } = useActivities(`leadId=${leadId}&page=1&pageSize=100`);
  const owners = useOwners(canWrite).data ?? [];
  const [adding, setAdding] = useState(false);
  const rows = [...(data?.rows ?? [])].sort((x, y) => y.startedAt.localeCompare(x.startedAt));
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-bold">Actividades</h3>
        {canWrite && (
          <Button disabled={adding} onClick={() => setAdding(true)}>
            <Plus /> Nueva actividad
          </Button>
        )}
      </div>
      {adding && <NewActivity leadId={leadId} me={me} owners={owners} onClose={() => setAdding(false)} />}
      {isLoading ? (
        <Skeleton className="h-32 w-full rounded-xl" />
      ) : !rows.length ? (
        !adding && (
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
            <b>Aún no hay actividades</b>
            <p className="text-sm text-muted-foreground">Registra la primera: triage, demo, propuesta, follow up…</p>
          </div>
        )
      ) : (
        <ol aria-label="Actividades del lead">
          {rows.map((a, i) => (
            <ActivityItem key={a.id} a={a} last={i === rows.length - 1} canWrite={canWrite} owners={owners} leadId={leadId} />
          ))}
        </ol>
      )}
    </div>
  );
}
