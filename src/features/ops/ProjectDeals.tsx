import { useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PersonAvatar } from "@/components/ui/person-avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { createDeal, removeFile, SALES_STAGE_LABELS, SALES_STAGES, updateDeal, uploadFile, useDeals, type Deal, type DealInput, type SalesStage } from "@/features/core/api";
import { FileField } from "@/components/ui/file-field";
import { dealLocked, useDealRefresh } from "@/features/core/hooks";
import { errorText, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { moneyShort, useTeamMembers } from "./api";

/** Color de cada estado de venta (prototipo .dst*): fondo sólido con texto blanco. */
const STAGE_COLOR: Record<SalesStage, string> = {
  new: "#744085",
  discovery: "#579bfc",
  demo: "#5559df",
  proposal: "#7fc8fa",
  negotiation: "#73c9c6",
  confirmed: "#3fa66a",
  won: "#5bc67d",
  lost: "#cf4050",
  ghosted: "#8a6a4f",
  on_hold: "#a1a1ab",
};

const cols = "grid grid-cols-[minmax(9rem,1.7fr)_minmax(7.5rem,1.1fr)_minmax(7rem,1fr)_4.75rem_4.75rem_5.5rem_minmax(8rem,1.2fr)_8.25rem_2.25rem] items-center gap-2";
const field = "h-10 w-full min-w-0 rounded-[10px] border border-border bg-muted px-3 text-sm outline-none focus:border-foreground disabled:opacity-70";

/** Texto o número que se guarda al salir del campo (o con Enter). */
function CellInput({ label, value, onSave, disabled, type = "text", placeholder, className }: { label: string; value: string; onSave: (v: string) => void; disabled: boolean; type?: string; placeholder?: string; className?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      aria-label={label}
      type={type}
      value={draft ?? value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== value) onSave(draft);
        setDraft(null);
      }}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      className={cn(field, className)}
    />
  );
}

function DealRow({ deal, people, canEdit, onSave, onRemove, onUpload, onRemoveDoc }: { deal: Deal; people: { id: string; name: string }[]; canEdit: boolean; onSave: (patch: Partial<DealInput>) => void; onRemove: () => void; onUpload: (file: File) => Promise<unknown>; onRemoveDoc: () => Promise<unknown> }) {
  const locked = !canEdit || dealLocked(deal);
  const owners = deal.owner && !people.some((p) => p.id === deal.owner!.id) ? [...people, { id: deal.owner.id, name: deal.owner.name ?? "—" }] : people;
  return (
    <div className={cols} role="row">
      <CellInput label={`Nombre de ${deal.title}`} value={deal.title} disabled={locked} onSave={(v) => v.trim().length >= 3 && onSave({ title: v.trim() })} className="font-semibold" />
      <div className={cn(field, "flex items-center gap-2 pr-1 pl-2")}>
        {deal.owner && <PersonAvatar person={deal.owner} size={22} />}
        <select aria-label={`Responsable de ${deal.title}`} value={deal.owner?.id ?? ""} disabled={locked} onChange={(e) => onSave({ ownerUserId: e.target.value || null })} className="native-caret h-full min-w-0 flex-1 cursor-pointer truncate bg-transparent text-sm font-semibold outline-none">
          <option value="">Sin asignar</option>
          {owners.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <select aria-label={`Estado de venta de ${deal.title}`} value={deal.salesStage} disabled={locked} onChange={(e) => onSave({ salesStage: e.target.value as SalesStage })} className="native-caret h-10 w-full min-w-0 cursor-pointer rounded-[10px] border-0 pl-3 text-sm font-semibold text-white outline-none disabled:cursor-default" style={{ backgroundColor: STAGE_COLOR[deal.salesStage] }}>
        {SALES_STAGES.map((s) => (
          <option key={s} value={s} className="bg-card text-foreground">
            {SALES_STAGE_LABELS[s]}
          </option>
        ))}
      </select>
      <CellInput label={`Horas de ${deal.title}`} type="number" value={String(deal.hours)} disabled={locked} onSave={(v) => Number(v) >= 0 && onSave({ hours: Number(v) })} className="tabular-nums" />
      <CellInput label={`Tarifa de ${deal.title}`} type="number" value={String(deal.rateCents / 100)} disabled={locked} onSave={(v) => Number(v) >= 0 && onSave({ rateCents: Math.round(Number(v) * 100) })} className="tabular-nums" />
      <p className={cn(field, "flex items-center font-bold tabular-nums")}>{moneyShort(deal.amountCents, deal.currency)}</p>
      <FileField label={`Documento de la propuesta de ${deal.title}`} emptyText="Subir documento" file={deal.proposalDoc} href={`/api/deals/${deal.id}/proposal-doc`} disabled={locked} onUpload={onUpload} onRemove={onRemoveDoc} />
      <CellInput label={`Fecha de cierre de ${deal.title}`} type="date" value={deal.actualCloseDate ?? ""} disabled={locked} onSave={(v) => onSave({ actualCloseDate: v || null })} className="px-2 tabular-nums" />
      {!locked ? (
        <button type="button" aria-label={`Cancelar ${deal.title}`} title="Cancelar el deal" onClick={onRemove} className="inline-flex size-9 items-center justify-center rounded-lg text-[var(--chip-red-fg)] hover:bg-accent-soft">
          <Trash2 className="size-4" />
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

/**
 * Deals del proyecto (prototipo): agrupados por estado de venta, cada uno se edita en la fila
 * (nombre, responsable, estado, horas, tarifa, documento y fecha de cierre); el total se calcula.
 * «Borrar» lo cancela (con Deshacer): los cancelados no se listan.
 */
export function ProjectDeals({ projectId, teamId, startCreating = false, hideCreate = false }: { projectId: string; teamId: string; startCreating?: boolean; hideCreate?: boolean }) {
  const { data, isLoading, error } = useDeals(`projectId=${projectId}&page=1&pageSize=100&sort=dealCode&dir=asc`);
  const refresh = useDealRefresh();
  const members = useTeamMembers(teamId, true).data ?? [];
  const [creating, setCreating] = useState(false);
  const people = members.map((m) => ({ id: m.id, name: m.name }));
  const deals = (data?.rows ?? []).filter((d) => d.status !== "cancelled");
  const groups = SALES_STAGES.map((s) => ({ stage: s, deals: deals.filter((d) => d.salesStage === s) })).filter((g) => g.deals.length);

  const save = async (deal: Deal, patch: Partial<DealInput>, done?: string, undo?: Partial<DealInput>) => {
    try {
      await updateDeal(deal.id, patch);
      await refresh(projectId);
      if (done) toast.success(done, undo ? { undo: async () => { await updateDeal(deal.id, undo); await refresh(projectId); } } : undefined);
    } catch (err) {
      toast.error("No se pudo guardar el deal.", { description: errorText(err, "Inténtalo de nuevo.") });
    }
  };
  const fileAction = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      await refresh(projectId);
      toast.success(done);
    } catch (err) {
      toast.error("No se pudo guardar el archivo.", { description: errorText(err, "Inténtalo de nuevo.") });
    }
  };
  const create = async () => {
    setCreating(true);
    try {
      await createDeal({ title: "Nuevo deal", projectId, salesStage: "new" });
      await refresh(projectId);
      toast.success("Deal creado: ponle nombre, horas y tarifa en la fila");
    } catch (err) {
      toast.error("No se pudo crear el deal.", { description: errorText(err, "Inténtalo de nuevo.") });
    } finally {
      setCreating(false);
    }
  };
  // «+ Nuevo deal» de «Equipo y pagos» llega con startCreating: se crea una sola vez.
  const started = useRef(false);
  const canCreate = Boolean(data?.canCreate);
  useEffect(() => {
    if (!startCreating || !canCreate || started.current) return;
    started.current = true;
    void createDeal({ title: "Nuevo deal", projectId, salesStage: "new" })
      .then(() => refresh(projectId))
      .then(() => toast.success("Deal creado: ponle nombre, horas y tarifa en la fila"))
      .catch((err: unknown) => toast.error("No se pudo crear el deal.", { description: errorText(err, "Inténtalo de nuevo.") }));
  }, [startCreating, canCreate, projectId, refresh]);

  if (isLoading) return <Skeleton className="h-40 w-full rounded-xl" />;
  if (error) return <p role="alert" className="text-sm text-destructive">{errorText(error, "No se pudieron cargar los deals.")}</p>;
  return (
    <div className="space-y-4">
      {/* «+ Nuevo deal» vive en «Equipo y pagos»; aquí solo si quien lo ve no gestiona el proyecto pero puede crear. */}
      {data?.canCreate && !hideCreate && (
        <div className="flex justify-end">
          <Button loading={creating} onClick={() => void create()}>
            {!creating && <Plus />} Nuevo deal
          </Button>
        </div>
      )}
      <div className="overflow-x-auto rounded-xl border border-border">
        <div role="table" aria-label="Deals del proyecto" className="min-w-[60rem] p-2.5">
          <div role="row" className={cn(cols, "border-b border-border px-3 pb-2.5 text-[10.5px] font-semibold tracking-[0.06em] text-muted-foreground uppercase")}>
            {["Deal", "Resp", "Stage", "Hours", "Rate", "Total", "Proposal doc", "Closed date", "Act"].map((h) => (
              <span key={h} role="columnheader">
                {h}
              </span>
            ))}
          </div>
          {!groups.length && <p className="px-3 py-8 text-center text-sm text-muted-foreground">Este proyecto aún no tiene deals.</p>}
          {groups.map((g) => (
            <section key={g.stage} aria-label={SALES_STAGE_LABELS[g.stage]} className="pt-3">
              <p className="flex items-center gap-2 border-b border-border px-1.5 pb-2">
                <b style={{ color: STAGE_COLOR[g.stage] }}>{SALES_STAGE_LABELS[g.stage]}</b>
                <span className="text-xs text-muted-foreground">
                  {g.deals.length} {g.deals.length === 1 ? "deal" : "deals"}
                </span>
              </p>
              <div className="space-y-2 border-l-[3px] py-2 pl-2" style={{ borderColor: STAGE_COLOR[g.stage] }}>
                {g.deals.map((d) => (
                  <DealRow
                    key={d.id}
                    deal={d}
                    people={people}
                    canEdit={d.canEdit}
                    onSave={(patch) => void save(d, patch)}
                    onRemove={() => void save(d, { status: "cancelled" }, `Deal cancelado: ${d.title}`, { status: d.status })}
                    onUpload={(file) => fileAction(() => uploadFile(`/api/deals/${d.id}/proposal-doc`, file), `Documento subido: ${file.name}`)}
                    onRemoveDoc={() => fileAction(() => removeFile(`/api/deals/${d.id}/proposal-doc`), "Documento quitado")}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
