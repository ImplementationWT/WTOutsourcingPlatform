import type { Lead } from "./api";

/** Aviso cuando falta una fecha para calcular el tiempo de respuesta, con acceso al campo. */
export function ResponseNotice({ lead, onFix, fixLabel = "Ir al campo" }: { lead: Pick<Lead, "submittedAt" | "responseDays">; onFix?: () => void; fixLabel?: string }) {
  if (lead.responseDays !== null) return null;
  return (
    <div className="flex items-start gap-3 rounded-xl border border-warn/30 bg-warn/10 px-4 py-3 text-sm text-warn-fg">
      <p className="flex-1">Agrega la fecha de {lead.submittedAt ? "reunión" : "submission"} para calcular el tiempo de respuesta.</p>
      {onFix && (
        <button type="button" onClick={onFix} className="shrink-0 font-semibold underline underline-offset-4 hover:opacity-80">
          {fixLabel}
        </button>
      )}
    </div>
  );
}
