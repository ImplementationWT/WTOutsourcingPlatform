import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Handshake, X } from "lucide-react";
import { InlineSelect } from "@/components/data-table/cells";
import { Button, buttonVariants } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/editable";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { LEAD_FUNNEL_LABELS, type Lead, type LeadInput, type Owner } from "./api";
import { LeadStatusBadge, TemperatureBadge } from "./SalesBadges";
import { useCreateDeal } from "./use-create-deal";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-3">
      <dt className="shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center justify-end gap-0.5 text-sm font-semibold">{children}</dd>
    </div>
  );
}

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

/**
 * Vista rápida del lead junto a la tabla: lo esencial para decidir el siguiente paso sin salir
 * de la lista (Setter y Closer se cambian aquí mismo) y el acceso al detalle completo.
 */
export function LeadPanel({
  lead,
  owners,
  canWrite,
  onClose,
  onSave,
  onFixDates,
}: {
  lead: Lead;
  owners: Owner[];
  canWrite: boolean;
  onClose: () => void;
  onSave: (patch: Partial<LeadInput>) => Promise<unknown>;
  onFixDates: () => void;
}) {
  const { create, busy } = useCreateDeal(lead);
  const ownerIds = owners.map((o) => o.id);
  const ownerNames = Object.fromEntries(owners.map((o) => [o.id, o.name]));
  const person = (p: Lead["setter"]) => p?.name ?? "Sin asignar";

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-5 overflow-y-auto p-6">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-xl font-bold tracking-tight">{lead.title}</h2>
            <p className="mt-0.5 truncate text-sm text-muted-foreground">{[lead.contactName, `creado ${formatDate(lead.createdAt)}`].filter(Boolean).join(" · ")}</p>
          </div>
          <Button size="icon" variant="outline" aria-label="Cerrar vista rápida" onClick={onClose}>
            <X />
          </Button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <LeadStatusBadge value={lead.status} />
          {lead.temperature && <TemperatureBadge value={lead.temperature} />}
          {lead.funnel && <StatusBadge tone="neutral">{LEAD_FUNNEL_LABELS[lead.funnel]}</StatusBadge>}
        </div>

        <dl className="space-y-0.5 rounded-xl border border-border bg-muted/30 px-4 py-2">
          <Row label="Correo">
            {lead.email ? (
              <>
                <a href={`mailto:${lead.email}`} className="truncate hover:text-primary">
                  {lead.email}
                </a>
                <CopyButton value={lead.email} label="Correo" />
              </>
            ) : (
              <span className="font-normal text-muted-foreground">—</span>
            )}
          </Row>
          <Row label="Teléfono">
            {lead.phone ? (
              <>
                <a href={`tel:${lead.phone.replace(/[^\d+]/g, "")}`} className="truncate hover:text-primary">
                  {lead.phone}
                </a>
                <CopyButton value={lead.phone} label="Teléfono" />
              </>
            ) : (
              <span className="font-normal text-muted-foreground">—</span>
            )}
          </Row>
          <Row label="Setter">
            <InlineSelect label="Setter" value={lead.setter?.id ?? null} options={ownerIds} labels={ownerNames} allowEmpty="Sin asignar" disabled={!canWrite} display={person(lead.setter)} onSave={(v) => onSave({ setterUserId: v })} />
          </Row>
          <Row label="Closer">
            <InlineSelect label="Closer" value={lead.closer?.id ?? null} options={ownerIds} labels={ownerNames} allowEmpty="Sin asignar" disabled={!canWrite} display={person(lead.closer)} onSave={(v) => onSave({ closerUserId: v })} />
          </Row>
          {lead.responseDays !== null && (
            <Row label="Respuesta">
              <span className="tabular-nums">{lead.responseDays} d</span>
            </Row>
          )}
        </dl>

        <ResponseNotice lead={lead} onFix={onFixDates} />

        {lead.notes && (
          <div className="space-y-1.5">
            <p className="text-caps-label">Notas</p>
            <p className="line-clamp-4 text-sm whitespace-pre-line text-muted-foreground">{lead.notes}</p>
          </div>
        )}
      </div>

      <div className="space-y-2.5 border-t border-border p-6">
        <Link to={`/comercial/leads/${lead.id}`} className={cn(buttonVariants({ size: "lg" }), "w-full")}>
          Abrir completo
        </Link>
        {lead.deal ? (
          <Link to={`/deals/${lead.deal.id}`} className={cn(buttonVariants({ size: "lg", variant: "outline" }), "w-full")}>
            <Handshake />
            Ver deal {lead.deal.dealCode}
          </Link>
        ) : (
          canWrite && (
            <Button size="lg" variant="outline" className="w-full" loading={busy} onClick={() => void create()}>
              Crear deal
            </Button>
          )
        )}
      </div>
    </div>
  );
}
