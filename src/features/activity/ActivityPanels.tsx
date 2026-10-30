import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, Plus, RotateCw, Sparkles, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  ACTION_ITEM_KIND_LABELS,
  ACTION_ITEM_KINDS,
  ACTION_ITEM_STATUS_LABELS,
  activityKeys,
  CLIENT_SENTIMENT_LABELS,
  CLIENT_SENTIMENT_TONE,
  convertActionItem,
  createMeeting,
  createUpdate,
  dateText,
  MEETING_KIND_LABELS,
  MEETING_KINDS,
  MEETING_REVIEW_STATUSES,
  meetingsQuery,
  processMeeting,
  REVIEW_STATUS_LABELS,
  updateActionItem,
  updateMeeting,
  updatesQuery,
  type ActionItem,
  type ActionItemKind,
  type Conversion,
  type Meeting,
  type MeetingKind,
  type MeetingReviewStatus,
} from "./api";

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
export const textareaClass =
  "w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  ) : null;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-dashed border-foreground/15 p-6 text-center text-sm text-muted-foreground">{children}</p>;
}

export function Loading() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-full" />
    </div>
  );
}

const STATUS_BADGE: Record<Meeting["status"], { label: string; variant: "secondary" | "outline" | "destructive" } | null> = {
  pending: { label: "Pendiente de procesar", variant: "secondary" },
  processing: { label: "Procesando…", variant: "secondary" },
  processed: null,
  failed: { label: "No se pudo procesar", variant: "destructive" },
};

const CONVERSION_LABELS: Record<Conversion, string> = { task: "Crear tarea", change_order: "Crear change order", activity: "Crear actividad" };
const inlineSelect = "h-7 rounded-md border border-input bg-transparent px-1.5 text-xs outline-none focus-visible:border-ring dark:bg-input/30";

/** Deal que se puede ligar a la reunión (los del proyecto o del lead). */
export interface MeetingDealOption {
  id: string;
  dealCode: string;
  title: string;
}

function ActionItemRow({
  base,
  meeting,
  item,
  canWork,
  conversions,
  deals,
  onChanged,
}: {
  base: string;
  meeting: Meeting;
  item: ActionItem;
  canWork: boolean;
  conversions: Conversion[];
  deals: MeetingDealOption[];
  onChanged: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dealId, setDealId] = useState(meeting.deal?.id ?? "");
  const open = item.status === "proposed" || item.status === "accepted";
  const converted = item.status === "task" || item.status === "change_order" || item.status === "activity";

  async function run(kind: string, fn: () => Promise<unknown>) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      await onChanged();
    } catch (err) {
      setError(message(err, "No se pudo completar la acción."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className={cn("rounded-md border border-foreground/10 p-2", item.status === "discarded" && "opacity-60")}>
      <div className="flex flex-wrap items-start gap-2">
        <p className={cn("min-w-0 flex-1 text-sm", item.status === "discarded" && "line-through")}>{item.text}</p>
        <span className={cn("rounded-full px-2 py-px text-[11px] whitespace-nowrap", converted ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-foreground/10 text-muted-foreground")}>
          {ACTION_ITEM_STATUS_LABELS[item.status]}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {[item.kind ? ACTION_ITEM_KIND_LABELS[item.kind] : "Sin tipo", item.owner?.name ?? item.ownerName ?? "Sin responsable", item.projectedHours !== null ? `${item.projectedHours} h` : null, item.phase]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {canWork && open && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <select
            aria-label={`Tipo de «${item.text}»`}
            className={inlineSelect}
            value={item.kind ?? ""}
            disabled={busy !== null}
            onChange={(e) => void run("kind", () => updateActionItem(base, meeting.id, item.id, { kind: (e.target.value || null) as ActionItemKind | null }))}
          >
            <option value="">Sin tipo</option>
            {ACTION_ITEM_KINDS.map((k) => (
              <option key={k} value={k}>
                {ACTION_ITEM_KIND_LABELS[k]}
              </option>
            ))}
          </select>
          {conversions.includes("change_order") && !meeting.deal && deals.length > 0 && (
            <select aria-label={`Deal del change order de «${item.text}»`} className={inlineSelect} value={dealId} onChange={(e) => setDealId(e.target.value)}>
              <option value="">Deal del change order</option>
              {deals.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.dealCode} · {d.title}
                </option>
              ))}
            </select>
          )}
          {conversions.map((to) => (
            <Button
              key={to}
              size="xs"
              variant="outline"
              disabled={busy !== null || (to === "change_order" && !meeting.deal && !dealId)}
              onClick={() => void run(to, () => convertActionItem(base, meeting.id, item.id, { to, ...(to === "change_order" && dealId ? { dealId } : {}) }))}
            >
              {busy === to ? <Loader2 className="animate-spin" /> : <Plus />}
              {CONVERSION_LABELS[to]}
            </Button>
          ))}
          <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => void run("discard", () => updateActionItem(base, meeting.id, item.id, { status: "discarded" }))}>
            <X />
            Descartar
          </Button>
        </div>
      )}
      {canWork && item.status === "discarded" && (
        <Button className="mt-1" size="xs" variant="ghost" disabled={busy !== null} onClick={() => void run("restore", () => updateActionItem(base, meeting.id, item.id, { status: "proposed" }))}>
          Volver a proponer
        </Button>
      )}
      <ErrorLine error={error} />
    </li>
  );
}

function MeetingItem({
  base,
  meeting,
  canWork,
  processingAvailable,
  conversions,
  deals,
}: {
  base: string;
  meeting: Meeting;
  canWork: boolean;
  processingAvailable: boolean;
  conversions: Conversion[];
  deals: MeetingDealOption[];
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const badge = STATUS_BADGE[meeting.status];
  const canRetry = canWork && processingAvailable && meeting.transcriptLength > 0 && (meeting.status === "failed" || meeting.status === "pending");
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: activityKeys.meetings(base) }), queryClient.invalidateQueries({ queryKey: activityKeys.updates(base) })]);
  const otherParticipants = meeting.participants.filter((p) => !meeting.attendees.some((a) => a.name && a.name === p.name));

  async function run(kind: string, fn: () => Promise<unknown>) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(message(err, "No se pudo completar la acción."));
    } finally {
      setBusy(null);
    }
  }
  const save = (kind: string, patch: Parameters<typeof updateMeeting>[2]) => void run(kind, () => updateMeeting(base, meeting.id, patch));

  return (
    <li className="space-y-2 rounded-lg border border-foreground/10 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">{meeting.title}</p>
        {meeting.source === "read_ai" && meeting.url ? (
          <a href={meeting.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline">
            Read.ai <ExternalLink className="size-3" />
          </a>
        ) : (
          <Badge variant="outline">{meeting.source === "read_ai" ? "Read.ai" : "Manual"}</Badge>
        )}
        {badge && <Badge variant={badge.variant}>{badge.label}</Badge>}
        {meeting.clientSentiment && (
          <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-xs font-medium", CLIENT_SENTIMENT_TONE[meeting.clientSentiment])} title="Sentimiento del cliente (lo propone el procesamiento)">
            {CLIENT_SENTIMENT_LABELS[meeting.clientSentiment]}
          </span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {dateText(meeting.heldAt)}
          {meeting.durationMinutes ? ` · ${meeting.durationMinutes} min` : ""}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        {canWork ? (
          <>
            <select aria-label={`Estado de proceso de «${meeting.title}»`} className={inlineSelect} value={meeting.reviewStatus} disabled={busy !== null} onChange={(e) => save("review", { reviewStatus: e.target.value as MeetingReviewStatus })}>
              {MEETING_REVIEW_STATUSES.map((st) => (
                <option key={st} value={st}>
                  {REVIEW_STATUS_LABELS[st]}
                </option>
              ))}
            </select>
            <select aria-label={`Tipo de «${meeting.title}»`} className={inlineSelect} value={meeting.kind ?? ""} disabled={busy !== null} onChange={(e) => save("kind", { kind: (e.target.value || null) as MeetingKind | null })}>
              <option value="">Tipo sin definir</option>
              {MEETING_KINDS.map((k) => (
                <option key={k} value={k}>
                  {MEETING_KIND_LABELS[k]}
                </option>
              ))}
            </select>
            {deals.length > 0 && (
              <select aria-label={`Deal de «${meeting.title}»`} className={inlineSelect} value={meeting.deal?.id ?? ""} disabled={busy !== null} onChange={(e) => save("deal", { dealId: e.target.value || null })}>
                <option value="">Sin deal</option>
                {deals.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.dealCode} · {d.title}
                  </option>
                ))}
              </select>
            )}
          </>
        ) : (
          <>
            <Badge variant="outline">{REVIEW_STATUS_LABELS[meeting.reviewStatus]}</Badge>
            {meeting.kind && <Badge variant="outline">{MEETING_KIND_LABELS[meeting.kind]}</Badge>}
            {meeting.deal && <Badge variant="outline">{meeting.deal.dealCode}</Badge>}
          </>
        )}
      </div>

      {(meeting.attendees.length > 0 || otherParticipants.length > 0) && (
        <p className="text-xs text-muted-foreground">
          Asistentes: {[...meeting.attendees.map((a) => a.name ?? "Contacto"), ...otherParticipants.map((p) => p.name)].join(", ")}
        </p>
      )}
      {meeting.processingError && <p className="text-xs text-destructive">{meeting.processingError}</p>}
      {canRetry && (
        <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => void run("process", () => processMeeting(base, meeting.id))}>
          {busy === "process" ? <Loader2 className="animate-spin" /> : <RotateCw />}
          {meeting.status === "failed" ? "Reintentar" : "Procesar ahora"}
        </Button>
      )}
      {meeting.summary && <p className="text-sm whitespace-pre-wrap">{meeting.summary}</p>}
      {meeting.readAi?.summary && meeting.readAi.summary !== meeting.summary && (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-muted-foreground">Resumen de Read.ai</summary>
          <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{meeting.readAi.summary}</p>
        </details>
      )}
      {meeting.feedback.length > 0 && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Feedback del cliente</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
            {meeting.feedback.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>
      )}
      {meeting.actionItems.length > 0 && (
        <div>
          <p className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Sparkles className="size-3.5" /> Action items propuestos
          </p>
          <ul className="mt-1 space-y-1.5">
            {meeting.actionItems.map((item) => (
              <ActionItemRow key={item.id} base={base} meeting={meeting} item={item} canWork={canWork} conversions={conversions} deals={deals} onChanged={refresh} />
            ))}
          </ul>
        </div>
      )}
      <ErrorLine error={error} />
    </li>
  );
}

/**
 * Reuniones de un proyecto o un lead (§4.2). Con transcripción y sin resumen, el servidor las
 * procesa con Claude. Claude propone; una persona revisa y convierte los action items.
 */
export function MeetingsPanel({ base, canWork, deals = [] }: { base: string; canWork: boolean; deals?: MeetingDealOption[] }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery(meetingsQuery(base));
  const [title, setTitle] = useState("");
  const [heldAt, setHeldAt] = useState("");
  const [kind, setKind] = useState<MeetingKind | "">("");
  const [transcript, setTranscript] = useState("");
  const [summary, setSummary] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const processingAvailable = data?.processingAvailable ?? false;

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (title.trim().length < 3 || !heldAt) return;
    setBusy(true);
    setFormError(null);
    try {
      await createMeeting(base, {
        title: title.trim(),
        heldAt: new Date(heldAt).toISOString(),
        ...(kind ? { kind } : {}),
        ...(transcript.trim() ? { transcript: transcript.trim() } : {}),
        ...(summary.trim() ? { summary: summary.trim() } : {}),
      });
      setTitle("");
      setHeldAt("");
      setKind("");
      setTranscript("");
      setSummary("");
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: activityKeys.meetings(base) });
    } catch (err) {
      setFormError(message(err, "No se pudo registrar la reunión."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {processingAvailable
          ? "Las reuniones de Read.ai llegan solas. Con transcripción, Claude propone resumen, feedback, action items, sentimiento del cliente y tipo; una persona revisa y decide."
          : "Log de reuniones. El procesamiento automático no está activado en el servidor (falta la clave de Anthropic): las transcripciones quedan pendientes."}
      </p>
      {canWork && !open && (
        <Button variant="outline" onClick={() => setOpen(true)}>
          <Plus />
          Registrar reunión
        </Button>
      )}
      {canWork && open && (
        <form onSubmit={add} className="grid gap-3 rounded-lg border border-foreground/10 p-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="meet-title">Reunión</Label>
            <Input id="meet-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Kick Off con el cliente" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="meet-date">Fecha y hora</Label>
            <Input id="meet-date" type="datetime-local" value={heldAt} onChange={(e) => setHeldAt(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="meet-kind">Tipo</Label>
            <select id="meet-kind" className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30" value={kind} onChange={(e) => setKind(e.target.value as MeetingKind | "")}>
              <option value="">Que lo sugiera Claude</option>
              {MEETING_KINDS.map((k) => (
                <option key={k} value={k}>
                  {MEETING_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5 sm:col-span-3">
            <Label htmlFor="meet-transcript">Transcripción (opcional)</Label>
            <textarea id="meet-transcript" rows={4} className={textareaClass} value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder="Pega aquí la transcripción de la reunión" />
          </div>
          <div className="space-y-1.5 sm:col-span-3">
            <Label htmlFor="meet-summary">Resumen escrito a mano (opcional; si lo escribes, no se procesa)</Label>
            <textarea id="meet-summary" rows={2} className={textareaClass} value={summary} onChange={(e) => setSummary(e.target.value)} />
          </div>
          <div className="flex gap-2 sm:col-span-3">
            <Button type="submit" disabled={title.trim().length < 3 || !heldAt || busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Plus />}
              Guardar reunión
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
          </div>
        </form>
      )}
      <ErrorLine error={formError ?? (error ? message(error, "No se pudieron cargar las reuniones.") : null)} />
      {isLoading ? (
        <Loading />
      ) : !data?.meetings.length ? (
        <Empty>Aún no hay reuniones registradas.</Empty>
      ) : (
        <ul className="space-y-2">
          {data.meetings.map((m) => (
            <MeetingItem key={m.id} base={base} meeting={m} canWork={canWork} processingAvailable={processingAvailable} conversions={data.conversions ?? []} deals={deals} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Bitácora de novedades: las escritas por personas y las que deja el sistema en cada cambio. */
export function UpdatesPanel({ base, canWork, onPosted }: { base: string; canWork: boolean; onPosted?: () => Promise<unknown> }) {
  const queryClient = useQueryClient();
  const { data: updates, isLoading, error } = useQuery(updatesQuery(base));
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setFormError(null);
    try {
      await createUpdate(base, body.trim());
      setBody("");
      await queryClient.invalidateQueries({ queryKey: activityKeys.updates(base) });
      await onPosted?.();
    } catch (err) {
      setFormError(message(err, "No se pudo publicar la novedad."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {canWork && (
        <form onSubmit={add} className="space-y-2">
          <Label htmlFor="update-body">Nueva novedad</Label>
          <textarea id="update-body" rows={3} className={textareaClass} value={body} onChange={(e) => setBody(e.target.value)} placeholder="¿Qué pasó?" />
          <Button type="submit" disabled={!body.trim() || busy}>
            {busy && <Loader2 className="animate-spin" />}
            Publicar
          </Button>
        </form>
      )}
      <ErrorLine error={formError ?? (error ? message(error, "No se pudieron cargar las novedades.") : null)} />
      {isLoading ? (
        <Loading />
      ) : !updates?.length ? (
        <Empty>Aún no hay novedades.</Empty>
      ) : (
        <ol className="space-y-2">
          {updates.map((u) => (
            <li key={u.id} className={cn("rounded-lg border p-3", u.kind === "system" ? "border-dashed border-foreground/15 bg-foreground/[0.02]" : "border-foreground/10")}>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{u.kind === "system" ? "Sistema" : u.authorName}</span>
                {u.kind === "system" && <span>· {u.authorName}</span>}
                <span className="ml-auto">{dateText(u.createdAt)}</span>
              </div>
              <p className="mt-1 text-sm whitespace-pre-wrap">{u.body}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
