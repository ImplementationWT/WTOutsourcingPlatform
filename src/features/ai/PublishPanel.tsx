import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, CircleDashed, ExternalLink, GitMerge, GitPullRequest, Loader2, Rocket, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AiSession } from "@/types/ai";
import { createAiPullRequest, mergeAiSession, useAiReview } from "./api";

/** Revisión y publicación: Pull Request, validaciones de CI y merge (despliega). */
export default function PublishPanel({ session, agentBusy }: { session: AiSession; agentBusy: boolean }) {
  const queryClient = useQueryClient();
  const { data: review, isLoading } = useAiReview(session.id, true);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ deploying: boolean; actionsUrl: string } | null>(null);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["ai-session", session.id] }),
      queryClient.invalidateQueries({ queryKey: ["ai-review", session.id] }),
      queryClient.invalidateQueries({ queryKey: ["ai-sessions", session.clientId] }),
    ]);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo completar la acción.");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (isLoading || !review) {
    return (
      <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Consultando GitHub…
      </p>
    );
  }

  const pr = review.pullRequest;
  const checks = review.checks;
  const checksOk = Boolean(checks && checks.total > 0 && checks.pending === 0 && checks.failed === 0);
  const canMerge = session.status === "active" && pr?.state === "open" && pr.mergeable !== false && checksOk && !agentBusy;

  return (
    <div className="space-y-5 p-4 text-sm">
      {review.mainTouched && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-400/40 bg-red-500/10 p-3 text-red-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          Hay commits del agente directamente en main. Revísalos en GitHub: main despliega a producción.
        </div>
      )}

      <ol className="space-y-4">
        <li className="flex gap-3">
          <GitPullRequest className="mt-0.5 size-4 shrink-0 text-violet-300" />
          <div className="min-w-0 flex-1 space-y-2">
            <p className="font-medium">1. Pull Request</p>
            {pr ? (
              <a href={pr.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                #{pr.number} · {pr.merged ? "fusionado" : pr.state === "open" ? "abierto" : "cerrado"}
                <ExternalLink className="size-3.5" />
              </a>
            ) : (
              <>
                <p className="text-muted-foreground">Cuando el resultado en la vista previa te convenza, crea el PR: GitHub ejecutará las validaciones.</p>
                <Button size="sm" onClick={() => act(async () => void (await createAiPullRequest(session.id)))} disabled={busy || session.status !== "active"}>
                  {busy ? <Loader2 className="animate-spin" /> : <GitPullRequest />}
                  Crear Pull Request
                </Button>
              </>
            )}
          </div>
        </li>

        <li className="flex gap-3">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-violet-300" />
          <div className="min-w-0 flex-1 space-y-2">
            <p className="font-medium">2. Validaciones (lint, tests, build)</p>
            {!pr ? (
              <p className="text-muted-foreground">Se ejecutan al crear el PR.</p>
            ) : !checks || checks.total === 0 ? (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Esperando a que GitHub las inicie…
              </p>
            ) : (
              <ul className="space-y-1">
                {checks.checks.map((check) => (
                  <li key={check.name} className="flex items-center gap-2">
                    {check.status !== "completed" ? (
                      <Loader2 className="size-3.5 animate-spin text-sky-300" />
                    ) : ["success", "skipped", "neutral"].includes(check.conclusion ?? "") ? (
                      <CheckCircle2 className="size-3.5 text-emerald-400" />
                    ) : (
                      <XCircle className="size-3.5 text-red-400" />
                    )}
                    {check.url ? (
                      <a href={check.url} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
                        {check.name}
                      </a>
                    ) : (
                      check.name
                    )}
                  </li>
                ))}
              </ul>
            )}
            {checks && checks.failed > 0 && <p className="text-red-300">Pide a Claude en el chat que corrija los fallos; las validaciones se repiten con cada push.</p>}
          </div>
        </li>

        <li className="flex gap-3">
          <Rocket className="mt-0.5 size-4 shrink-0 text-violet-300" />
          <div className="min-w-0 flex-1 space-y-2">
            <p className="font-medium">3. Aprobar y desplegar</p>
            {session.status === "merged" || result ? (
              <p className="flex flex-wrap items-center gap-2 text-emerald-300">
                <GitMerge className="size-4" />
                Fusionado en main{(result?.deploying ?? true) ? ": el despliegue a producción está en marcha." : "."}
                {result && (
                  <a href={result.actionsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted-foreground underline-offset-4 hover:underline">
                    Ver en GitHub Actions <ExternalLink className="size-3.5" />
                  </a>
                )}
              </p>
            ) : confirming ? (
              <div className="space-y-2 rounded-lg border border-amber-400/40 bg-amber-500/10 p-3">
                <p>Se fusionará el PR en main y se desplegará a producción para el cliente. ¿Continuar?</p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => act(async () => setResult(await mergeAiSession(session.id)))} disabled={busy}>
                    {busy ? <Loader2 className="animate-spin" /> : <GitMerge />}
                    Sí, fusionar y desplegar
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
                    Cancelar
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <Button size="sm" onClick={() => setConfirming(true)} disabled={!canMerge || busy}>
                  <GitMerge />
                  Aprobar y desplegar
                </Button>
                {!canMerge && pr?.state === "open" && (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <CircleDashed className="size-3.5" />
                    {agentBusy
                      ? "Espera a que Claude termine."
                      : pr.mergeable === false
                        ? "El PR tiene conflictos con main."
                        : "Disponible cuando todas las validaciones estén en verde."}
                  </p>
                )}
              </>
            )}
          </div>
        </li>
      </ol>

      {error && (
        <p role="alert" className="text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
