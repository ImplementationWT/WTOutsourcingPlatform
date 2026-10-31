import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, ExternalLink, Trash2, Users } from "lucide-react";
import { DataTable, type Column } from "@/components/data-table/DataTable";
import { useTableState } from "@/components/data-table/table-state";
import { useTablePage } from "@/components/data-table/use-table-page";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-context";
import { Modal } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { useTeams } from "@/features/admin/api";
import {
  assignMeeting,
  dateText,
  discardMeeting,
  ENGAGEMENT_LABELS,
  ENGAGEMENT_TONE,
  MEETING_ENGAGEMENTS,
  MEETING_FILTERS,
  MEETING_KIND_LABELS,
  meetingDetailQuery,
  meetingsTableKey,
  setMeetingTeam,
  type MeetingEngagement,
  type MeetingRow,
} from "@/features/activity/api";
import { useSession } from "@/features/auth/auth";
import { errorText, toast } from "@/lib/toast";

/** Sin equipo: la clave del grupo en los contadores del servidor. */
const NO_TEAM = "";

export function EngagementBadge({ value }: { value: MeetingEngagement | null }) {
  if (!value) return <span className="text-xs text-muted-foreground">Sin evaluar</span>;
  return (
    <StatusBadge tone={ENGAGEMENT_TONE[value]} dot title="Engagement de la reunión (lo evalúa Claude)">
      {ENGAGEMENT_LABELS[value]}
    </StatusBadge>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-field-label tracking-wide uppercase">{title}</h3>
      {children}
    </section>
  );
}

function List({ items, empty }: { items: string[]; empty: string }) {
  if (!items.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

/** Pop-up de la reunión: resumen de Claude y lo que mandó Read.ai; ligar, equipo y descartar. */
function MeetingDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { data, isLoading, error } = useQuery({ ...meetingDetailQuery(id), refetchInterval: (q) => (q.state.data?.meeting.status === "pending" || q.state.data?.meeting.status === "processing" ? 4000 : false) });
  const teams = useTeams().data ?? [];
  const [busy, setBusy] = useState(false);
  const meeting = data?.meeting;
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: meetingsTableKey }), queryClient.invalidateQueries({ queryKey: ["activity", "meeting", id] })]);

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await fn();
      await refresh();
      toast.success(done);
    } catch (err) {
      toast.error("No se pudo completar la acción.", { description: errorText(err, "Inténtalo de nuevo.") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={meeting?.title ?? "Reunión"}
      description={meeting ? `${dateText(meeting.heldAt)}${meeting.durationMinutes ? ` · ${meeting.durationMinutes} min` : ""}` : undefined}
      className="max-w-2xl"
      footer={
        meeting?.url ? (
          <a href={meeting.url} target="_blank" rel="noreferrer" className="inline-flex h-control items-center justify-center gap-1.5 rounded-lg border border-input px-3 text-sm hover:bg-muted">
            Abrir en Read.ai <ExternalLink className="size-3.5" />
          </a>
        ) : undefined
      }
    >
      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : error || !meeting || !data ? (
        <p role="alert" className="text-sm text-destructive">
          {error instanceof Error ? error.message : "No se pudo cargar la reunión."}
        </p>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <EngagementBadge value={meeting.engagement} />
            {meeting.kind && <StatusBadge tone="outline">{MEETING_KIND_LABELS[meeting.kind]}</StatusBadge>}
            <StatusBadge tone={meeting.team ? "neutral" : "warn"}>{meeting.team?.name ?? "Sin equipo"}</StatusBadge>
            {meeting.project && (
              <Link className="text-sm text-primary underline-offset-4 hover:underline" to={`/operativa/${meeting.project.id}`}>
                Proyecto: {meeting.project.name}
              </Link>
            )}
            {meeting.lead && (
              <Link className="text-sm text-primary underline-offset-4 hover:underline" to={`/comercial/leads/${meeting.lead.id}`}>
                Lead: {meeting.lead.title}
              </Link>
            )}
          </div>

          {(meeting.status === "pending" || meeting.status === "processing") && (
            <p className="rounded-lg bg-info/10 px-3 py-2 text-sm text-info-fg">Claude está procesando la transcripción: el resumen y el engagement aparecen en unos segundos.</p>
          )}

          <Section title="Resumen">
            <p className="text-sm whitespace-pre-wrap">{meeting.summary || meeting.readAi?.summary || "Sin resumen."}</p>
          </Section>

          {meeting.readAi && (
            <div className="space-y-4 rounded-xl border border-border bg-muted/40 p-4">
              <p className="text-section-title">Read.ai</p>
              {meeting.readAi.summary && meeting.readAi.summary !== meeting.summary && (
                <Section title="Resumen de Read.ai">
                  <p className="text-sm whitespace-pre-wrap text-muted-foreground">{meeting.readAi.summary}</p>
                </Section>
              )}
              <Section title="Temas">
                <List items={meeting.readAi.topics} empty="Sin temas." />
              </Section>
              <Section title="Preguntas clave">
                <List items={meeting.readAi.keyQuestions} empty="Sin preguntas clave." />
              </Section>
              <Section title="Action items de Read.ai">
                <List items={meeting.readAi.actionItems} empty="Sin action items." />
              </Section>
            </div>
          )}

          {meeting.feedback.length > 0 && (
            <Section title="Feedback del cliente">
              <List items={meeting.feedback} empty="" />
            </Section>
          )}

          <Section title="Participantes">
            <ul className="flex flex-wrap gap-1.5 text-sm">
              {meeting.participants.length ? (
                meeting.participants.map((p, i) => (
                  <li key={i} className="rounded-full border border-border px-2.5 py-0.5">
                    {p.name}
                    {p.email && <span className="text-muted-foreground"> · {p.email}</span>}
                  </li>
                ))
              ) : (
                <li className="text-muted-foreground">Sin participantes registrados.</li>
              )}
            </ul>
          </Section>

          {(data.permissions.team || (data.permissions.assign && !meeting.project && !meeting.lead)) && (
            <div className="space-y-3 border-t border-border pt-4">
              {data.permissions.team && (
                <div className="grid gap-1.5 sm:grid-cols-[10rem_1fr] sm:items-center">
                  <span className="text-field-label">Equipo</span>
                  <Select
                    label="Equipo de la reunión"
                    value={meeting.team?.id ?? null}
                    emptyLabel="Sin equipo"
                    options={teams.map((t) => ({ value: t.id, label: t.name }))}
                    disabled={busy}
                    onValueChange={(v) => void run(() => setMeetingTeam(meeting.id, v), "Equipo actualizado")}
                  />
                </div>
              )}
              {data.permissions.assign && !meeting.project && !meeting.lead && (
                <div className="grid gap-1.5 sm:grid-cols-[10rem_1fr] sm:items-center">
                  <span className="text-field-label">Ligar a</span>
                  {meeting.candidates.length ? (
                    <Select
                      label="Ligar la reunión a un proyecto o lead"
                      value={null}
                      placeholder="Elige el proyecto o lead"
                      disabled={busy}
                      options={meeting.candidates
                        .filter((c) => c.kind === "lead" || data.permissions.team)
                        .map((c) => ({ value: `${c.kind}:${c.id}`, label: c.name, description: c.kind === "project" ? "Proyecto (coincide por correo)" : "Lead (coincide por correo)" }))}
                      onValueChange={(v) => {
                        if (!v) return;
                        const [kind, target] = v.split(":");
                        void run(() => assignMeeting(meeting.id, kind === "project" ? { projectId: target } : { leadId: target }), "Reunión ligada");
                      }}
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground">Ningún proyecto ni lead coincide con los correos de los participantes.</p>
                  )}
                </div>
              )}
              {data.permissions.discard && (
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy}
                  onClick={async () => {
                    const ok = await confirm({
                      title: `¿Descartar «${meeting.title}»?`,
                      description: "La reunión se borra de Meetings. Si la necesitas después, hay que reenviarla desde Read.ai.",
                      confirmLabel: "Descartar",
                      tone: "danger",
                    });
                    if (ok) await run(() => discardMeeting(meeting.id), "Reunión descartada").then(onClose);
                  }}
                >
                  <Trash2 />
                  Descartar reunión
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/**
 * Meetings: todas las reuniones de Read.ai en una tabla, agrupables por equipo. El equipo sale del
 * correo del Team Leader que participó; el engagement lo evalúa Claude.
 */
export default function MeetingsPage() {
  const session = useSession().data;
  const table = useTableState({ filterKeys: MEETING_FILTERS });
  const { data, isLoading, isFetching, error } = useTablePage<MeetingRow>(meetingsTableKey, "/api/meetings", table.query, Boolean(session));
  const teams = useTeams().data ?? [];
  const [open, setOpen] = useState<string | null>(null);

  // Nombres de equipo: los que ve el usuario más los que aparecen en la página.
  const teamLabels: Record<string, string> = { [NO_TEAM]: "Sin equipo" };
  for (const t of teams) teamLabels[t.id] = t.name;
  for (const row of data?.rows ?? []) if (row.team) teamLabels[row.team.id] = row.team.name;

  const columns: Column<MeetingRow>[] = [
    {
      id: "title",
      header: "Reunión",
      sortKey: "title",
      card: "title",
      cell: (m) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium" title={m.title}>
            {m.title}
          </span>
          {(m.project || m.lead) && <span className="truncate text-xs text-muted-foreground">{m.project ? `Proyecto: ${m.project.name}` : `Lead: ${m.lead!.title}`}</span>}
        </span>
      ),
    },
    {
      id: "heldAt",
      header: "Fecha",
      sortKey: "heldAt",
      cell: (m) => (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <CalendarClock className="size-3.5 text-muted-foreground" aria-hidden />
          {dateText(m.heldAt)}
        </span>
      ),
    },
    {
      id: "team",
      header: "Equipo",
      cell: (m) =>
        m.team ? (
          <span className="inline-flex items-center gap-1.5">
            <Users className="size-3.5 text-muted-foreground" aria-hidden />
            {m.team.name}
          </span>
        ) : (
          <StatusBadge tone="warn">Sin equipo</StatusBadge>
        ),
    },
    { id: "engagement", header: "Engagement", sortKey: "engagement", cell: (m) => <EngagementBadge value={m.engagement} /> },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-page-title">Meetings</h1>
        <p className="mt-1 text-sm text-muted-foreground sm:text-base">
          Las reuniones de Read.ai de todos los equipos. El equipo sale del correo del Team Leader que participó; el engagement lo evalúa Claude.
        </p>
      </div>
      <DataTable
        label="Meetings"
        columns={columns}
        table={table}
        data={data}
        isLoading={isLoading}
        isFetching={isFetching}
        error={error}
        rowKey={(m) => m.id}
        onRowClick={(m) => setOpen(m.id)}
        empty="Aún no llegan reuniones de Read.ai."
        searchPlaceholder="Buscar por reunión o participante"
        filters={[
          { key: "teamId", label: "Filtrar por equipo", all: "Todos los equipos", options: [...teams.map((t) => ({ value: t.id, label: t.name })), { value: "none", label: "Sin equipo" }] },
          { key: "engagement", label: "Filtrar por engagement", all: "Todo el engagement", options: MEETING_ENGAGEMENTS.map((e) => ({ value: e, label: ENGAGEMENT_LABELS[e] })) },
        ]}
        grouping={{
          label: "Agrupar por equipo",
          value: (m) => m.team?.id ?? NO_TEAM,
          order: [...Object.keys(teamLabels).filter((k) => k !== NO_TEAM), NO_TEAM],
          labels: teamLabels,
        }}
      />
      {open && <MeetingDialog id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
