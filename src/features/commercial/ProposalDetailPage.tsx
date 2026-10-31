import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { TotalCell } from "@/components/data-table/cells";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { dateText } from "@/features/activity/api";
import { PROPOSAL_STATUS_LABELS, PROPOSAL_STATUSES, type ProposalStatus } from "@/features/ops/api";
import { updateProposal, useProposal, type ProposalDetail } from "./api";

type Draft = { key: string; description: string; hours: string; rate: string };
const toDraft = (p: ProposalDetail): Draft[] => p.lines.map((l) => ({ key: l.id, description: l.description, hours: String(l.hours), rate: String(l.rateCents / 100) }));
const num = (v: string) => Number(v.replace(",", "."));

/** Líneas de la cotización: concepto × horas × tarifa; el subtotal y el monto los calcula el servidor. */
function LinesEditor({ proposal, canWrite }: { proposal: ProposalDetail; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const [lines, setLines] = useState<Draft[]>(() => toDraft(proposal));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const content = (ls: Draft[]) => JSON.stringify(ls.map((l) => [l.description, l.hours, l.rate]));
  const dirty = content(lines) !== content(toDraft(proposal));
  const valid = lines.every((l) => l.description.trim() && num(l.hours) >= 0 && num(l.rate) >= 0 && l.hours !== "" && l.rate !== "");
  // Vista previa local; el monto que vale es el que devuelve el servidor al guardar.
  const preview = lines.reduce((sum, l) => sum + Math.round(num(l.hours || "0") * Math.round(num(l.rate || "0") * 100)), 0);
  const set = (key: string, patch: Partial<Draft>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await updateProposal(proposal.id, {
        lines: lines.map((l) => ({ description: l.description.trim(), hours: num(l.hours), rateCents: Math.round(num(l.rate) * 100) })),
      });
      await queryClient.invalidateQueries({ queryKey: ["commercial"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron guardar las líneas.");
    } finally {
      setBusy(false);
    }
  }

  if (!canWrite) {
    return !proposal.lines.length ? (
      <p className="text-sm text-muted-foreground">Esta propuesta no tiene líneas: su monto se cargó a mano.</p>
    ) : (
      <ul className="divide-y divide-foreground/10 text-sm">
        {proposal.lines.map((l) => (
          <li key={l.id} className="grid gap-2 py-2 sm:grid-cols-[minmax(0,2fr)_auto_auto]">
            <span>{l.description}</span>
            <span className="tabular-nums text-muted-foreground">
              <TotalCell hours={l.hours} /> × <TotalCell cents={l.rateCents} currency={proposal.currency} />
            </span>
            <TotalCell cents={l.subtotalCents} currency={proposal.currency} strong />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="space-y-3">
      {lines.map((l, i) => (
        <div key={l.key} className="grid items-end gap-2 rounded-lg border border-foreground/10 p-2 sm:grid-cols-[2fr_0.7fr_0.8fr_auto_auto]">
          <Input aria-label={`Descripción de la línea ${i + 1}`} value={l.description} onChange={(e) => set(l.key, { description: e.target.value })} placeholder="Descripción" />
          <Input aria-label={`Horas de la línea ${i + 1}`} inputMode="decimal" value={l.hours} onChange={(e) => set(l.key, { hours: e.target.value })} placeholder="Horas" />
          <Input aria-label={`Tarifa de la línea ${i + 1}`} inputMode="decimal" value={l.rate} onChange={(e) => set(l.key, { rate: e.target.value })} placeholder="Tarifa" />
          <span className="text-right text-sm">
            <TotalCell cents={Math.round(num(l.hours || "0") * Math.round(num(l.rate || "0") * 100))} currency={proposal.currency} />
          </span>
          <Button size="icon-sm" variant="ghost" aria-label={`Quitar la línea ${i + 1}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
            <Trash2 />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setLines((ls) => [...ls, { key: crypto.randomUUID(), description: "", hours: "", rate: "" }])}>
          <Plus />
          Agregar línea
        </Button>
        <Button size="sm" disabled={!dirty || !valid || busy} onClick={() => void save()}>
          {busy ? <Loader2 className="animate-spin" /> : <Save />}
          Guardar líneas
        </Button>
        <span className="ml-auto text-sm text-muted-foreground">
          Total: <TotalCell cents={lines.length ? preview : (proposal.amountCents ?? 0)} currency={proposal.currency} strong />
        </span>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export default function ProposalDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useProposal(id);
  const [statusError, setStatusError] = useState<string | null>(null);
  const back = (
    <button type="button" onClick={() => navigate(-1)} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="size-4" /> Volver
    </button>
  );
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (error || !data) {
    return (
      <div className="space-y-4">
        {back}
        <p role="alert" className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Propuesta no encontrada."}
        </p>
      </div>
    );
  }
  const { proposal, canWrite } = data;

  return (
    <div className="space-y-6">
      <div>
        {back}
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{proposal.title}</h1>
          {canWrite ? (
            <Select
              label="Estado de la propuesta"
              className="w-auto min-w-36"
              value={proposal.status}
              options={PROPOSAL_STATUSES.map((s) => ({ value: s, label: PROPOSAL_STATUS_LABELS[s] }))}
              onValueChange={async (v) => {
                setStatusError(null);
                try {
                  await updateProposal(proposal.id, { status: (v ?? "") as ProposalStatus });
                  await queryClient.invalidateQueries({ queryKey: ["commercial"] });
                  await queryClient.invalidateQueries({ queryKey: ["sales"] });
                } catch (err) {
                  setStatusError(err instanceof Error ? err.message : "No se pudo cambiar el estado.");
                }
              }}
            />
          ) : (
            <span className="rounded-full border border-foreground/15 px-2 text-xs">{PROPOSAL_STATUS_LABELS[proposal.status]}</span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <a className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline" href={proposal.url} target="_blank" rel="noreferrer">
            Abrir la web <ExternalLink className="size-3.5" />
          </a>
          {proposal.lead && (
            <Link className="text-primary underline-offset-4 hover:underline" to={`/comercial/leads/${proposal.lead.id}`}>
              Lead: {proposal.lead.title}
            </Link>
          )}
          {proposal.deal && (
            <Link className="text-primary underline-offset-4 hover:underline" to={`/deals/${proposal.deal.id}`}>
              Deal {proposal.deal.dealCode}
            </Link>
          )}
          {proposal.project && (
            <Link className="text-primary underline-offset-4 hover:underline" to={`/operativa/${proposal.project.id}`}>
              Proyecto: {proposal.project.name}
            </Link>
          )}
          <span>{proposal.area === "commercial" ? "Comercial" : "Operativa"}</span>
          {proposal.sentAt && <span>Enviada {dateText(proposal.sentAt)}</span>}
        </div>
        {statusError && (
          <p role="alert" className="mt-1 text-sm text-destructive">
            {statusError}
          </p>
        )}
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Líneas</CardTitle>
          <span className="text-sm">
            Monto: <TotalCell cents={proposal.amountCents} currency={proposal.currency} strong />
          </span>
        </CardHeader>
        <CardContent>
          <LinesEditor key={JSON.stringify(proposal.lines)} proposal={proposal} canWrite={canWrite} />
        </CardContent>
      </Card>

    </div>
  );
}
