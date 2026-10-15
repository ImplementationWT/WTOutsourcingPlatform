import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export default function StatusLabel({
  meta,
  className,
}: {
  meta: { label: string; icon: LucideIcon; className: string };
  className?: string;
}) {
  const Icon = meta.icon;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", meta.className, className)}>
      <Icon className="size-3.5" />
      {meta.label}
    </span>
  );
}
