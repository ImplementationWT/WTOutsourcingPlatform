import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Loader2, Menu, PanelRightOpen, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { applyTheme, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useClient } from "@/features/projects/api";
import type { AiSession } from "@/types/ai";
import ChangesPanel from "./ChangesPanel";
import ChatPanel, { WillDooAvatar } from "./ChatPanel";
import PreviewPanel from "./PreviewPanel";
import PublishPanel from "./PublishPanel";
import SessionSidebar from "./SessionSidebar";
import Welcome from "./Welcome";
import {
  closeAiSession,
  deleteAiSession,
  deleteAllAiSessions,
  formatUsd,
  raiseAiBudget,
  startAiPreview,
  useAiPreview,
  useAiSession,
  useAiSessions,
  useAiStatus,
} from "./api";
import { useAiEvents } from "./useAiEvents";

const STATUS_BADGE: Record<AiSession["status"], string> = { active: "En curso", merged: "Publicada", closed: "Cerrada" };

type Tab = "preview" | "changes" | "publish";
const TABS: [Tab, string][] = [
  ["preview", "Vista previa"],
  ["changes", "Cambios"],
  ["publish", "Publicar"],
];

/** Panel de trabajo: vista previa, cambios en el código y publicación. */
function WorkPanel({ session, agentBusy, onClose }: { session: AiSession; agentBusy: boolean; onClose?: () => void }) {
  const [tab, setTab] = useState<Tab>("preview");
  return (
    <div className="flex h-full min-h-0 flex-col bg-background/90 backdrop-blur-xl">
      <div className="flex items-center gap-1 border-b border-foreground/10 px-2 py-1.5" role="tablist">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors",
              tab === id ? "bg-foreground/10 font-medium" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
        {onClose && (
          <Button size="icon-sm" variant="ghost" className="ml-auto lg:hidden" onClick={onClose} aria-label="Cerrar panel">
            <X />
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "preview" && <PreviewPanel session={session} agentBusy={agentBusy} />}
        {tab === "changes" && <ChangesPanel session={session} />}
        {tab === "publish" && <PublishPanel session={session} agentBusy={agentBusy} />}
      </div>
    </div>
  );
}

/**
 * Una conversación: cabecera, chat y el panel de trabajo a la derecha (siempre visible en
 * pantallas grandes; en estrechas se abre encima del chat con su icono).
 */
function SessionView({ session }: { session: AiSession }) {
  const queryClient = useQueryClient();
  const [mobilePanel, setMobilePanel] = useState(false);
  const { data } = useAiSession(session.id);
  const chat = useAiEvents(session.id);
  const [closing, setClosing] = useState(false);
  const current = data?.session ?? session;
  const cost = chat.costCents ?? data?.agent?.costCents ?? null;
  const budget = data?.agent?.budgetCents ?? null;
  const agentBusy = chat.state === "running";
  const active = current.status === "active";

  // La vista previa aparece al abrir la conversación: la consulta la arranca y la mantiene al
  // día con cada commit (también con el panel cerrado en el móvil).
  const preview = useAiPreview(session.id, active);
  const opened = useRef(false);
  useEffect(() => {
    if (!active || opened.current || preview.isLoading) return;
    opened.current = true;
    // Apagada a mano en otra visita: al volver a entrar se enciende de nuevo.
    if (preview.data?.status === "stopped") {
      void startAiPreview(session.id)
        .then(() => queryClient.invalidateQueries({ queryKey: ["ai-preview", session.id] }))
        .catch(() => undefined);
    }
  }, [active, preview.isLoading, preview.data?.status, session.id, queryClient]);

  async function raiseBudget() {
    await raiseAiBudget(session.id);
    await queryClient.invalidateQueries({ queryKey: ["ai-session", session.id] });
  }

  async function close() {
    setClosing(true);
    try {
      await closeAiSession(session.id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["ai-session", session.id] }),
        queryClient.invalidateQueries({ queryKey: ["ai-sessions"] }),
      ]);
    } finally {
      setClosing(false);
    }
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-foreground/10 px-4 py-2">
          <p className="min-w-0 flex-1 truncate text-sm font-medium" title={current.title}>
            {current.title}
          </p>
          <Badge variant="outline">{STATUS_BADGE[current.status]}</Badge>
          {cost !== null && (
            <span className="text-xs text-muted-foreground tabular-nums" title="Gasto de esta conversación a precio de lista de Anthropic">
              {formatUsd(cost)}
              {budget !== null && ` / ${formatUsd(budget)}`}
            </span>
          )}
          {current.status === "active" && (
            <Button size="xs" variant="ghost" onClick={close} disabled={closing} title="Cerrar sin publicar">
              {closing ? <Loader2 className="animate-spin" /> : <X />}
              Cerrar
            </Button>
          )}
          <Button size="icon-xs" variant="ghost" className="lg:hidden" onClick={() => setMobilePanel(true)} aria-label="Vista previa">
            <PanelRightOpen />
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <ChatPanel
            session={current}
            items={chat.items}
            state={chat.state}
            pending={chat.pending}
            connection={chat.connection}
            onRaiseBudget={raiseBudget}
          />
        </div>
      </div>

      {mobilePanel && (
        <button type="button" aria-label="Cerrar panel" className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={() => setMobilePanel(false)} />
      )}
      <aside
        className={cn(
          "fixed inset-y-0 right-0 z-40 w-full border-l border-foreground/10 sm:w-[34rem] lg:static lg:z-auto lg:block lg:w-[52%] xl:w-[56%]",
          mobilePanel ? "block" : "hidden",
        )}
      >
        <WorkPanel session={current} agentBusy={agentBusy} onClose={() => setMobilePanel(false)} />
      </aside>
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex max-w-xl items-start gap-3 rounded-xl border border-warn/30 bg-warn/10 p-4 text-sm">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warn-fg" />
        <div>{children}</div>
      </div>
    </div>
  );
}

/**
 * AI Developer como consola a pantalla completa, al estilo de Claude: conversaciones a la
 * izquierda, chat en el centro y vista previa / cambios / publicar a la derecha.
 */
export default function AiDeveloperPage() {
  const { slug = "" } = useParams();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const { theme } = useTheme();
  useEffect(() => applyTheme(theme), [theme]);

  const status = useAiStatus();
  const client = useClient(slug);
  const sessions = useAiSessions(slug);
  const [creating, setCreating] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const list = sessions.data ?? [];
  const projectName = client.data?.client.name ?? slug;
  const selectedId = params.get("sesion");
  const selected = creating ? undefined : (list.find((s) => s.id === selectedId) ?? list.find((s) => s.status === "active") ?? list[0]);
  const hasActive = list.some((s) => s.status === "active");

  const select = (id: string) => {
    setCreating(false);
    setSidebarOpen(false);
    setParams({ sesion: id }, { replace: true });
  };
  const startNew = () => {
    setCreating(true);
    setSidebarOpen(false);
  };
  const refreshSessions = () => queryClient.invalidateQueries({ queryKey: ["ai-sessions", slug] });

  const loading = status.isLoading || sessions.isLoading || client.isLoading;
  let body: ReactNode;
  if (loading) {
    body = (
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <Skeleton className="h-10 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  } else if (!status.data?.enabled) {
    body = (
      <Notice>
        El AI Developer no está configurado: falta la clave de la API de Anthropic de la cuenta empresarial en el servidor de la plataforma (
        <code className="font-mono">ANTHROPIC_API_KEY_SECRET_REF</code>). Ver <code className="font-mono">docs/ai-developer.md</code>.
      </Notice>
    );
  } else if (status.data.missingPermissions?.length) {
    body = (
      <Notice>
        <p className="font-medium">A la GitHub App le faltan permisos para el AI Developer</p>
        <ul className="mt-1 list-disc pl-5">
          {status.data.missingPermissions.map((permission) => (
            <li key={permission}>
              <code className="font-mono">{permission}</code>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-muted-foreground">
          Añádelos en GitHub → Settings → Developer settings → GitHub Apps → la App → Permissions & events, guarda y acepta la solicitud de permisos en
          la instalación (Settings → Applications). Después recarga esta página.
        </p>
      </Notice>
    );
  } else if (client.data?.client.status !== "ready") {
    body = <Notice>El proyecto debe terminar de aprovisionarse antes de usar el AI Developer.</Notice>;
  } else if (selected) {
    body = <SessionView key={selected.id} session={selected} />;
  } else {
    body = (
      <Welcome
        slug={slug}
        projectName={projectName}
        onStarted={async (session) => {
          await refreshSessions();
          select(session.id);
        }}
        onFailed={() => void refreshSessions()}
      />
    );
  }

  const sidebar = (onClose?: () => void) => (
    <SessionSidebar
      sessions={list}
      selectedId={selected?.id ?? null}
      creating={!selected && !loading}
      canCreate={!hasActive && !creating}
      onSelect={select}
      onNew={startNew}
      onDelete={async (id) => {
        await deleteAiSession(id);
        if (id === selected?.id) setParams({}, { replace: true });
        await refreshSessions();
      }}
      onDeleteAll={async () => {
        await deleteAllAiSessions(slug);
        setParams({}, { replace: true });
        await refreshSessions();
      }}
      onClose={onClose}
    />
  );

  return (
    <div className="flex h-svh flex-col bg-[radial-gradient(ellipse_at_top,#ede9fe_0%,#f6f5fb_45%,#ffffff_100%)] text-foreground dark:bg-[radial-gradient(ellipse_at_top,#1e1b4b_0%,#0b0a1f_45%,#020617_100%)]">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-foreground/10 px-3">
        <Button size="icon-sm" variant="ghost" className="md:hidden" onClick={() => setSidebarOpen(true)} aria-label="Conversaciones">
          <Menu />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          render={<Link to={`/projects/${slug}`} />}
          nativeButton={false}
          aria-label={`Volver a ${projectName}`}
          className="hidden md:inline-flex"
        >
          <ArrowLeft />
        </Button>
        <WillDooAvatar className="size-7" />
        <p className="min-w-0 truncate text-sm">
          <span className="font-medium">Will Doo</span>
          <span className="text-muted-foreground"> · {projectName}</span>
        </p>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="hidden md:block">{sidebar()}</div>
        {sidebarOpen && (
          <>
            <button type="button" aria-label="Cerrar lista" className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setSidebarOpen(false)} />
            <div className="fixed inset-y-0 left-0 z-40 md:hidden">{sidebar(() => setSidebarOpen(false))}</div>
          </>
        )}
        <main className="min-w-0 flex-1">{body}</main>
      </div>
    </div>
  );
}
