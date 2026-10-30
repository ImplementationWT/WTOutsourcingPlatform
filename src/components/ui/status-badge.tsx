import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { TONE_CLASS, TONE_DOT, type Tone } from "./tones";

/** Insignia de estado: tono de la paleta, alto fijo y sin cortar el texto. */
export function StatusBadge({ tone, children, dot, className, title }: { tone: Tone; children: ReactNode; dot?: boolean; className?: string; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex h-6 w-fit max-w-full items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap", TONE_CLASS[tone], className)}>
      {dot && <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[tone])} />}
      <span className="truncate">{children}</span>
    </span>
  );
}
