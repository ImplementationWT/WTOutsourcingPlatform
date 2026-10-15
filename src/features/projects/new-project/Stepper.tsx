import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export default function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex items-center gap-3">
      {steps.map((label, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li key={label} className="flex flex-1 items-center gap-3 last:flex-none">
            <div className="flex items-center gap-2.5">
              <span
                aria-current={active ? "step" : undefined}
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors",
                  active && "border-violet-400/60 bg-violet-500/20 text-violet-100",
                  done && "border-emerald-400/40 bg-emerald-400/10 text-emerald-300",
                  !active && !done && "border-white/15 bg-white/5 text-muted-foreground",
                )}
              >
                {done ? <Check className="size-3.5" /> : index + 1}
              </span>
              <span
                className={cn(
                  "text-sm whitespace-nowrap",
                  active ? "font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                {label}
              </span>
            </div>
            {index < steps.length - 1 && (
              <span className={cn("h-px flex-1", done ? "bg-emerald-400/30" : "bg-white/10")} />
            )}
          </li>
        );
      })}
    </ol>
  );
}
