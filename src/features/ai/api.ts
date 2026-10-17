import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import type { AgentUsage, AiReview, AiSession, BranchDiff } from "@/types/ai";

const sessionUrl = (id: string, path = "") => `/api/ai/sessions/${encodeURIComponent(id)}${path}`;
const post = <T>(url: string, body?: unknown) =>
  apiFetch<T>(url, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export function useAiStatus() {
  return useQuery({
    queryKey: ["ai-status"],
    queryFn: () => apiFetch<{ enabled: boolean; model: string }>("/api/ai/status"),
    staleTime: 5 * 60_000,
  });
}

export function useAiSessions(slug: string) {
  return useQuery({
    queryKey: ["ai-sessions", slug],
    queryFn: async () => (await apiFetch<{ sessions: AiSession[] }>(`/api/clients/${encodeURIComponent(slug)}/ai/sessions`)).sessions,
  });
}

/** Sesión y gasto del agente; el gasto se refresca cada 15 s mientras la sesión está activa. */
export function useAiSession(id: string | null) {
  return useQuery({
    queryKey: ["ai-session", id],
    queryFn: () => apiFetch<{ session: AiSession; agent: AgentUsage | null }>(sessionUrl(id!)),
    enabled: Boolean(id),
    refetchInterval: (query) => (query.state.data?.session.status === "active" ? 15_000 : false),
  });
}

export function useAiDiff(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["ai-diff", id],
    queryFn: () => apiFetch<BranchDiff>(sessionUrl(id!, "/diff")),
    enabled: Boolean(id) && enabled,
  });
}

/** PR y validaciones; mientras hay checks en curso se consulta cada 10 s. */
export function useAiReview(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["ai-review", id],
    queryFn: () => apiFetch<AiReview>(sessionUrl(id!, "/review")),
    enabled: Boolean(id) && enabled,
    refetchInterval: (query) => {
      const data = query.state.data;
      const waiting = data?.pullRequest?.state === "open" && (!data.checks || data.checks.total === 0 || data.checks.pending > 0);
      return waiting ? 10_000 : false;
    },
  });
}

export const startAiSession = (slug: string, input: { title: string; message?: string }) =>
  post<{ session: AiSession }>(`/api/clients/${encodeURIComponent(slug)}/ai/sessions`, input);
export const sendAiMessage = (id: string, text: string) => post<{ ok: true }>(sessionUrl(id, "/messages"), { text });
export const confirmAiTool = (id: string, toolUseId: string, allow: boolean) =>
  post<{ ok: true }>(sessionUrl(id, "/confirm"), { toolUseId, allow });
export const interruptAi = (id: string) => post<{ ok: true }>(sessionUrl(id, "/interrupt"));
export const raiseAiBudget = (id: string) => post<{ budgetCents: number }>(sessionUrl(id, "/budget"));
export const createAiPullRequest = (id: string) => post<{ pullRequest: AiSession["pullRequest"] }>(sessionUrl(id, "/pull-request"));
export const mergeAiSession = (id: string) =>
  post<{ sha: string; deploying: boolean; actionsUrl: string }>(sessionUrl(id, "/merge"), { confirm: true });
export const closeAiSession = (id: string) => post<{ ok: true }>(sessionUrl(id, "/close"));

export const formatUsd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
