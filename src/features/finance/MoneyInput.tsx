import { useState } from "react";

/** Monto en dólares editable (se guarda en centavos); vacío = 0. */
export function MoneyInput({ cents, label, onSave }: { cents: number; label: string; onSave: (cents: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (cents ? String(cents / 100) : "");
  const commit = () => {
    if (draft === null) return;
    const next = Math.round(Math.max(0, Number(draft.replace(",", ".")) || 0) * 100);
    setDraft(null);
    if (next !== cents) onSave(next);
  };
  return (
    <span className="inline-flex h-8 items-center rounded-lg border border-input bg-card px-2 text-sm tabular-nums focus-within:border-ring dark:bg-white/[0.03]">
      <span className="text-muted-foreground">$</span>
      <input aria-label={label} inputMode="decimal" placeholder="—" className="w-16 bg-transparent pl-0.5 outline-none" value={shown} onClick={(e) => e.currentTarget.select()} onChange={(e) => setDraft(e.target.value.replace(/[^0-9.,]/g, ""))} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
    </span>
  );
}

