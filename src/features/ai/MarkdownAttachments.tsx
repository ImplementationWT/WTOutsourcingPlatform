import { useRef } from "react";
import { FileText, Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MAX_ATTACHMENTS, type MarkdownAttachmentsState, bytes, kb } from "./useMarkdownAttachments";

/** Botón "Adjuntar .md" con su selector de archivos oculto. */
export function AttachButton({ state, disabled, compact }: { state: MarkdownAttachmentsState; disabled?: boolean; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".md,.markdown,text/markdown"
        multiple
        hidden
        data-testid="markdown-input"
        onChange={(e) => {
          if (e.target.files) void state.add(e.target.files);
          e.target.value = "";
        }}
      />
      <Button
        type="button"
        size={compact ? "icon-sm" : "sm"}
        variant={compact ? "ghost" : "outline"}
        onClick={() => input.current?.click()}
        disabled={disabled || state.files.length >= MAX_ATTACHMENTS}
        title="Adjuntar archivos Markdown (.md) para que Claude los lea"
        aria-label={compact ? "Adjuntar archivos .md" : undefined}
      >
        <Paperclip />
        {!compact && "Adjuntar .md"}
      </Button>
    </>
  );
}

/** Adjuntos pendientes de enviar, con su botón de quitar, y el error de validación. */
export function AttachmentList({ state }: { state: MarkdownAttachmentsState }) {
  if (!state.files.length && !state.error) return null;
  return (
    <div className="space-y-1.5">
      {state.files.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Archivos adjuntos">
          {state.files.map((file) => (
            <li key={file.name} className="flex items-center gap-1.5 rounded-md border border-foreground/10 bg-foreground/5 py-0.5 pr-1 pl-2 text-xs">
              <FileText className="size-3.5 text-violet-300" />
              <span className="max-w-48 truncate">{file.name}</span>
              <span className="text-muted-foreground">{kb(bytes(file.content))}</span>
              <button
                type="button"
                onClick={() => state.remove(file.name)}
                className="rounded p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                aria-label={`Quitar ${file.name}`}
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {state.error && (
        <p role="alert" className="text-xs text-red-300">
          {state.error}
        </p>
      )}
    </div>
  );
}

/** Nombres de los adjuntos dentro de una burbuja del chat. */
export function AttachmentNames({ names }: { names: string[] }) {
  return (
    <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Archivos adjuntos">
      {names.map((name, i) => (
        <li key={`${name}-${i}`} className="flex items-center gap-1 rounded-md bg-background/40 px-1.5 py-0.5 text-xs">
          <FileText className="size-3.5" />
          {name}
        </li>
      ))}
    </ul>
  );
}
