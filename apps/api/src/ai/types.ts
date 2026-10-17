import type Anthropic from "@anthropic-ai/sdk";

/** Evento tal como llega de Managed Agents (historial o stream). */
export type RawAgentEvent = Anthropic.Beta.Sessions.BetaManagedAgentsSessionEvent;

export type AgentSessionStatus = "rescheduling" | "running" | "idle" | "terminated";

export interface CreateAgentSessionInput {
  title: string;
  /** https://github.com/<owner>/<repo> */
  repoUrl: string;
  branch: string;
  mountPath: string;
  /** Token de instalación limitado a ese repo; Anthropic no lo pone nunca en el sandbox. */
  repoToken: string;
  /** Tope de gasto de la sesión, en centavos de USD. */
  budgetCents: number;
  metadata: Record<string, string>;
}

/**
 * Lo que la plataforma usa de Claude Managed Agents. Cada sesión corre en un
 * contenedor aislado de Anthropic: el código que ejecuta el agente nunca toca el VPS.
 */
export interface AiAgentAdapter {
  createSession(input: CreateAgentSessionInput): Promise<{ id: string; repoResourceId: string }>;
  /**
   * Mensaje del usuario. `context` (contexto de la sesión, con autoridad de sistema) va como
   * system.message justo detrás y en la misma petición: Anthropic no lo acepta suelto.
   */
  sendMessage(sessionId: string, text: string, context?: string): Promise<void>;
  confirmTool(sessionId: string, toolUseEventId: string, allow: boolean, denyMessage?: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  /** Los tokens de instalación caducan en 1 h: se renuevan antes de cada mensaje. */
  rotateRepoToken(sessionId: string, resourceId: string, token: string): Promise<void>;
  getSession(sessionId: string): Promise<{ status: AgentSessionStatus; costCents: number; budgetCents: number | null }>;
  setBudget(sessionId: string, budgetCents: number): Promise<void>;
  listEvents(sessionId: string): AsyncIterable<RawAgentEvent>;
  /** Eventos en vivo hasta que se aborte `signal`. */
  streamEvents(sessionId: string, signal: AbortSignal): AsyncIterable<RawAgentEvent>;
}

export interface AiConfig {
  /** Tope de gasto por sesión (y por ampliación), en centavos de USD. */
  sessionBudgetCents: number;
  /** Workspace de la consola de Anthropic, para enlazar el rastro de la sesión. */
  workspace: string;
}
