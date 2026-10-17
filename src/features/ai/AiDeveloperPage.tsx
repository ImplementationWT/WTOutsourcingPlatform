import { type ReactNode, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Bot, ExternalLink, GitBranch, Loader2, Plus, Sparkles, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useClient } from "@/features/projects/api";
import type { AiSession } from "@/types/ai";
import ChangesPanel from "./ChangesPanel";
import ChatPanel, { textareaClass } from "./ChatPanel";
import PreviewPanel from "./PreviewPanel";
import PublishPanel from "./PublishPanel";
import { closeAiSession, formatUsd, raiseAiBudget, startAiSession, useAiSession, useAiSessions, useAiStatus } from "./api";
import { useAiEvents } from "./useAiEvents";

const STATUS_BADGE: Record<AiSession["status"], string> = { active: "Activa", merged: "Desplegada", closed: "Cerrada" };

function NewSession({ slug, onStarted }: { slug: string; onStarted: (session: AiSession) => void }) {
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const { session } = await startAiSession(slug, { title: title.trim(), message: message.trim() || undefined });
      onStarted(session);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo iniciar la sesión.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="size-4 text-violet-300" />
          Nueva sesión
        </CardTitle>
        <CardDescription>
          Claude trabajará en una rama nueva del repositorio, en un entorno aislado. Verás sus cambios en vivo y nada se despliega sin tu aprobación.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="ai-title">Título del cambio</Label>
          <Input id="ai-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="Validaciones en el formulario de registro" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ai-message">Instrucciones para Claude</Label>
          <textarea
            id="ai-message"
            rows={6}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={20_000}
            placeholder="Cambia el formulario de registro: agrega validaciones (email válido, contraseña de 10+ caracteres) y adapta el diseño a los colores del cliente (#0F4C81 y #F2A900)."
            className={textareaClass}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-300">
            {error}
          </p>
        )}
        <Button onClick={start} disabled={busy || title.trim().length < 3}>
          {busy ? <Loader2 className="animate-spin" /> : <Bot />}
          Empezar
        </Button>
      </CardContent>
    </Card>
  );
}

type Tab = "preview" | "changes" | "publish";

function Workspace({ session }: { session: AiSession }) {
  const queryClient = useQueryClient();
  const { data } = useAiSession(session.id);
  const chat = useAiEvents(session.id);
  const [tab, setTab] = useState<Tab>("preview");
  const [closing, setClosing] = useState(false);
  const current = data?.session ?? session;
  const cost = chat.costCents ?? data?.agent?.costCents ?? null;
  const budget = data?.agent?.budgetCents ?? null;

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
        queryClient.invalidateQueries({ queryKey: ["ai-sessions", session.clientId] }),
      ]);
    } finally {
      setClosing(false);
    }
  }

  const tabs: [Tab, string][] = [
    ["preview", "Vista previa"],
    ["changes", "Cambios"],
    ["publish", "Publicar"],
  ];

  return (
    <div className="grid min-h-0 gap-4 lg:h-[calc(100vh-13rem)] lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <Card className="flex min-h-[32rem] flex-col gap-0 overflow-hidden py-0 lg:min-h-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-foreground/10 px-4 py-3">
          <p className="min-w-0 flex-1 truncate font-medium">{current.title}</p>
          <Badge variant="outline">{STATUS_BADGE[current.status]}</Badge>
          {cost !== null && (
            <span className="text-xs text-muted-foreground tabular-nums" title="Gasto a precio de lista de Anthropic">
              {formatUsd(cost)}
              {budget !== null && ` / ${formatUsd(budget)}`}
            </span>
          )}
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
      </Card>

      <Card className="flex min-h-[32rem] flex-col gap-0 overflow-hidden py-0 lg:min-h-0">
        <div className="flex items-center gap-1 border-b border-foreground/10 px-2 py-1.5" role="tablist">
          {tabs.map(([id, label]) => (
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
          <div className="ml-auto flex items-center gap-1">
            {current.consoleUrl && (
              <Button size="xs" variant="ghost" render={<a href={current.consoleUrl} target="_blank" rel="noreferrer" />} nativeButton={false} title="Rastro completo en la consola de Anthropic">
                <ExternalLink />
                Rastro
              </Button>
            )}
            {current.status === "active" && (
              <Button size="xs" variant="ghost" onClick={close} disabled={closing} title="Cerrar sin desplegar">
                {closing ? <Loader2 className="animate-spin" /> : <X />}
                Cerrar sesión
              </Button>
            )}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === "preview" && <PreviewPanel session={current} agentBusy={chat.state === "running"} />}
          {tab === "changes" && <ChangesPanel session={current} />}
          {tab === "publish" && <PublishPanel session={current} agentBusy={chat.state === "running"} />}
        </div>
      </Card>
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 text-sm">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-400" />
        <div>{children}</div>
      </CardContent>
    </Card>
  );
}

/** AI Developer de un proyecto: sesiones, chat en vivo, cambios y publicación. */
export default function AiDeveloperPage() {
  const { slug = "" } = useParams();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const status = useAiStatus();
  const client = useClient(slug);
  const sessions = useAiSessions(slug);
  const [creating, setCreating] = useState(false);

  const list = sessions.data ?? [];
  const selectedId = params.get("sesion");
  const selected = list.find((s) => s.id === selectedId) ?? (creating ? undefined : (list.find((s) => s.status === "active") ?? list[0]));
  const hasActive = list.some((s) => s.status === "active");

  const select = (id: string) => {
    setCreating(false);
    setParams({ sesion: id }, { replace: true });
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link to={`/projects/${slug}`} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-4" />
            {client.data?.client.name ?? slug}
          </Link>
          <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Bot className="size-6 text-violet-300" />
            AI Developer
          </h1>
        </div>
        {list.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="ai-session-select">
              Sesión
            </label>
            <select
              id="ai-session-select"
              value={selected?.id ?? ""}
              onChange={(e) => select(e.target.value)}
              className="h-8 max-w-72 rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30"
            >
              {creating && <option value="">Nueva sesión</option>}
              {list.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} · {STATUS_BADGE[s.status]}
                </option>
              ))}
            </select>
            {!hasActive && !creating && (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus />
                Nueva sesión
              </Button>
            )}
          </div>
        )}
      </div>

      {status.isLoading || sessions.isLoading || client.isLoading ? (
        <Skeleton className="h-96 rounded-xl" />
      ) : !status.data?.enabled ? (
        <Notice>
          El AI Developer no está configurado: falta la clave de la API de Anthropic de la cuenta empresarial en el servidor de la plataforma
          (<code className="font-mono">ANTHROPIC_API_KEY_SECRET_REF</code>). Ver <code className="font-mono">docs/ai-developer.md</code>.
        </Notice>
      ) : client.data?.client.status !== "ready" ? (
        <Notice>El proyecto debe terminar de aprovisionarse antes de usar el AI Developer.</Notice>
      ) : selected ? (
        <>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <GitBranch className="size-3.5" />
            <code className="font-mono">{selected.branch}</code> en {selected.repository} · abierta por {selected.createdBy}
          </p>
          <Workspace key={selected.id} session={selected} />
        </>
      ) : (
        <div className="mx-auto max-w-2xl">
          <NewSession
            slug={slug}
            onStarted={async (session) => {
              await queryClient.invalidateQueries({ queryKey: ["ai-sessions", slug] });
              select(session.id);
            }}
          />
        </div>
      )}
    </section>
  );
}
