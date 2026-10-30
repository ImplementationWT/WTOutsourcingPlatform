import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronRight, FileText, Loader2, Search, ShieldAlert, Terminal, Wrench, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AgentState, AiSession } from "@/types/ai";
import Composer from "./Composer";
import Markdown from "./Markdown";
import { AttachmentNames } from "./MarkdownAttachments";
import { confirmAiTool, interruptAi, sendAiMessage } from "./api";
import type { ChatItem, ToolCall } from "./useAiEvents";
import { useMarkdownAttachments } from "./useMarkdownAttachments";

export const textareaClass =
  "w-full min-w-0 resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30";

const TOOL_ICONS: Record<string, typeof Terminal> = { bash: Terminal, read: FileText, write: FileText, edit: FileText, glob: Search, grep: Search };
const TOOL_VERBS: Record<string, string> = { bash: "Ejecutó", read: "Leyó", write: "Escribió", edit: "Editó", glob: "Buscó", grep: "Buscó" };

const failedCall = (call: ToolCall) => call.denied || call.confirmation?.allowed === false || call.result?.ok === false;

function ToolRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICONS[call.tool] ?? Terminal;
  const failed = failedCall(call);
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

/** Pasos técnicos agrupados en una línea ("Trabajó en 5 pasos"); se despliegan para ver el detalle. */
function Steps({ calls, live }: { calls: ToolCall[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const running = live && calls.some((c) => !c.result && !failedCall(c));
  const failed = calls.filter(failedCall).length;
  const last = calls.at(-1)!;
  return (
    <div className="ml-10">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex max-w-full items-center gap-2 rounded-full border border-foreground/10 bg-foreground/[0.03] px-3 py-1 text-xs text-muted-foreground hover:bg-foreground/[0.06]"
      >
        {running ? <Loader2 className="size-3.5 shrink-0 animate-spin text-brand-300" /> : <Wrench className="size-3.5 shrink-0" />}
        <span className="shrink-0">
          {running ? "Trabajando" : "Trabajó"} en {calls.length} paso{calls.length === 1 ? "" : "s"}
          {failed > 0 && <span className="text-red-400"> · {failed} con error</span>}
        </span>
        {!open && (
          <span className="truncate text-foreground/60">
            · {TOOL_VERBS[last.tool] ?? last.tool} {last.summary}
          </span>
        )}
        <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <ul className="mt-2 space-y-0.5 border-l border-foreground/10 pl-2">
          {calls.map((call) => (
            <ToolRow key={call.id} call={call} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Avatar de Will Doo, el bot de WhatEver (la cara del robot, recortada). */
export function WillDooAvatar({ className }: { className?: string }) {
  return (
    <img
      src="/will-doo-avatar.png"
      alt="Will Doo"
      className={cn("size-7 shrink-0 rounded-full border border-foreground/10 bg-[#0b0d18] object-cover", className)}
    />
  );
}

function Message({ item }: { item: Extract<ChatItem, { kind: "user" | "assistant" | "error" }> }) {
  if (item.kind === "error") {
    return (
      <div role="alert" className="ml-10 flex items-start gap-2 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        {item.message}
      </div>
    );
  }
  if (item.kind === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-foreground/[0.07] px-4 py-2.5 text-sm leading-relaxed break-words whitespace-pre-wrap">
          {item.text}
          {item.attachments?.length ? <AttachmentNames names={item.attachments} /> : null}
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-3">
      <WillDooAvatar />
      <div className="min-w-0 flex-1 pt-0.5">
        <Markdown>{item.text}</Markdown>
      </div>
    </div>
  );
}

const STATE_LABEL: Partial<Record<AgentState, string>> = {
  running: "Will Doo está trabajando…",
  waiting: "Will Doo espera tu aprobación para continuar.",
  budget: "Se alcanzó el presupuesto de la sesión.",
  error: "La sesión falló tras varios reintentos. Envía un mensaje para continuar.",
  refused: "Will Doo no puede continuar con esta petición.",
  terminated: "La sesión del agente terminó.",
};

/** Conversación con Will Doo: mensajes, pasos agrupados, aprobaciones y la caja de mensaje. */
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
  const attachments = useMarkdownAttachments();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const active = session.status === "active";
  const running = state === "running";
  const blocked = state === "budget" || state === "waiting";

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
    if (!message && !attachments.files.length) return;
    if (await act(() => sendAiMessage(session.id, message, attachments.files))) {
      setText("");
      attachments.clear();
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto" aria-live="polite">
        <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
          {connection === "connecting" && items.length === 0 && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Conectando con Will Doo…
            </p>
          )}
          {connection === "open" && items.length === 0 && active && (
            <p className="text-center text-sm text-muted-foreground">Escribe abajo qué quieres cambiar. Will Doo trabajará en la rama de esta sesión.</p>
          )}
          {items.map((item, index) =>
            item.kind === "tools" ? <Steps key={item.id} calls={item.calls} live={index === items.length - 1} /> : <Message key={item.id} item={item} />,
          )}

          {pending.map((call) => (
            <div key={call.id} className="ml-10 space-y-2 rounded-xl border border-amber-400/40 bg-amber-500/10 p-3 text-sm">
              <p className="flex items-center gap-2 font-medium">
                <ShieldAlert className="size-4 text-amber-300" />
                Will Doo pide permiso para este paso
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
            <div className="ml-10 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              {running && <Loader2 className="size-4 animate-spin text-brand-300" />}
              {STATE_LABEL[state]}
              {state === "budget" && (
                <Button size="xs" variant="outline" onClick={() => act(onRaiseBudget)} disabled={busy}>
                  Ampliar presupuesto
                </Button>
              )}
            </div>
          )}
          {connection === "lost" && <p className="ml-10 text-xs text-amber-300">Se perdió la conexión con Will Doo. Reconectando…</p>}
          <div ref={bottom} />
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl px-4 pb-4">
        {active ? (
          <>
            {error && (
              <p role="alert" className="mb-2 text-xs text-red-300">
                {error}
              </p>
            )}
            <Composer
              value={text}
              onChange={setText}
              onSubmit={send}
              attachments={attachments}
              busy={busy}
              disabled={blocked}
              onStop={running ? () => void act(() => interruptAi(session.id)) : undefined}
              placeholder={
                running
                  ? "Puedes darle más indicaciones mientras trabaja…"
                  : blocked
                    ? "Resuelve el aviso de arriba para continuar"
                    : "Responde a Will Doo o pide otro cambio…"
              }
            />
            <p className="mt-2 text-center text-[11px] text-muted-foreground">
              Trabaja en la rama <code className="font-mono">{session.branch}</code> · nada llega a producción sin tu aprobación.
            </p>
          </>
        ) : (
          <p className="rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3 text-center text-sm text-muted-foreground">
            {session.status === "merged" ? "Sesión publicada en producción." : "Sesión cerrada."} Empieza una conversación nueva para seguir haciendo
            cambios.
          </p>
        )}
      </div>
    </div>
  );
}
