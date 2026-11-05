import "flag-icons/css/flag-icons.min.css";
import { cn } from "@/lib/utils";

/** Bandera de un país (código ISO 3166-1 alfa-2) en SVG: se ve igual en todos los sistemas. */
export function Flag({ code, className }: { code: string; className?: string }) {
  return <span aria-hidden className={cn(`fi fi-${code.toLowerCase()} shrink-0 rounded-[2px] shadow-[0_0_0_1px_rgb(0_0_0/8%)]`, className)} />;
}
