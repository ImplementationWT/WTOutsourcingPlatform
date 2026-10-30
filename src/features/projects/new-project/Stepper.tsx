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
                  active && "border-brand-400/60 bg-brand-500/20 text-brand-100",
                  done && "border-ok/40 bg-ok/10 text-ok-fg",
                  !active && !done && "border-foreground/15 bg-foreground/5 text-muted-foreground",
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
              <span className={cn("h-px flex-1", done ? "bg-ok/30" : "bg-foreground/10")} />
            )}
          </li>
        );
      })}
    </ol>
  );
}
