import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronRight,
  FileText,
  Loader2,
  Search,
  Send,
  ShieldAlert,
  Square,
  Terminal,
  User,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AgentState, AiSession } from "@/types/ai";
import { confirmAiTool, interruptAi, sendAiMessage } from "./api";
import type { ChatItem, ToolCall } from "./useAiEvents";

export const textareaClass =
  "w-full min-w-0 resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30";

const TOOL_ICONS: Record<string, typeof Terminal> = { bash: Terminal, read: FileText, write: FileText, edit: FileText, glob: Search, grep: Search };
const TOOL_VERBS: Record<string, string> = { bash: "Ejecutó", read: "Leyó", write: "Escribió", edit: "Editó", glob: "Buscó", grep: "Buscó" };

function ToolRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICONS[call.tool] ?? Terminal;
  const failed = call.denied || call.confirmation?.allowed === false || call.result?.ok === false;
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs text-muted-foreground hover:bg-foreground/5"
      >
        <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        <Icon className={cn("size-3.5 shrink-0", failed && "text-red-400")} />
        <span className="shrink-0">{TOOL_VERBS[call.tool] ?? call.tool}</span>
        <code className="truncate font-mono text-foreground/80">{call.summary}</code>
        {!call.result && !failed && <Loader2 className="ml-auto size-3 shrink-0 animate-spin" />}
        {call.denied && <span className="ml-auto shrink-0 text-red-400">bloqueado</span>}
        {call.confirmation?.allowed === false && <span className="ml-auto shrink-0 text-red-400">denegado</span>}
      </button>
      {open && (
        <pre className="mt-1 mb-2 ml-6 max-h-72 overflow-auto rounded-md border border-foreground/10 bg-foreground/5 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
          {call.result?.output || (call.result ? "(sin salida)" : "En curso…")}
        </pre>
      )}
    </li>
  );
}

function Bubble({ item }: { item: Extract<ChatItem, { kind: "user" | "assistant" | "error" }> }) {
  if (item.kind === "error") {
    return (
      <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        {item.message}
      </div>
    );
  }
  const mine = item.kind === "user";
  return (
    <div className={cn("flex gap-2.5", mine && "flex-row-reverse")}>
      <div
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full border",
          mine ? "border-foreground/15 bg-foreground/5" : "border-violet-400/40 bg-violet-500/15 text-violet-200",
        )}
      >
        {mine ? <User className="size-3.5" /> : <Bot className="size-3.5" />}
      </div>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words",
          mine ? "rounded-tr-sm bg-violet-500/20" : "rounded-tl-sm border border-foreground/10 bg-foreground/[0.03]",
        )}
      >
        {item.text}
      </div>
    </div>
  );
}

const STATE_LABEL: Partial<Record<AgentState, string>> = {
  running: "Claude está trabajando…",
  waiting: "Claude espera tu aprobación para continuar.",
  budget: "Se alcanzó el presupuesto de la sesión.",
  error: "La sesión falló tras varios reintentos. Envía un mensaje para continuar.",
  refused: "Claude no puede continuar con esta petición.",
  terminated: "La sesión del agente terminó.",
};

/** Chat con el agente: mensajes, herramientas agrupadas, aprobaciones y caja de texto. */
export default function ChatPanel({
  session,
  items,
  state,
  pending,
  connection,
  onRaiseBudget,
}: {
  session: AiSession;
  items: ChatItem[];
  state: AgentState;
  pending: ToolCall[];
  connection: "connecting" | "open" | "lost";
  onRaiseBudget: () => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const active = session.status === "active";
  const running = state === "running";

  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: "end" });
  }, [items.length, state, pending.length]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo completar la acción.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const message = text.trim();
    if (!message) return;
    if (await act(() => sendAiMessage(session.id, message))) setText("");
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite">
        {connection === "connecting" && items.length === 0 && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Conectando con el agente…
          </p>
        )}
        {items.map((item) =>
          item.kind === "tools" ? (
            <ul key={item.id} className="ml-9 space-y-0.5 border-l border-foreground/10 pl-2">
              {item.calls.map((call) => (
                <ToolRow key={call.id} call={call} />
              ))}
            </ul>
          ) : (
            <Bubble key={item.id} item={item} />
          ),
        )}

        {pending.map((call) => (
          <div key={call.id} className="ml-9 space-y-2 rounded-lg border border-amber-400/40 bg-amber-500/10 p-3 text-sm">
            <p className="flex items-center gap-2 font-medium">
              <ShieldAlert className="size-4 text-amber-300" />
              Claude pide permiso para este paso
            </p>
            <code className="block rounded bg-background/60 px-2 py-1 font-mono text-xs break-all">{call.summary}</code>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => act(() => confirmAiTool(session.id, call.id, true))} disabled={busy}>
                <Check />
                Permitir
              </Button>
              <Button size="sm" variant="outline" onClick={() => act(() => confirmAiTool(session.id, call.id, false))} disabled={busy}>
                <X />
                Denegar
              </Button>
            </div>
          </div>
        ))}

        {STATE_LABEL[state] && active && (
          <div className="ml-9 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {running && <Loader2 className="size-4 animate-spin text-violet-300" />}
            {STATE_LABEL[state]}
            {state === "budget" && (
              <Button size="xs" variant="outline" onClick={() => act(onRaiseBudget)} disabled={busy}>
                Ampliar presupuesto
              </Button>
            )}
          </div>
        )}
        {connection === "lost" && (
          <p className="text-xs text-amber-300">Se perdió la conexión con el agente. Reconectando…</p>
        )}
        <div ref={bottom} />
      </div>

      {active ? (
        <div className="space-y-2 border-t border-foreground/10 p-3">
          {error && (
            <p role="alert" className="text-xs text-red-300">
              {error}
            </p>
          )}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            rows={3}
            maxLength={20_000}
            placeholder={running ? "Puedes enviar más indicaciones mientras trabaja…" : "Describe el cambio que quieres. Enter envía, Shift+Enter salto de línea."}
            aria-label="Instrucción para Claude"
            className={textareaClass}
            disabled={busy || state === "budget" || state === "waiting"}
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">Trabaja en la rama <code className="font-mono">{session.branch}</code>; nada llega a producción sin tu aprobación.</p>
            <div className="flex gap-2">
              {running && (
                <Button size="sm" variant="outline" onClick={() => act(() => interruptAi(session.id))} disabled={busy}>
                  <Square />
                  Detener
                </Button>
              )}
              <Button size="sm" onClick={send} disabled={busy || !text.trim() || state === "budget" || state === "waiting"}>
                {busy ? <Loader2 className="animate-spin" /> : <Send />}
                Enviar
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <p className="border-t border-foreground/10 p-3 text-sm text-muted-foreground">
          {session.status === "merged" ? "Sesión fusionada y desplegada." : "Sesión cerrada."} Abre una nueva para seguir haciendo cambios.
        </p>
      )}
    </div>
  );
}
