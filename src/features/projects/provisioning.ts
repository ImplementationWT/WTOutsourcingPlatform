import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "@/lib/api-client";
import type { NewProjectInput } from "./api";

// Contrato de /api/jobs (apps/api/src/jobs/engine.ts → toPublicJob).
export type StageStatus = "pending" | "running" | "succeeded" | "failed";
export type JobStatus = "queued" | "running" | "failed" | "succeeded";

export type SubStepStatus = "pending" | "running" | "done" | "skipped" | "failed";

export interface SubStep {
  id: string;
  label: string;
  status: SubStepStatus;
  detail?: string;
}

export interface JobStage {
  name: string;
  label: string;
  status: StageStatus;
  attempts: number;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  detail: string | null;
  /** Pasos internos (p. ej. MongoDB), en orden de ejecución. */
  steps: SubStep[];
  error: { code: string; message: string; retryable: boolean } | null;
}

export interface Job {
  id: string;
  clientId: string;
  status: JobStatus;
  createdAt: string;
  finishedAt: string | null;
  stages: JobStage[];
}

export function formatDuration(ms: number | null) {
  if (ms === null) return null;
  if (ms < 1_000) return `${ms} ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

export const isFinished = (job: Job | null | undefined) => job?.status === "failed" || job?.status === "succeeded";

export function createClient(input: NewProjectInput) {
  return apiFetch<{ clientId: string; jobId: string }>("/api/clients", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function retryJob(jobId: string) {
  return apiFetch<{ jobId: string; resumeFrom: string | null }>(`/api/jobs/${jobId}/retry`, { method: "POST" });
}

/** Lee el stream NDJSON del trabajo. Termina cuando el servidor cierra la conexión. */
async function readJobStream(jobId: string, onJob: (job: Job) => void, signal: AbortSignal) {
  const response = await fetch(`/api/jobs/${jobId}/events`, { credentials: "same-origin", signal });
  if (!response.ok || !response.body) {
    if (response.status === 401) window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(response.status, "No se pudo seguir el progreso del trabajo.");
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) onJob(JSON.parse(line) as Job);
  }
}

/**
 * Sigue un trabajo en tiempo real. Si la conexión se corta antes de que
 * termine (proxy, red), se reconecta; `generation` fuerza una reconexión
 * (p. ej. tras pulsar Reintentar).
 */
export function useJobStream(jobId: string | null, generation = 0) {
  const queryClient = useQueryClient();
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId) return;
    const controller = new AbortController();
    let last: Job | null = null;

    (async () => {
      for (let attempt = 0; !controller.signal.aborted; attempt++) {
        try {
          await readJobStream(
            jobId,
            (next) => {
              last = next;
              setJob(next);
              setError(null);
              if (isFinished(next)) {
                queryClient.invalidateQueries({ queryKey: ["projects"] });
                queryClient.invalidateQueries({ queryKey: ["client", next.clientId] });
              }
            },
            controller.signal,
          );
          if (isFinished(last)) return;
        } catch (e) {
          if (controller.signal.aborted) return;
          if (e instanceof ApiError && (e.status === 401 || e.status === 404)) {
            setError(e.message);
            return;
          }
          setError("Conexión perdida con el servidor. Reconectando…");
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 1_000 * 2 ** attempt)));
      }
    })();

    return () => controller.abort();
  }, [jobId, generation, queryClient]);

  return { job: jobId ? job : null, error };
}

/** Estado del asistente: envío, seguimiento del trabajo y reintento. */
export function useProvisioning() {
  const [jobId, setJobId] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [submitError, setSubmitError] = useState<{ message: string; existingClientId?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const stream = useJobStream(jobId, generation);

  const start = useCallback(async (input: NewProjectInput) => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { jobId: id } = await createClient(input);
      setJobId(id);
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { clientId?: string } | null) : null;
      setSubmitError({
        message: e instanceof Error ? e.message : "No se pudo crear el proyecto.",
        existingClientId: e instanceof ApiError && e.status === 409 ? body?.clientId : undefined,
      });
    } finally {
      setSubmitting(false);
    }
  }, []);

  const retry = useCallback(async () => {
    if (!jobId) return;
    setSubmitting(true);
    try {
      await retryJob(jobId);
      setGeneration((g) => g + 1);
    } catch (e) {
      setSubmitError({ message: e instanceof Error ? e.message : "No se pudo reintentar." });
    } finally {
      setSubmitting(false);
    }
  }, [jobId]);

  const reset = useCallback(() => {
    setJobId(null);
    setSubmitError(null);
  }, []);

  return { jobId, job: stream.job, streamError: stream.error, submitError, submitting, start, retry, reset };
}
