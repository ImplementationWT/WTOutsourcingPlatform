import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Save, Tag, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ProjectRepo } from "@/types/project";
import { updateProjectTopics } from "./api";
import { normalizeTag } from "./filters";

const MAX_TOPICS = 20;

/**
 * Etiquetas de un proyecto (topics de GitHub). Pulsar una etiqueta la añade al filtro;
 * "Editar" permite añadir y quitar, y se guarda en GitHub.
 */
export default function TopicsEditor({
  repo,
  activeTags,
  onToggleTag,
  editable = true,
}: {
  repo: ProjectRepo;
  activeTags: string[];
  onToggleTag: (tag: string) => void;
  /** Repos sin proyecto de la plataforma: sus etiquetas no se editan desde aquí. */
  editable?: boolean;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function start() {
    setDraft(repo.topics);
    setInput("");
    setError(null);
    setEditing(true);
  }

  function add() {
    const tag = normalizeTag(input);
    setInput("");
    if (!tag || draft.includes(tag)) return;
    if (draft.length >= MAX_TOPICS) return setError(`Máximo ${MAX_TOPICS} etiquetas por proyecto.`);
    setDraft([...draft, tag]);
  }

  async function save() {
    // Lo escrito sin pulsar Enter también cuenta.
    const pending = normalizeTag(input);
    const topics = pending && !draft.includes(pending) ? [...draft, pending] : draft;
    setBusy(true);
    setError(null);
    try {
      const result = await updateProjectTopics(repo.name, topics);
      queryClient.setQueriesData<ProjectRepo[]>({ queryKey: ["projects"] }, (projects) =>
        projects?.map((p) => (p.id === repo.id ? { ...p, topics: result.topics } : p)),
      );
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudieron guardar las etiquetas.");
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {repo.topics.map((tag) => {
          const active = activeTags.includes(tag);
          return (
            <button
              key={tag}
              type="button"
              onClick={() => onToggleTag(tag)}
              aria-pressed={active}
              title={active ? `Quitar "${tag}" del filtro` : `Filtrar por "${tag}"`}
              className={cn(
                "rounded-full border px-2 py-0.5 text-xs transition-colors",
                active
                  ? "border-violet-400/60 bg-violet-500/20 text-violet-200"
                  : "border-foreground/15 text-muted-foreground hover:border-foreground/30 hover:text-foreground",
              )}
            >
              #{tag}
            </button>
          );
        })}
        {editable && (
          <Button size="xs" variant="ghost" onClick={start} className="text-muted-foreground">
            <Tag />
            {repo.topics.length ? "Editar" : "Añadir etiquetas"}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {draft.map((tag) => (
          <span key={tag} className="inline-flex items-center gap-1 rounded-full border border-foreground/15 py-0.5 pr-1 pl-2 text-xs">
            #{tag}
            <button
              type="button"
              onClick={() => setDraft(draft.filter((t) => t !== tag))}
              aria-label={`Quitar ${tag}`}
              className="rounded-full p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              disabled={busy}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        {draft.length === 0 && <span className="text-xs text-muted-foreground">Sin etiquetas</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            } else if (e.key === "Escape") {
              setEditing(false);
            }
          }}
          placeholder="Nueva etiqueta y Enter"
          aria-label={`Nueva etiqueta para ${repo.name}`}
          className="h-7 w-48 text-xs"
          disabled={busy}
          autoFocus
        />
        <Button size="xs" onClick={save} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Save />}
          Guardar
        </Button>
        <Button size="xs" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
          Cancelar
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Se guardan como topics del repositorio en GitHub: minúsculas, números y guiones.</p>
      {error && (
        <p role="alert" className="text-xs text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
