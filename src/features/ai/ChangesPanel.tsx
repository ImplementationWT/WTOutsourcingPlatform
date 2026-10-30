import { useState } from "react";
import { ChevronRight, ExternalLink, FileDiff, GitCommitHorizontal, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AiSession, DiffFile } from "@/types/ai";
import { useAiDiff } from "./api";

const STATUS_LABEL: Record<string, string> = { added: "nuevo", removed: "borrado", modified: "modificado", renamed: "renombrado" };

function lineClass(line: string) {
  if (line.startsWith("@@")) return "text-info-fg/90 bg-info/5";
  if (line.startsWith("+")) return "text-ok-fg bg-ok/10";
  if (line.startsWith("-")) return "text-danger-fg bg-danger/10";
  return "text-foreground/70";
}

function FileDiffView({ file }: { file: DiffFile }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg border border-foreground/10">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-foreground/5"
      >
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <code className="min-w-0 flex-1 truncate font-mono text-xs">{file.filename}</code>
        <span className="shrink-0 text-xs text-muted-foreground">{STATUS_LABEL[file.status] ?? file.status}</span>
        <span className="shrink-0 font-mono text-xs text-ok-fg">+{file.additions}</span>
        <span className="shrink-0 font-mono text-xs text-danger-fg">−{file.deletions}</span>
      </button>
      {open && (
        <div className="overflow-x-auto border-t border-foreground/10">
          {file.patch ? (
            <pre className="font-mono text-[11px] leading-5">
              {file.patch.split("\n").map((line, i) => (
                <div key={i} className={cn("px-3 whitespace-pre", lineClass(line))}>
                  {line || " "}
                </div>
              ))}
            </pre>
          ) : (
            <p className="px-3 py-2 text-xs text-muted-foreground">Cambio demasiado grande o binario: ábrelo en GitHub.</p>
          )}
        </div>
      )}
    </li>
  );
}

/** Diff de la rama de la sesión contra main. */
export default function ChangesPanel({ session }: { session: AiSession }) {
  const { data, isLoading, isFetching, error, refetch } = useAiDiff(session.id, session.status !== "closed" || Boolean(session.pullRequest));
  if (isLoading) {
    return (
      <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Cargando cambios…
      </p>
    );
  }
  if (error) return <p className="p-4 text-sm text-danger-fg">{error.message}</p>;
  if (!data) return null;
  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          {data.aheadBy === 0 ? (
            <span className="text-muted-foreground">Will Doo aún no ha subido cambios a la rama.</span>
          ) : (
            <>
              <strong>{data.files.length}</strong> {data.files.length === 1 ? "archivo" : "archivos"} en <strong>{data.aheadBy}</strong>{" "}
              {data.aheadBy === 1 ? "commit" : "commits"}
            </>
          )}
        </p>
        <div className="flex gap-1">
          <Button size="xs" variant="ghost" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn(isFetching && "animate-spin")} />
            Actualizar
          </Button>
          <Button size="xs" variant="ghost" render={<a href={data.url} target="_blank" rel="noreferrer" />} nativeButton={false}>
            <ExternalLink />
            GitHub
          </Button>
        </div>
      </div>

      {data.commits.length > 0 && (
        <ul className="space-y-1">
          {data.commits.map((commit) => (
            <li key={commit.sha} className="flex items-start gap-2 text-xs">
              <GitCommitHorizontal className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span className="font-mono text-muted-foreground">{commit.sha.slice(0, 7)}</span>
              <span className="min-w-0 flex-1 truncate">{commit.message.split("\n")[0]}</span>
            </li>
          ))}
        </ul>
      )}

      {data.files.length > 0 && (
        <ul className="space-y-2">
          {data.files.map((file) => (
            <FileDiffView key={file.filename} file={file} />
          ))}
        </ul>
      )}
      {data.truncated && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <FileDiff className="size-3.5" /> Algunos cambios no se muestran aquí por su tamaño; están completos en GitHub.
        </p>
      )}
    </div>
  );
}
