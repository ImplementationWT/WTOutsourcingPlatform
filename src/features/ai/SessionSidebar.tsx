import { useState } from "react";
import { Loader2, MessageSquare, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AiSession } from "@/types/ai";
import { LOCALE } from "@/lib/format";

const STATUS: Record<AiSession["status"], { label: string; dot: string }> = {
  active: { label: "En curso", dot: "bg-emerald-400" },
  merged: { label: "Publicada", dot: "bg-brand-400" },
  closed: { label: "Cerrada", dot: "bg-foreground/30" },
};

function when(iso: string) {
  const date = new Date(iso);
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days < 1) return date.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
  if (days < 7) return date.toLocaleDateString(LOCALE, { weekday: "short" });
  return date.toLocaleDateString(LOCALE, { day: "2-digit", month: "short" });
}

/** Conversaciones del proyecto, como la lista de chats de Claude. */
export default function SessionSidebar({
  sessions,
  selectedId,
  creating,
  canCreate,
  onSelect,
  onNew,
  onDelete,
  onDeleteAll,
  onClose,
}: {
  sessions: AiSession[];
  selectedId: string | null;
  creating: boolean;
  canCreate: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** Borra una conversación (si está en curso, antes la cierra). */
  onDelete: (id: string) => Promise<void>;
  /** Borra todas las conversaciones del proyecto. */
  onDeleteAll: () => Promise<void>;
  /** En móvil la lista se abre encima: botón para cerrarla. */
  onClose?: () => void;
}) {
  // Confirmación en dos pasos: el primer clic pregunta, el segundo borra.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      setConfirming(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo borrar.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex h-full w-60 flex-col border-r border-foreground/10 bg-sidebar/80 backdrop-blur-xl">
      <div className="flex items-center gap-2 px-3 pt-3">
        <Button
          variant="outline"
          className="flex-1 justify-start"
          onClick={onNew}
          disabled={!canCreate}
          title={canCreate ? undefined : "Termina o cierra la conversación en curso para empezar otra"}
        >
          <Plus />
          Nueva conversación
        </Button>
        {onClose && (
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Cerrar lista">
            <X />
          </Button>
        )}
      </div>

      <p className="px-4 pt-5 pb-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">Conversaciones</p>
      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3" aria-label="Conversaciones">
        {creating && (
          <div className="flex items-center gap-2 rounded-lg bg-foreground/[0.07] px-3 py-2 text-sm">
            <MessageSquare className="size-4 shrink-0 text-brand-300" />
            <span className="truncate">Nueva conversación</span>
          </div>
        )}
        {sessions.map((session) => {
          const status = STATUS[session.status];
          const selected = !creating && session.id === selectedId;
          const asking = confirming === session.id;
          return (
            <div
              key={session.id}
              className={cn("group relative rounded-lg transition-colors", selected ? "bg-foreground/[0.08]" : "hover:bg-foreground/[0.05]")}
            >
              <button
                type="button"
                onClick={() => onSelect(session.id)}
                aria-current={selected ? "page" : undefined}
                className="flex w-full flex-col gap-0.5 px-3 py-2 pr-9 text-left"
              >
                <span className="truncate text-sm">{session.title}</span>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className={cn("size-1.5 rounded-full", status.dot)} />
                  {status.label} · {when(session.lastMessageAt ?? session.createdAt)}
                </span>
              </button>
              {asking ? (
                <div className="flex items-center gap-1.5 px-3 pb-2 text-xs">
                  <span className="text-muted-foreground">{session.status === "active" ? "Se cerrará y se borrará." : "¿Borrar?"}</span>
                  <Button size="xs" variant="destructive" onClick={() => run(session.id, () => onDelete(session.id))} disabled={busy !== null}>
                    {busy === session.id && <Loader2 className="animate-spin" />}
                    Borrar
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setConfirming(null)}>
                    No
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(session.id)}
                  aria-label={`Borrar ${session.title}`}
                  title="Borrar conversación"
                  className="absolute top-2 right-2 rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-foreground/10 hover:text-red-300 focus-visible:opacity-100"
                >
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </div>
          );
        })}
        {!sessions.length && !creating && <p className="px-3 py-2 text-sm text-muted-foreground">Aún no hay conversaciones.</p>}
      </nav>

      {error && (
        <p role="alert" className="px-4 pb-2 text-xs text-red-300">
          {error}
        </p>
      )}
      {sessions.length > 0 && (
        <div className="border-t border-foreground/10 p-3">
          {confirming === "all" ? (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">¿Borrar las {sessions.length} conversaciones?</span>
              <Button size="xs" variant="destructive" onClick={() => run("all", onDeleteAll)} disabled={busy !== null}>
                {busy === "all" && <Loader2 className="animate-spin" />}
                Borrar todas
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setConfirming(null)}>
                No
              </Button>
            </div>
          ) : (
            <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setConfirming("all")}>
              <Trash2 />
              Borrar todas las conversaciones
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
