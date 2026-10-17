import Anthropic from "@anthropic-ai/sdk";
import type { Collection } from "mongodb";
import { agentDefinition, definitionHash, environmentDefinition } from "./agent-definition.js";
import type { AiAgentAdapter } from "./types.js";

const cents = (amount: { amount: string } | null | undefined) => (amount ? Number.parseInt(amount.amount, 10) || 0 : 0);
const usd = (value: number) => ({ amount: String(Math.max(1, Math.round(value))), currency: "USD" as const });

/** IDs del agente y del entorno creados en la cuenta de Anthropic (colección settings). */
export interface AiAgentSettingsDoc {
  _id: "ai_agent";
  agentId: string;
  agentVersion: number;
  agentHash: string;
  environmentId: string;
  environmentHash: string;
  updatedAt: Date;
}

/**
 * Adaptador real: Claude Managed Agents con el SDK oficial. El agente y su entorno
 * se crean en la cuenta de la clave la primera vez que hacen falta (nada que
 * configurar a mano) y el agente se actualiza si cambia su definición.
 */
export function createAnthropicAgentAdapter(apiKey: string, settings: Collection<AiAgentSettingsDoc>): AiAgentAdapter {
  const client = new Anthropic({ apiKey });
  const sessions = client.beta.sessions;
  let ready: Promise<{ agentId: string; environmentId: string }> | undefined;

  async function provision() {
    const agent = agentDefinition();
    const environment = environmentDefinition();
    const agentHash = definitionHash(agent);
    const environmentHash = definitionHash(environment);
    const current = await settings.findOne({ _id: "ai_agent" });

    let environmentId = current?.environmentId;
    if (!environmentId || current?.environmentHash !== environmentHash) {
      environmentId = (await client.beta.environments.create(environment)).id;
    }

    let agentId = current?.agentId;
    let agentVersion = current?.agentVersion ?? 0;
    if (!agentId) {
      const created = await client.beta.agents.create(agent);
      agentId = created.id;
      agentVersion = created.version;
    } else if (current?.agentHash !== agentHash) {
      // Nueva versión: las sesiones en curso conservan la suya.
      agentVersion = (await client.beta.agents.update(agentId, { ...agent, version: agentVersion })).version;
    }

    await settings.updateOne(
      { _id: "ai_agent" },
      { $set: { agentId, agentVersion, agentHash, environmentId, environmentHash, updatedAt: new Date() } },
      { upsert: true }
    );
    return { agentId, environmentId };
  }

  const ensureReady = () => {
    ready ??= provision().catch((error) => {
      ready = undefined;
      throw error;
    });
    return ready;
  };

  return {
    async createSession(input) {
      const { agentId, environmentId } = await ensureReady();
      const session = await sessions.create({
        agent: agentId,
        environment_id: environmentId,
        title: input.title,
        metadata: input.metadata,
        budget: { type: "limit", max_list_cost: usd(input.budgetCents) },
        resources: [
          {
            type: "github_repository",
            url: input.repoUrl,
            authorization_token: input.repoToken,
            mount_path: input.mountPath,
            checkout: { type: "branch", name: input.branch }
          }
        ]
      });
      const repo = session.resources.find((r) => r.type === "github_repository");
      if (!repo) throw new Error("La sesión no devolvió el repositorio montado.");
      return { id: session.id, repoResourceId: repo.id };
    },

    async sendSystemMessage(sessionId, text) {
      await sessions.events.send(sessionId, { events: [{ type: "system.message", content: [{ type: "text", text }] }] });
    },

    async sendMessage(sessionId, text) {
      await sessions.events.send(sessionId, { events: [{ type: "user.message", content: [{ type: "text", text }] }] });
    },

    async confirmTool(sessionId, toolUseEventId, allow, denyMessage) {
      await sessions.events.send(sessionId, {
        events: [
          allow
            ? { type: "user.tool_confirmation", tool_use_id: toolUseEventId, result: "allow" }
            : { type: "user.tool_confirmation", tool_use_id: toolUseEventId, result: "deny", ...(denyMessage ? { deny_message: denyMessage } : {}) }
        ]
      });
    },

    async interrupt(sessionId) {
      await sessions.events.send(sessionId, { events: [{ type: "user.interrupt" }] });
    },

    async rotateRepoToken(sessionId, resourceId, token) {
      await sessions.resources.update(resourceId, { session_id: sessionId, authorization_token: token });
    },

    async getSession(sessionId) {
      const session = await sessions.retrieve(sessionId);
      return {
        status: session.status,
        costCents: cents(session.usage.list_cost),
        budgetCents: session.budget ? cents(session.budget.max_list_cost) : null
      };
    },

    async setBudget(sessionId, budgetCents) {
      await sessions.update(sessionId, { budget: { type: "limit", max_list_cost: usd(budgetCents) } });
    },

    async *listEvents(sessionId) {
      for await (const event of sessions.events.list(sessionId)) yield event;
    },

    async *streamEvents(sessionId, signal) {
      const stream = await sessions.events.stream(sessionId, undefined, { signal });
      try {
        for await (const event of stream) {
          // Las vistas previas parciales (event_start / event_delta) no se muestran: llega el evento completo.
          if (event.type === "event_start" || event.type === "event_delta") continue;
          yield event;
        }
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
  };
}
