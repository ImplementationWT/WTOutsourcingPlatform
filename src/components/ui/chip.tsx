import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Colores de los chips del prototipo (`.chip.c-*`): fondo suave y texto del mismo tono. */
export const CHIP_COLORS = ["red", "green", "blue", "amber", "purple", "brown", "gray"] as const;
export type ChipColor = (typeof CHIP_COLORS)[number];

export const CHIP_CLASS: Record<ChipColor, string> = {
  red: "chip-red",
  green: "chip-green",
  blue: "chip-blue",
  amber: "chip-amber",
  purple: "chip-purple",
  brown: "chip-brown",
  gray: "chip-gray",
};

/** Chip de estado del prototipo: alto 24 px, redondo, semibold. */
export function Chip({ color, children, className, title }: { color: ChipColor; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex h-6 w-fit max-w-full items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold whitespace-nowrap", CHIP_CLASS[color], className)}>
      <span className="truncate">{children}</span>
    </span>
  );
}
