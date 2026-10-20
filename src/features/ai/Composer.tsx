import { useEffect, useRef } from "react";
import { ArrowUp, Loader2, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AttachButton, AttachmentList } from "./MarkdownAttachments";
import type { MarkdownAttachmentsState } from "./useMarkdownAttachments";

/**
 * Caja de mensaje al estilo de Claude: texto que crece, adjuntos .md (botón o soltándolos)
 * y enviar dentro. Enter envía; Shift+Enter, salto de línea.
 */
export default function Composer({
  value,
  onChange,
  onSubmit,
  attachments,
  busy,
  disabled,
  placeholder,
  onStop,
  autoFocus,
  large,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  attachments: MarkdownAttachmentsState;
  busy?: boolean;
  disabled?: boolean;
  placeholder: string;
  /** Si Claude está trabajando: botón para detenerlo. */
  onStop?: () => void;
  autoFocus?: boolean;
  /** Más alto (pantalla de sesión nueva). */
  large?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const canSend = !busy && !disabled && (value.trim().length > 0 || attachments.files.length > 0);

  // Crece con el texto hasta un máximo; después, scroll.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, large ? 320 : 240)}px`;
  }, [value, large]);

  return (
    <div
      {...attachments.dropZone}
      className={cn(
        "rounded-2xl border border-foreground/15 bg-background/70 shadow-lg shadow-black/5 backdrop-blur transition-colors focus-within:border-violet-400/50 dark:bg-foreground/[0.04]",
        disabled && "opacity-60",
      )}
    >
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (canSend) onSubmit();
          }
        }}
        rows={large ? 3 : 1}
        maxLength={20_000}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label="Instrucción para Claude"
        disabled={disabled}
        className={cn(
          "block w-full resize-none bg-transparent px-4 pt-3.5 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed",
          large ? "min-h-24" : "min-h-11",
        )}
      />
      {attachments.files.length > 0 || attachments.error ? (
        <div className="px-3 pt-1">
          <AttachmentList state={attachments} />
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-2 px-2 pt-1 pb-2">
        <AttachButton state={attachments} disabled={disabled || busy} compact />
        <div className="flex items-center gap-2">
          {onStop && (
            <Button type="button" size="sm" variant="outline" onClick={onStop} className="rounded-full">
              <Square className="fill-current" />
              Detener
            </Button>
          )}
          <Button type="button" size="icon-sm" onClick={onSubmit} disabled={!canSend} aria-label="Enviar" className="rounded-full">
            {busy ? <Loader2 className="animate-spin" /> : <ArrowUp />}
          </Button>
        </div>
      </div>
    </div>
  );
}
