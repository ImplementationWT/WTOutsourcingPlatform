import { useEffect, useMemo, useState } from "react";
import { ApiError } from "@/lib/api-client";
import type { AgentState, ChatEvent } from "@/types/ai";

/** Lee el NDJSON de eventos del agente hasta que el servidor cierra o se aborta. */
async function readEvents(sessionId: string, onEvent: (event: ChatEvent) => void, signal: AbortSignal) {
  const response = await fetch(`/api/ai/sessions/${encodeURIComponent(sessionId)}/events`, { credentials: "same-origin", signal });
  if (!response.ok || !response.body) {
    if (response.status === 401) window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(response.status, "No se pudo conectar con el agente.");
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) onEvent(JSON.parse(line) as ChatEvent);
  }
}

export type ToolCall = Extract<ChatEvent, { kind: "tool" }> & {
  result?: Extract<ChatEvent, { kind: "tool_result" }>;
  confirmation?: Extract<ChatEvent, { kind: "confirmation" }>;
};

/** Elemento del chat ya agrupado: cada herramienta lleva su resultado y su confirmación. */
export type ChatItem =
  | Extract<ChatEvent, { kind: "user" | "assistant" | "error" }>
  | { id: string; kind: "tools"; calls: ToolCall[] };

/**
 * Chat en vivo de una sesión. Al (re)conectar el servidor reenvía el historial
 * completo; los eventos se deduplican por id. Monta el componente con
 * `key={sessionId}` para empezar de cero al cambiar de sesión.
 */
export function useAiEvents(sessionId: string | null) {
  const [events, setEvents] = useState<Map<string, ChatEvent>>(new Map());
  const [connection, setConnection] = useState<"connecting" | "open" | "lost">("connecting");

  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    (async () => {
      for (let attempt = 0; !controller.signal.aborted; attempt++) {
        setConnection("connecting");
        try {
          await readEvents(
            sessionId,
            (event) => {
              setConnection("open");
              attempt = 0;
              setEvents((current) => (current.has(event.id) ? current : new Map(current).set(event.id, event)));
            },
            controller.signal,
          );
        } catch (e) {
          if (controller.signal.aborted) return;
          if (e instanceof ApiError && (e.status === 401 || e.status === 404 || e.status === 503)) {
            setConnection("lost");
            return;
          }
        }
        if (controller.signal.aborted) return;
        setConnection("lost");
        await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 1_000 * 2 ** attempt)));
      }
    })();
    return () => controller.abort();
  }, [sessionId]);

  return useMemo(() => {
    const list = [...events.values()];
    let state: AgentState = "idle";
    let costCents: number | null = null;
    const items: ChatItem[] = [];
    const calls = new Map<string, ToolCall>();

    for (const event of list) {
      switch (event.kind) {
        case "status":
          state = event.state;
          break;
        case "cost":
          costCents = event.costCents;
          break;
        case "thinking":
          break;
        case "tool": {
          const call: ToolCall = { ...event };
          calls.set(event.id, call);
          const last = items.at(-1);
          if (last?.kind === "tools") last.calls.push(call);
          else items.push({ id: `tools-${event.id}`, kind: "tools", calls: [call] });
          break;
        }
        case "tool_result": {
          const call = calls.get(event.toolUseId);
          if (call) call.result = event;
          break;
        }
        case "confirmation": {
          const call = calls.get(event.toolUseId);
          if (call) call.confirmation = event;
          break;
        }
        default:
          items.push(event);
      }
    }
    const pending = state === "waiting" ? [...calls.values()].filter((c) => c.needsConfirmation && !c.confirmation) : [];
    return { items, state, costCents, pending, connection, loaded: list.length > 0 };
  }, [events, connection]);
}
