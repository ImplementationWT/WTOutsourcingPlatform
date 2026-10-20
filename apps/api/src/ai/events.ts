import { redactString } from "../lib/redact.js";
import type { RawAgentEvent } from "./types.js";

/** Estado del agente que muestra el panel. */
export type AgentState = "running" | "idle" | "waiting" | "budget" | "error" | "refused" | "terminated";

/**
 * Evento del chat tal como lo ve el navegador: sin bloques crudos del SDK, con el
 * texto redactado y las salidas de herramientas recortadas.
 */
export type ChatEvent =
  | { id: string; at: string | null; kind: "user"; text: string; attachments?: string[] }
  | { id: string; at: string | null; kind: "assistant"; text: string }
  | { id: string; at: string | null; kind: "thinking" }
  | { id: string; at: string | null; kind: "tool"; tool: string; summary: string; needsConfirmation: boolean; denied: boolean }
  | { id: string; at: string | null; kind: "tool_result"; toolUseId: string; ok: boolean; output: string }
  | { id: string; at: string | null; kind: "confirmation"; toolUseId: string; allowed: boolean }
  | { id: string; at: string | null; kind: "status"; state: AgentState }
  | { id: string; at: string | null; kind: "error"; message: string }
  | { id: string; at: string | null; kind: "cost"; costCents: number };

const MAX_OUTPUT = 4_000;
const MAX_SUMMARY = 400;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} caracteres más)` : text);
const clean = (text: string, max: number) => clip(redactString(text), max);

function textOf(content: readonly { type: string; text?: string }[] | undefined) {
  return (content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** Títulos de los documentos adjuntos (los .md subidos desde el panel); su contenido no se reenvía. */
function attachmentsOf(content: readonly { type: string; title?: string | null }[] | undefined) {
  return (content ?? [])
    .filter((block) => block.type === "document")
    .map((block) => clip(redactString(block.title || "documento"), 120));
}

const str = (value: unknown) => (typeof value === "string" ? value : "");

/** Una línea legible de lo que hace la herramienta. */
export function summarizeTool(name: string, input: Record<string, unknown>) {
  switch (name) {
    case "bash":
      return `$ ${str(input.command)}`;
    case "read":
    case "write":
    case "edit":
      return str(input.file_path) || str(input.path);
    case "glob":
      return str(input.pattern);
    case "grep":
      return [str(input.pattern), str(input.path)].filter(Boolean).join(" en ");
    default:
      return Object.keys(input).join(", ");
  }
}

const ERROR_MESSAGES: Record<string, string> = {
  model_overloaded_error: "El modelo está saturado; Claude lo reintentará.",
  model_rate_limited_error: "Se alcanzó el límite de peticiones de la cuenta de Anthropic; reintentando.",
  model_request_failed_error: "Falló una petición al modelo.",
  billing_error: "La cuenta de Anthropic no tiene saldo o facturación activa.",
  repository_authentication_error: "GitHub rechazó el acceso al repositorio.",
  repository_forbidden_error: "La GitHub App no tiene permiso sobre el repositorio.",
  repository_not_found_error: "No se encontró el repositorio o la rama.",
  repository_checkout_error: "No se pudo hacer checkout de la rama.",
  repository_clone_error: "No se pudo clonar el repositorio."
};

function stateFromIdle(stopReason: string): AgentState {
  switch (stopReason) {
    case "requires_action":
      return "waiting";
    case "budget_reached":
      return "budget";
    case "retries_exhausted":
      return "error";
    case "refusal":
      return "refused";
    default:
      return "idle";
  }
}

/** Traduce un evento de Managed Agents; null para los que el chat no muestra. */
export function toChatEvent(event: RawAgentEvent): ChatEvent | null {
  const at = "processed_at" in event ? (event.processed_at ?? null) : null;
  const id = event.id;
  switch (event.type) {
    case "user.message": {
      const text = textOf(event.content);
      const attachments = attachmentsOf(event.content);
      if (!text && !attachments.length) return null;
      return { id, at, kind: "user", text: clean(text, 20_000), ...(attachments.length ? { attachments } : {}) };
    }
    case "agent.message": {
      const text = textOf(event.content);
      return text ? { id, at, kind: "assistant", text: clean(text, 50_000) } : null;
    }
    case "agent.thinking":
      return { id, at, kind: "thinking" };
    case "agent.tool_use":
      return {
        id,
        at,
        kind: "tool",
        tool: event.name,
        summary: clean(summarizeTool(event.name, event.input), MAX_SUMMARY),
        needsConfirmation: event.evaluated_permission === "ask",
        denied: event.evaluated_permission === "deny"
      };
    case "agent.tool_result":
      return {
        id,
        at,
        kind: "tool_result",
        toolUseId: event.tool_use_id,
        ok: !event.is_error,
        output: clean(textOf(event.content as { type: string; text?: string }[] | undefined), MAX_OUTPUT)
      };
    case "user.tool_confirmation":
      return { id, at, kind: "confirmation", toolUseId: event.tool_use_id, allowed: event.result === "allow" };
    case "session.status_running":
    case "session.status_rescheduled":
      return { id, at, kind: "status", state: "running" };
    case "session.status_idle":
      return { id, at, kind: "status", state: stateFromIdle(event.stop_reason.type) };
    case "session.status_terminated":
      return { id, at, kind: "status", state: "terminated" };
    case "session.error":
      return { id, at, kind: "error", message: ERROR_MESSAGES[event.error.type] ?? "Error en la sesión del agente." };
    case "session.usage": {
      const amount = event.usage.list_cost?.amount;
      return amount ? { id, at, kind: "cost", costCents: Number.parseInt(amount, 10) || 0 } : null;
    }
    default:
      return null;
  }
}
