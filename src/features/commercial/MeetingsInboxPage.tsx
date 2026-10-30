import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, Trash2 } from "lucide-react";
import { tableSelectClass } from "@/components/data-table/DataTable";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty } from "@/features/activity/ActivityPanels";
import { assignInboxMeeting, dateText, discardInboxMeeting, inboxKey, inboxQuery, type InboxMeeting } from "@/features/activity/api";
import { useSession } from "@/features/auth/auth";
import { opsKeys, type OpsProjectRow } from "@/features/ops/api";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";

/** Una reunión sin dueño: sus candidatos (por los correos) y a quién asignarla. */
function InboxItem({ meeting, canAssignProjects }: { meeting: InboxMeeting; canAssignProjects: boolean }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // El CEO/CCO puede elegir cualquier proyecto, no solo los que coinciden por correo.
  const projects = useQuery({
    queryKey: [...opsKeys.allProjects, "options"],
    queryFn: async () => (await apiFetch<{ rows: OpsProjectRow[] }>("/api/ops/projects?pageSize=100&sort=name&dir=asc")).rows,
    enabled: canAssignProjects,
    staleTime: 60_000,
  }).data;
  const candidates = meeting.candidates.filter((c) => canAssignProjects || c.kind === "lead");
  const others = (projects ?? []).filter((p) => !candidates.some((c) => c.kind === "project" && c.id === p.id)).map((p) => ({ kind: "project" as const, id: p.id, name: p.name }));
  const options = [...candidates, ...others];
  const [picked, setPicked] = useState("");
  const target = picked || (options[0] ? `${options[0].kind}:${options[0].id}` : "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(kind: string, fn: () => Promise<unknown>) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: inboxKey });
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo completar la acción.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="space-y-2 rounded-xl border border-foreground/10 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">{meeting.title}</p>
        {meeting.url && (
          <a href={meeting.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline">
            Read.ai <ExternalLink className="size-3" />
          </a>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {dateText(meeting.heldAt)}
          {meeting.durationMinutes ? ` · ${meeting.durationMinutes} min` : ""}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Participantes: {meeting.participants.map((p) => (p.email ? `${p.name} <${p.email}>` : p.name)).join(", ") || "sin datos"}
      </p>
      {meeting.readAi?.summary && <p className="text-sm text-muted-foreground">{meeting.readAi.summary}</p>}
      <p className="text-xs text-muted-foreground">
        {meeting.transcriptLength > 0 ? "Tiene transcripción: Claude la procesa al asignarla." : "Sin transcripción: quedan el resumen y los action items de Read.ai."}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {options.length ? (
          <>
            <select aria-label={`Asignar «${meeting.title}»`} className={cn(tableSelectClass, "min-w-56")} value={target} onChange={(e) => setPicked(e.target.value)}>
              {candidates.map((c) => (
                <option key={`${c.kind}:${c.id}`} value={`${c.kind}:${c.id}`}>
                  {c.kind === "project" ? "Proyecto" : "Lead"}: {c.name}
                </option>
              ))}
              {others.length > 0 && (
                <optgroup label="Otros proyectos">
                  {others.map((c) => (
                    <option key={`project:${c.id}`} value={`project:${c.id}`}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <Button
              size="sm"
              disabled={!target || busy !== null}
              onClick={() =>
                void run("assign", async () => {
                  const [kind, id] = target.split(":");
                  const { assigned } = await assignInboxMeeting(meeting.id, kind === "project" ? { projectId: id } : { leadId: id });
                  navigate(assigned.kind === "project" ? `/operativa/${assigned.id}` : `/comercial/leads/${assigned.id}`);
                })
              }
            >
              {busy === "assign" && <Loader2 className="animate-spin" />}
              Asignar
            </Button>
          </>
        ) : (
          <span className="text-sm text-muted-foreground">
            Ningún proyecto ni lead coincide con los correos. Agrega el correo al contacto (o al lead) y vuelve a enviarla desde Read.ai, o descártala si es interna.
          </span>
        )}
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => window.confirm(`¿Descartar «${meeting.title}»? No se guardará.`) && void run("discard", () => discardInboxMeeting(meeting.id))}>
          <Trash2 />
          Descartar
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

/**
 * Reuniones de Read.ai que no se pudieron asignar solas (§4.2): ningún contacto o lead tiene esos
 * correos, o coinciden con varios proyectos. El CEO/CCO las asigna a un proyecto o un lead; Comercial a un lead.
 */
export default function MeetingsInboxPage() {
  const role = useSession().data?.role;
  const { data, isLoading, error } = useQuery(inboxQuery());

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Reuniones por asignar</h1>
        <p className="mt-1 text-sm text-muted-foreground sm:text-base">
          Las reuniones de Read.ai se asignan solas por los correos de los participantes. Las que no coinciden con un solo proyecto o lead esperan aquí.
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error instanceof Error ? error.message : "No se pudo cargar la bandeja."}
        </p>
      ) : isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : !data?.length ? (
        <Empty>No hay reuniones por asignar.</Empty>
      ) : (
        <ul className="space-y-3">
          {data.map((m) => (
            <InboxItem key={m.id} meeting={m} canAssignProjects={role === "boss"} />
          ))}
        </ul>
      )}
    </div>
  );
}
