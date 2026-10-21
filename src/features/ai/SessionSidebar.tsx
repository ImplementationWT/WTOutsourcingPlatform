import { MessageSquare, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AiSession } from "@/types/ai";

const STATUS: Record<AiSession["status"], { label: string; dot: string }> = {
  active: { label: "En curso", dot: "bg-emerald-400" },
  merged: { label: "Publicada", dot: "bg-violet-400" },
  closed: { label: "Cerrada", dot: "bg-foreground/30" },
};

function when(iso: string) {
  const date = new Date(iso);
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days < 1) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (days < 7) return date.toLocaleDateString([], { weekday: "short" });
  return date.toLocaleDateString([], { day: "2-digit", month: "short" });
}

/** Conversaciones del proyecto, como la lista de chats de Claude. */
export default function SessionSidebar({
  sessions,
  selectedId,
  creating,
  canCreate,
  onSelect,
  onNew,
  onClose,
}: {
  sessions: AiSession[];
  selectedId: string | null;
  creating: boolean;
  canCreate: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** En móvil la lista se abre encima: botón para cerrarla. */
  onClose?: () => void;
}) {
  return (
    <div className="flex h-full w-72 flex-col border-r border-foreground/10 bg-sidebar/80 backdrop-blur-xl">
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
            <MessageSquare className="size-4 shrink-0 text-violet-300" />
            <span className="truncate">Nueva conversación</span>
          </div>
        )}
        {sessions.map((session) => {
          const status = STATUS[session.status];
          const selected = !creating && session.id === selectedId;
          return (
            <button
              key={session.id}
              type="button"
              onClick={() => onSelect(session.id)}
              aria-current={selected ? "page" : undefined}
              className={cn(
                "flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition-colors",
                selected ? "bg-foreground/[0.08]" : "hover:bg-foreground/[0.05]",
              )}
            >
              <span className="truncate text-sm">{session.title}</span>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className={cn("size-1.5 rounded-full", status.dot)} />
                {status.label} · {when(session.lastMessageAt ?? session.createdAt)}
              </span>
            </button>
          );
        })}
        {!sessions.length && !creating && <p className="px-3 py-2 text-sm text-muted-foreground">Aún no hay conversaciones.</p>}
      </nav>

    </div>
  );
}
