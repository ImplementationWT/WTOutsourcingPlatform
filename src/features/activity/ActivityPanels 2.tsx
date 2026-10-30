import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, RotateCw, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { activityKeys, createMeeting, createUpdate, dateText, meetingsQuery, processMeeting, updatesQuery, type Meeting } from "./api";

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

function MeetingItem({
  base,
  meeting,
  canWork,
  processingAvailable,
  onApplySentiment,
  onCreateTask,
}: {
  base: string;
  meeting: Meeting;
  canWork: boolean;
  processingAvailable: boolean;
  onApplySentiment?: (value: number) => Promise<void>;
  onCreateTask?: (title: string) => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string[]>([]);
  const badge = STATUS_BADGE[meeting.status];
  const canRetry = canWork && processingAvailable && meeting.transcriptLength > 0 && (meeting.status === "failed" || meeting.status === "pending");

  async function run(kind: string, fn: () => Promise<unknown>) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      setDone((d) => [...d, kind]);
    } catch (err) {
      setError(message(err, "No se pudo completar la acción."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="rounded-lg border border-foreground/10 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">{meeting.title}</p>
        <Badge variant="outline">{meeting.source === "read_ai" ? "Read.ai" : "Manual"}</Badge>
        {badge && <Badge variant={badge.variant}>{badge.label}</Badge>}
        <span className="ml-auto text-xs text-muted-foreground">{dateText(meeting.heldAt)}</span>
      </div>
      {meeting.processingError && <p className="mt-1 text-xs text-destructive">{meeting.processingError}</p>}
      {canRetry && (
        <Button
          className="mt-2"
          size="xs"
          variant="outline"
          disabled={busy !== null}
          onClick={() =>
            run("process", async () => {
              await processMeeting(base, meeting.id);
              await queryClient.invalidateQueries({ queryKey: activityKeys.meetings(base) });
              await queryClient.invalidateQueries({ queryKey: activityKeys.updates(base) });
            })
          }
        >
          {busy === "process" ? <Loader2 className="animate-spin" /> : <RotateCw />}
          {meeting.status === "failed" ? "Reintentar" : "Procesar ahora"}
        </Button>
      )}
      {meeting.summary && <p className="mt-2 text-sm whitespace-pre-wrap">{meeting.summary}</p>}
      {meeting.feedback.length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Feedback del cliente</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
            {meeting.feedback.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>
      )}
      {meeting.actionItems.length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Action items</p>
          <ul className="mt-1 space-y-1 text-sm">
            {meeting.actionItems.map((item, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">•</span>
                <span className="min-w-0 flex-1">{item}</span>
                {onCreateTask &&
                  (done.includes(`task-${i}`) ? (
                    <span className="text-xs text-muted-foreground">Tarea creada</span>
                  ) : (
                    <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => run(`task-${i}`, () => onCreateTask(item))}>
                      {busy === `task-${i}` ? <Loader2 className="animate-spin" /> : <Plus />}
                      Crear tarea
                    </Button>
                  ))}
              </li>
            ))}
          </ul>
        </div>
      )}
      {meeting.sentimentSignal !== null && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <Sparkles className="size-4 text-muted-foreground" />
          <span>
            Sentimiento sugerido: <span className="font-medium tabular-nums">{meeting.sentimentSignal}/100</span>
          </span>
          {onApplySentiment &&
            (done.includes("sentiment") ? (
              <span className="text-xs text-muted-foreground">Aplicado al proyecto</span>
            ) : (
              <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => run("sentiment", () => onApplySentiment(meeting.sentimentSignal!))}>
                Aplicar al proyecto
              </Button>
            ))}
        </div>
      )}
      <ErrorLine error={error} />
    </li>
  );
}

/** Log de reuniones. Con transcripción y sin resumen, el servidor las procesa con Claude. */
export function MeetingsPanel({
  base,
  canWork,
  onApplySentiment,
  onCreateTask,
}: {
  base: string;
  canWork: boolean;
  onApplySentiment?: (value: number) => Promise<void>;
  onCreateTask?: (title: string) => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery(meetingsQuery(base));
  const [title, setTitle] = useState("");
  const [heldAt, setHeldAt] = useState("");
  const [transcript, setTranscript] = useState("");
  const [summary, setSummary] = useState("");
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
        ...(transcript.trim() ? { transcript: transcript.trim() } : {}),
        ...(summary.trim() ? { summary: summary.trim() } : {}),
      });
      setTitle("");
      setHeldAt("");
      setTranscript("");
      setSummary("");
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
          ? "Pega la transcripción y se procesa sola: resumen, feedback del cliente, action items y un sentimiento sugerido."
          : "Log de reuniones. El procesamiento automático no está activado en el servidor (falta la clave de Anthropic): las transcripciones quedan pendientes."}
      </p>
      {canWork && (
        <form onSubmit={add} className="grid gap-3 rounded-lg border border-foreground/10 p-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="meet-title">Reunión</Label>
            <Input id="meet-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Kick Off con el cliente" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="meet-date">Fecha y hora</Label>
            <Input id="meet-date" type="datetime-local" value={heldAt} onChange={(e) => setHeldAt(e.target.value)} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="meet-transcript">Transcripción (opcional)</Label>
            <textarea id="meet-transcript" rows={4} className={textareaClass} value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder="Pega aquí la transcripción de la reunión" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="meet-summary">Resumen escrito a mano (opcional; si lo escribes, no se procesa)</Label>
            <textarea id="meet-summary" rows={2} className={textareaClass} value={summary} onChange={(e) => setSummary(e.target.value)} />
          </div>
          <div>
            <Button type="submit" disabled={title.trim().length < 3 || !heldAt || busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Plus />}
              Registrar reunión
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
            <MeetingItem key={m.id} base={base} meeting={m} canWork={canWork} processingAvailable={processingAvailable} onApplySentiment={onApplySentiment} onCreateTask={onCreateTask} />
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
