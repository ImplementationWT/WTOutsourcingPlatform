import type { AiAgentAdapter, CreateAgentSessionInput, MessageAttachment, RawAgentEvent } from "../../src/ai/types.js";

type Listener = (event: RawAgentEvent) => void;

interface FakeSession {
  input: CreateAgentSessionInput;
  events: RawAgentEvent[];
  listeners: Set<Listener>;
  status: "idle" | "running" | "terminated";
  costCents: number;
  budgetCents: number;
  repoToken: string;
}

/**
 * Managed Agents simulado: guarda eventos por sesión y los reemite a los
 * streams abiertos. `onMessage` decide cómo "responde" el agente.
 */
export class FakeAgent implements AiAgentAdapter {
  readonly sessions = new Map<string, FakeSession>();
  readonly systemMessages: { sessionId: string; text: string }[] = [];
  readonly attachments: { sessionId: string; files: readonly MessageAttachment[] }[] = [];
  readonly confirmations: { sessionId: string; toolUseId: string; allow: boolean; denyMessage?: string }[] = [];
  readonly interrupts: string[] = [];
  readonly calls: string[] = [];
  /** Respuesta del agente a cada mensaje (por defecto: un texto y vuelve a idle). */
  onMessage: (sessionId: string, text: string) => void = (sessionId, text) => {
    this.emit(sessionId, { type: "agent.message", content: [{ type: "text", text: `Hecho: ${text}` }] });
    this.emit(sessionId, { type: "session.status_idle", stop_reason: { type: "end_turn" }, stop_details: null });
  };
  failCreate: Error | null = null;
  private seq = 0;

  emit(sessionId: string, event: Record<string, unknown>) {
    const session = this.sessions.get(sessionId)!;
    const full = { id: `sevt_${++this.seq}`, processed_at: new Date().toISOString(), ...event } as unknown as RawAgentEvent;
    session.events.push(full);
    for (const listener of session.listeners) listener(full);
    return full;
  }

  async createSession(input: CreateAgentSessionInput) {
    this.calls.push("createSession");
    if (this.failCreate) throw this.failCreate;
    const id = `sesn_${++this.seq}`;
    this.sessions.set(id, { input, events: [], listeners: new Set(), status: "idle", costCents: 0, budgetCents: input.budgetCents, repoToken: input.repoToken });
    return { id, repoResourceId: `res_${id}` };
  }
  async sendMessage(sessionId: string, text: string, context?: string, attachments: readonly MessageAttachment[] = []) {
    this.calls.push("sendMessage");
    if (context) this.systemMessages.push({ sessionId, text: context });
    if (attachments.length) this.attachments.push({ sessionId, files: attachments });
    const documents = attachments.map((file) => ({ type: "document", title: file.name, source: { type: "text", media_type: "text/plain", data: file.content } }));
    this.emit(sessionId, { type: "user.message", content: [{ type: "text", text }, ...documents] });
    this.onMessage(sessionId, text);
  }
  async confirmTool(sessionId: string, toolUseId: string, allow: boolean, denyMessage?: string) {
    this.confirmations.push({ sessionId, toolUseId, allow, denyMessage });
    this.emit(sessionId, { type: "user.tool_confirmation", tool_use_id: toolUseId, result: allow ? "allow" : "deny" });
  }
  async interrupt(sessionId: string) {
    this.interrupts.push(sessionId);
  }
  async rotateRepoToken(sessionId: string, resourceId: string, token: string) {
    this.calls.push(`rotate:${resourceId}`);
    this.sessions.get(sessionId)!.repoToken = token;
  }
  async getSession(sessionId: string) {
    const s = this.sessions.get(sessionId)!;
    return { status: s.status, costCents: s.costCents, budgetCents: s.budgetCents };
  }
  async setBudget(sessionId: string, budgetCents: number) {
    this.sessions.get(sessionId)!.budgetCents = budgetCents;
  }
  async *listEvents(sessionId: string) {
    for (const event of [...this.sessions.get(sessionId)!.events]) yield event;
  }
  async *streamEvents(sessionId: string, signal: AbortSignal) {
    const session = this.sessions.get(sessionId)!;
    const queue: RawAgentEvent[] = [];
    let wake: (() => void) | undefined;
    const listener: Listener = (event) => {
      queue.push(event);
      wake?.();
    };
    session.listeners.add(listener);
    const onAbort = () => wake?.();
    signal.addEventListener("abort", onAbort);
    try {
      while (!signal.aborted) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
      }
    } finally {
      session.listeners.delete(listener);
      signal.removeEventListener("abort", onAbort);
    }
  }
}
