import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, ExternalLink, FileBarChart2, UserMinus, UserPlus } from "lucide-react";
import { Chip, type ChipColor } from "@/components/ui/chip";
import { Modal } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useTeams } from "@/features/admin/api";
import { useSession } from "@/features/auth/auth";
import type { MeetingDetail, MeetingRow } from "@/features/activity/api";
import { apiFetch } from "@/lib/api-client";
import { errorText, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

// Reuniones del lead: es el tablero de Meetings (/api/meetings, los mismos datos y la misma
// asignación) filtrado por este lead. La lógica de Read.ai (zona protegida) no se toca: aquí solo se
// listan, se asignan al lead y se cambia el equipo.

const TEAM_COLORS: ChipColor[] = ["purple", "amber", "blue", "green", "brown"];
const teamColor = (id: string) => TEAM_COLORS[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % TEAM_COLORS.length];

const when = (m: MeetingRow) => {
  const d = new Date(m.heldAt);
  const date = d.toLocaleDateString("es-PE", { day: "numeric", month: "short", year: "numeric" }).replace(".", "");
  const time = d.toLocaleTimeString("es-PE", { hour: "numeric", minute: "2-digit" });
  return [`${date} · ${time}`, m.durationMinutes ? `${m.durationMinutes} min` : null].filter(Boolean).join(" · ");
};

const send = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

/** Informe de la reunión (Read.ai): fecha, lead, team, resumen, temas, preguntas clave y action items. */
function ReportDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isLoading, error } = useQuery({ queryKey: ["meetings", "detail", id], queryFn: () => apiFetch<{ meeting: MeetingDetail }>(`/api/meetings/${id}`) });
  const m = data?.meeting;
  const list = (title: string, items: string[] | undefined) => (
    <section className="space-y-2">
      <h4 className="text-caps-label">{title}</h4>
      {items?.length ? (
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {items.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">Sin datos.</p>
      )}
    </section>
  );
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={m?.title ?? "Reporte"} description={m && [new Date(m.heldAt).toLocaleString("es-PE", { dateStyle: "medium", timeStyle: "short" }), m.lead?.title ?? "Sin lead", m.team?.name ?? "Sin team"].join(" · ")} className="max-w-2xl rounded-2xl">
      {isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : error || !m ? (
        <p role="alert" className="text-sm text-destructive">
          {errorText(error, "No se pudo cargar la reunión.")}
        </p>
      ) : (
        <div className="space-y-5 py-1">
          <section className="space-y-2">
            <h4 className="text-caps-label">Resumen</h4>
            <p className="text-sm whitespace-pre-wrap">{m.readAi?.summary || m.summary || "Sin resumen."}</p>
          </section>
          {list("Temas", m.readAi?.topics)}
          {list("Preguntas clave", m.readAi?.keyQuestions)}
          {list("Action items", m.readAi?.actionItems ?? m.actionItems.map((a) => a.text))}
          {m.url && (
            <a href={m.url} target="_blank" rel="noreferrer" className="inline-flex h-11 items-center gap-2 rounded-[10px] border border-border px-4 text-sm font-semibold hover:bg-muted">
              Abrir en Read.ai <ExternalLink className="size-4" />
            </a>
          )}
        </div>
      )}
    </Modal>
  );
}

function MeetingCard({ m, actions }: { m: MeetingRow; actions: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-card px-4 py-3">
      <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-accent-soft text-accent-text">
        <CalendarDays className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <b className="block truncate">{m.title}</b>
        <span className="block truncate text-sm text-muted-foreground">{when(m)}</span>
      </div>
      <div className="flex items-center gap-2">{actions}</div>
    </li>
  );
}

const iconButton = "inline-flex size-9 items-center justify-center rounded-[10px] border border-border bg-card transition-colors hover:border-line-strong hover:bg-muted";

/** Pestaña Reuniones del lead (prototipo): las de este lead y las que aún no tienen lead ni proyecto. */
export function LeadMeetings({ leadId, leadName, canWrite }: { leadId: string; leadName: string; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const isBoss = useSession().data?.role === "boss";
  const teams = useTeams().data ?? [];
  const { data, isLoading, error } = useQuery({ queryKey: ["meetings", "for-lead"], queryFn: () => apiFetch<{ rows: MeetingRow[] }>("/api/meetings?page=1&pageSize=100") });
  const [report, setReport] = useState<string | null>(null);
  const rows = data?.rows ?? [];
  const mine = rows.filter((m) => m.lead?.id === leadId);
  const free = rows.filter((m) => !m.lead && !m.project);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["meetings"] });
  const run = async (action: () => Promise<unknown>, done: string, undo?: () => Promise<unknown>) => {
    try {
      await action();
      await refresh();
      toast.success(done, undo ? { undo: async () => { await undo(); await refresh(); } } : undefined);
    } catch (err) {
      toast.error("No se pudo completar la acción.", { description: errorText(err, "Inténtalo de nuevo.") });
    }
  };
  const team = (m: MeetingRow) =>
    isBoss ? (
      <select aria-label={`Team de ${m.title}`} value={m.team?.id ?? ""} onChange={(e) => void run(() => apiFetch(`/api/meetings/${m.id}`, send("PATCH", { teamId: e.target.value || null })), "Team actualizado")} className={cn("native-caret h-7 cursor-pointer rounded-full border-0 pl-3 text-xs font-semibold outline-none", m.team ? `chip-${teamColor(m.team.id)}` : "chip-gray")}>
        <option value="">Sin team</option>
        {teams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    ) : (
      <Chip color={m.team ? teamColor(m.team.id) : "gray"}>{m.team?.name ?? "Sin team"}</Chip>
    );
  const reportButton = (m: MeetingRow) => (
    <button type="button" aria-label={`Ver reporte de ${m.title}`} title="Ver reporte" onClick={() => setReport(m.id)} className={iconButton}>
      <FileBarChart2 className="size-4" />
    </button>
  );
  if (isLoading) return <Skeleton className="h-40 w-full rounded-xl" />;
  if (error) return <p role="alert" className="text-sm text-destructive">{errorText(error, "No se pudieron cargar las reuniones.")}</p>;
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h3 className="flex items-center gap-2 text-lg font-bold">
          Reuniones de este lead <Chip color="blue">{mine.length}</Chip>
        </h3>
        {mine.length ? (
          <ul className="space-y-3">
            {mine.map((m) => (
              <MeetingCard
                key={m.id}
                m={m}
                actions={
                  <>
                    {team(m)}
                    {reportButton(m)}
                    {canWrite && (
                      <button type="button" aria-label={`Desasignar ${m.title}`} title="Desasignar de este lead" onClick={() => void run(() => apiFetch(`/api/sales/leads/${leadId}/meetings/${m.id}/unassign`, send("POST")), "Reunión desasignada", () => apiFetch(`/api/meetings/${m.id}/assign`, send("POST", { leadId })))} className={iconButton}>
                        <UserMinus className="size-4" />
                      </button>
                    )}
                  </>
                }
              />
            ))}
          </ul>
        ) : (
          <p className="rounded-xl border border-dashed border-line-strong px-6 py-6 text-center text-sm text-muted-foreground">Este lead aún no tiene reuniones. Asigna una de la lista de abajo.</p>
        )}
      </section>
      <section className="space-y-3">
        <div>
          <h3 className="flex items-center gap-2 text-lg font-bold">
            Sin asignar <Chip color="amber">{free.length}</Chip>
          </h3>
          <p className="text-sm text-muted-foreground">Reuniones que llegaron del calendario y aún no están vinculadas a ningún lead.</p>
        </div>
        {free.length ? (
          <ul className="space-y-3">
            {free.map((m) => (
              <MeetingCard
                key={m.id}
                m={m}
                actions={
                  <>
                    {team(m)}
                    {reportButton(m)}
                    {canWrite && (
                      <button type="button" aria-label={`Asignar ${m.title} a ${leadName}`} title="Asignar a este lead" onClick={() => void run(() => apiFetch(`/api/meetings/${m.id}/assign`, send("POST", { leadId })), `Reunión asignada a ${leadName}`, () => apiFetch(`/api/sales/leads/${leadId}/meetings/${m.id}/unassign`, send("POST")))} className="inline-flex size-9 items-center justify-center rounded-[10px] bg-primary text-primary-foreground hover:brightness-110">
                        <UserPlus className="size-4" />
                      </button>
                    )}
                  </>
                }
              />
            ))}
          </ul>
        ) : (
          <p className="rounded-xl border border-dashed border-line-strong px-6 py-6 text-center text-sm text-muted-foreground">No hay reuniones sin asignar.</p>
        )}
      </section>
      {report && <ReportDialog id={report} onClose={() => setReport(null)} />}
    </div>
  );
}
