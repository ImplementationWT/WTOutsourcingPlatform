import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, Eye, Loader2, Monitor, Power, RefreshCw, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AiPreview, AiSession } from "@/types/ai";
import { startAiPreview, stopAiPreview, useAiPreview } from "./api";

const STEPS: Partial<Record<AiPreview["status"], string>> = {
  installing: "Preparando el subdominio de la vista previa…",
  building: "Construyendo la rama en GitHub Actions y arrancándola con una base vacía…",
};

/**
 * Vista previa de la rama, embebida. El pase del iframe es de un solo uso: se guarda
 * la primera URL lista y solo se pide otra al recargar (si no, el iframe se recargaría
 * con cada consulta del estado).
 */
export default function PreviewPanel({ session, agentBusy }: { session: AiSession; agentBusy: boolean }) {
  const queryClient = useQueryClient();
  const { data: preview, isLoading } = useAiPreview(session.id);
  const [frame, setFrame] = useState<{ url: string; sha: string | null } | null>(null);
  // Último pase usado: no se reutiliza (ya no vale) mientras llega uno nuevo.
  const [used, setUsed] = useState<string | null>(null);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // La primera vez que está lista (tras recargar, o con commits nuevos), se fija la URL del iframe.
  const ready = preview?.status === "ready" && preview.frameUrl;
  if (ready && preview.frameUrl !== used && (!frame || frame.sha !== preview.sha)) {
    setFrame({ url: preview.frameUrl!, sha: preview.sha });
    setUsed(preview.frameUrl);
  }
  if (!ready && frame) setFrame(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["ai-preview", session.id] });

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setFrame(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo completar la acción.");
    } finally {
      setBusy(false);
    }
  }

  const reload = async () => {
    setFrame(null);
    await refresh();
  };

  if (isLoading) {
    return (
      <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Consultando la vista previa…
      </p>
    );
  }

  const active = session.status === "active";
  const working = preview && (preview.status === "installing" || preview.status === "building");
  const start = (
    <Button size="sm" onClick={() => act(() => startAiPreview(session.id))} disabled={busy || !active || Boolean(working)}>
      {busy ? <Loader2 className="animate-spin" /> : <Eye />}
      {preview && preview.status !== "stopped" ? "Actualizar vista previa" : "Ver vista previa"}
    </Button>
  );

  if (!preview || preview.status === "stopped" || preview.status === "failed") {
    return (
      <div className="space-y-4 p-4 text-sm">
        {preview?.status === "failed" && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-red-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div className="space-y-1">
              <p>{preview.error ?? "La vista previa falló."}</p>
              {preview.runUrl && (
                <a href={preview.runUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
                  Ver el log en GitHub Actions <ExternalLink className="size-3.5" />
                </a>
              )}
            </div>
          </div>
        )}
        <p className="text-muted-foreground">
          Construye la rama de Claude y la abre aquí, en un entorno aislado con una base de datos vacía y temporal. Producción no se toca.
          {preview?.status === "stopped" && " La anterior se apagó por inactividad o al cerrar la sesión."}
        </p>
        {agentBusy && <p className="text-xs text-muted-foreground">Claude sigue trabajando: la vista previa mostrará lo que haya subido hasta ahora.</p>}
        {start}
        {error && (
          <p role="alert" className="text-red-300">
            {error}
          </p>
        )}
      </div>
    );
  }

  if (working) {
    return (
      <div className="space-y-3 p-4 text-sm">
        <p className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin text-violet-300" />
          {STEPS[preview.status]}
        </p>
        <p className="text-xs text-muted-foreground">Suele tardar 2–4 minutos.</p>
        {preview.runUrl && (
          <a href={preview.runUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:underline">
            Seguir en GitHub Actions <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-[28rem] flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-foreground/10 px-3 py-2 text-xs">
        <a href={preview.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-mono text-muted-foreground hover:text-foreground" title="Abrir en otra pestaña (pide el pase de nuevo)">
          {preview.url.replace("https://", "")}
        </a>
        <span className="text-muted-foreground">admin / admin123 · base temporal</span>
        <div className="flex rounded-md border border-foreground/10" role="group" aria-label="Tamaño">
          {(
            [
              ["desktop", Monitor, "Escritorio"],
              ["mobile", Smartphone, "Móvil"],
            ] as const
          ).map(([id, Icon, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={device === id}
              title={label}
              onClick={() => setDevice(id)}
              className={cn("px-1.5 py-1", device === id ? "bg-foreground/10" : "text-muted-foreground hover:text-foreground")}
            >
              <Icon className="size-3.5" />
            </button>
          ))}
        </div>
        <Button size="xs" variant="ghost" onClick={reload} title="Recargar">
          <RefreshCw />
        </Button>
        <Button size="xs" variant="ghost" onClick={() => act(() => stopAiPreview(session.id))} disabled={busy} title="Apagar la vista previa">
          <Power />
        </Button>
      </div>
      {preview.outdated && (
        <div className="flex flex-wrap items-center gap-2 border-b border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs">
          <AlertTriangle className="size-3.5 text-amber-300" />
          Claude subió cambios nuevos después de esta vista previa.
          <Button size="xs" variant="outline" onClick={() => act(() => startAiPreview(session.id))} disabled={busy || agentBusy}>
            Actualizar
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="border-b border-foreground/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1 bg-foreground/[0.03] p-2">
        {frame ? (
          <iframe
            key={frame.url}
            src={frame.url}
            title={`Vista previa de ${session.title}`}
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-downloads"
            referrerPolicy="no-referrer"
            className={cn("mx-auto h-full rounded-md border border-foreground/10 bg-white", device === "mobile" ? "w-[390px] max-w-full" : "w-full")}
          />
        ) : (
          <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Abriendo…
          </p>
        )}
      </div>
    </div>
  );
}
