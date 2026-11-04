import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Pin, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-context";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api-client";
import { errorText, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

export type ViewScreen = "projects";
export interface SavedView {
  id: string;
  name: string;
  query: string;
}

const send = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });
const key = (screen: ViewScreen) => ["views", screen] as const;

/** Estado de la tabla en la URL, sin la página y en orden estable (para comparar vistas). */
function viewQuery(params: URLSearchParams) {
  const next = new URLSearchParams([...params.entries()].filter(([k]) => k !== "page").sort(([a], [b]) => a.localeCompare(b)));
  return next.toString();
}

/** Nombre editable en línea: deja borrar todo mientras se escribe y guarda al salir o con Enter. */
function NameInput({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const [draft, setDraft] = useState(initial);
  const finish = () => onDone(draft.trim() || null);
  return (
    <Input
      autoFocus
      aria-label="Nombre de la vista"
      className="h-9 w-44"
      value={draft}
      maxLength={40}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") onDone(null);
      }}
    />
  );
}

/**
 * Vistas guardadas de una tabla (por persona): cada una guarda filtros, orden y agrupación de la
 * URL. Se renombran, se actualizan con los filtros actuales o se eliminan desde su menú.
 */
export function SavedViews({ screen }: { screen: ViewScreen }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const views = useQuery({ queryKey: key(screen), queryFn: async () => (await apiFetch<{ views: SavedView[] }>(`/api/views?screen=${screen}`)).views }).data ?? [];
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const current = viewQuery(params);
  const active = views.find((v) => v.id === selected) ?? views.find((v) => v.query === current) ?? null;
  const dirty = Boolean(active && active.query !== current);
  const refresh = () => queryClient.invalidateQueries({ queryKey: key(screen) });

  const run = async (action: () => Promise<unknown>, message: string) => {
    try {
      await action();
      await refresh();
    } catch (err) {
      toast.error(message, { description: errorText(err, "Inténtalo de nuevo.") });
    }
  };
  const apply = (view: SavedView) => {
    setSelected(view.id);
    setParams(new URLSearchParams(view.query), { replace: true });
  };
  const create = (name: string | null) => {
    setEditing(null);
    if (!name) return;
    void run(async () => {
      const { view } = await apiFetch<{ view: SavedView }>("/api/views", send("POST", { screen, name, query: current }));
      setSelected(view.id);
    }, "No se pudo crear la vista.");
  };
  const rename = (view: SavedView, name: string | null) => {
    setEditing(null);
    if (name && name !== view.name) void run(() => apiFetch(`/api/views/${view.id}`, send("PATCH", { name })), "No se pudo renombrar la vista.");
  };
  const saveCurrent = (view: SavedView) => void run(() => apiFetch(`/api/views/${view.id}`, send("PATCH", { query: current })).then(() => toast.success(`Vista actualizada · ${view.name}`)), "No se pudo guardar la vista.");
  const remove = async (view: SavedView) => {
    if (!(await confirm({ title: `¿Eliminar la vista «${view.name}»?`, description: "Solo se borra la vista; los proyectos no cambian.", confirmLabel: "Eliminar vista", tone: "danger" }))) return;
    if (selected === view.id) setSelected(null);
    await run(() => apiFetch(`/api/views/${view.id}`, send("DELETE")), "No se pudo eliminar la vista.");
  };

  return (
    <div role="tablist" aria-label="Vistas guardadas" className="flex flex-wrap items-center gap-x-1 gap-y-1 border-b border-border">
      {views.map((view) => {
        const on = active?.id === view.id;
        return (
          <div key={view.id} className={cn("-mb-px flex items-center border-b-2", on ? "border-primary" : "border-transparent")}>
            {editing === view.id ? (
              <NameInput initial={view.name} onDone={(name) => rename(view, name)} />
            ) : (
              <button
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => apply(view)}
                className={cn("inline-flex h-11 items-center gap-2 px-3 text-sm whitespace-nowrap transition-colors", on ? "font-semibold text-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                <Pin className="size-3.5" aria-hidden />
                {view.name}
              </button>
            )}
            {on && editing !== view.id && (
              <DropdownMenu>
                <DropdownMenuTrigger aria-label={`Opciones de la vista ${view.name}`} className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground">
                  <MoreHorizontal className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" sideOffset={6} className="w-56">
                  <DropdownMenuItem onClick={() => setEditing(view.id)}>Renombrar</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => saveCurrent(view)}>Guardar filtros actuales</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => void remove(view)}>
                    Eliminar vista
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        );
      })}
      {editing === "new" ? (
        <NameInput initial="Nueva vista" onDone={create} />
      ) : (
        <button type="button" onClick={() => setEditing("new")} className="inline-flex h-11 items-center gap-1.5 px-3 text-sm font-semibold text-primary hover:opacity-80">
          <Plus className="size-4" aria-hidden />
          Nueva vista
        </button>
      )}
      {dirty && active && (
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => saveCurrent(active)}>
          Guardar cambios en la vista
        </Button>
      )}
    </div>
  );
}
