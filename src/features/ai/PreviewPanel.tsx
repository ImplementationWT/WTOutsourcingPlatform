import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Eye, Loader2, Monitor, Power, RefreshCw, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AiPreview, AiSession } from "@/types/ai";
import { WillDooAvatar } from "./ChatPanel";
import { startAiPreview, stopAiPreview, useAiPreview } from "./api";

/** Ancho al que se pinta la app en modo escritorio (después se reduce para caber en el panel). */
const DESKTOP_WIDTH = 1280;

const STEPS: Partial<Record<AiPreview["status"], string>> = {
  installing: "Preparando la dirección privada de la vista previa…",
  building: "Arrancando la app en modo desarrollo con una base vacía…",
};

/**
 * Vista previa en vivo, embebida. Arranca sola al abrir la conversación y cada commit
 * nuevo se aplica en caliente (Vite), sin recargar el iframe. El pase del iframe es de un
 * solo uso: se fija la primera URL lista y solo se pide otra al recargar a mano.
 */
export default function PreviewPanel({ session, agentBusy }: { session: AiSession; agentBusy: boolean }) {
  const queryClient = useQueryClient();
  const active = session.status === "active";
  const { data: preview, isLoading } = useAiPreview(session.id, active);
  const [frame, setFrame] = useState<string | null>(null);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  // Tamaño del hueco del iframe: el modo escritorio se pinta a DESKTOP_WIDTH y se escala para caber.
  const [box, setBox] = useState({ width: 0, height: 0 });
  const observer = useRef<ResizeObserver | null>(null);
  const measure = useCallback((element: HTMLDivElement | null) => {
    observer.current?.disconnect();
    if (!element || typeof ResizeObserver === "undefined") return;
    const update = () => setBox({ width: element.clientWidth, height: element.clientHeight });
    update();
    observer.current = new ResizeObserver(update);
    observer.current.observe(element);
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = preview?.status === "ready" && preview.frameUrl;
  if (ready && !frame) setFrame(preview.frameUrl);
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

  // Recargar a mano: pide un pase nuevo (el anterior ya se usó).
  const scale = box.width > 16 ? Math.min(1, (box.width - 18) / DESKTOP_WIDTH) : 1;
  const desktopStyle =
    device === "desktop" && box.width > 16 && scale < 1
      ? { width: DESKTOP_WIDTH, height: (box.height - 18) / scale, transform: `scale(${scale})` }
      : null;

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

  const working = preview && (preview.status === "installing" || preview.status === "building");
  const start = (label: string) => (
    <Button size="sm" variant="outline" onClick={() => act(() => startAiPreview(session.id))} disabled={busy || !active || Boolean(working)}>
      {busy ? <Loader2 className="animate-spin" /> : <Eye />}
      {label}
    </Button>
  );

  if (!preview || preview.status === "stopped" || preview.status === "failed") {
    return (
      <div className="space-y-4 p-6 text-sm">
        {preview?.status === "failed" && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-red-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <p className="whitespace-pre-wrap">{preview.error ?? "La vista previa no arrancó."}</p>
          </div>
        )}
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <WillDooAvatar className="size-12" />
          <p className="max-w-sm text-muted-foreground">
            {preview?.status === "stopped"
              ? "La vista previa se apagó. Ábrela de nuevo para ver los últimos cambios."
              : preview?.status === "failed"
                ? "Pide a Will Doo que lo arregle o vuelve a intentarlo."
                : active
                  ? "Preparando la vista previa: la app en vivo, con una base de datos vacía y sin tocar producción. Cada cambio de Will Doo se verá aquí al momento."
                  : "La sesión está cerrada."}
          </p>
          {active && start(preview ? "Abrir vista previa" : "Abrirla ya")}
          {agentBusy && !preview && <p className="text-xs text-muted-foreground">Will Doo está trabajando…</p>}
        </div>
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
      <div className="flex flex-col items-center gap-3 p-10 text-center text-sm">
        <Loader2 className="size-6 animate-spin text-brand-300" />
        <p>{STEPS[preview.status]}</p>
        <p className="text-xs text-muted-foreground">La primera vez tarda 1–2 minutos (instala dependencias). Después, cada cambio se ve en segundos.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-[28rem] flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-foreground/10 px-3 py-2 text-xs">
        <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-300">
          <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />
          En vivo
        </span>
        <a
          href={preview.url}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 flex-1 truncate font-mono text-muted-foreground hover:text-foreground"
          title="Abrir en otra pestaña (pide el pase de nuevo)"
        >
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
        <Button size="xs" variant="ghost" onClick={reload} title="Recargar la página">
          <RefreshCw />
        </Button>
        <Button size="xs" variant="ghost" onClick={() => act(() => stopAiPreview(session.id))} disabled={busy} title="Apagar la vista previa">
          <Power />
        </Button>
      </div>
      {(preview.updating || preview.outdated) && (
        <div className="flex items-center gap-2 border-b border-brand-400/20 bg-brand-500/10 px-3 py-1.5 text-xs text-brand-200">
          <Loader2 className="size-3.5 animate-spin" />
          Aplicando los últimos cambios de Will Doo…
        </div>
      )}
      {preview.updateError && !preview.updating && (
        <div role="alert" className="flex items-center gap-2 border-b border-amber-400/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200">
          <AlertTriangle className="size-3.5 shrink-0" />
          No se pudieron traer los últimos cambios: {preview.updateError}
        </div>
      )}
      {error && (
        <p role="alert" className="border-b border-foreground/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}
      <div ref={measure} className="min-h-0 flex-1 overflow-hidden bg-foreground/[0.03] p-2">
        {frame ? (
          // Siempre el mismo iframe (cambiar de elemento lo recargaría con un pase ya usado): solo
          // cambian su tamaño y su escala. Escritorio: la app ve 1280 px (su diseño de PC) y se
          // reduce para caber en el panel.
          <div
            className={cn(
              "mx-auto h-full overflow-hidden rounded-md border border-foreground/10 bg-white",
              device === "mobile" ? "w-[390px] max-w-full" : "w-full",
            )}
          >
            <iframe
              key={frame}
              src={frame}
              title={`Vista previa de ${session.title}`}
              sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-downloads"
              referrerPolicy="no-referrer"
              className="origin-top-left border-0"
              style={desktopStyle ?? { width: "100%", height: "100%" }}
            />
          </div>
        ) : (
          <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Abriendo…
          </p>
        )}
      </div>
    </div>
  );
}
