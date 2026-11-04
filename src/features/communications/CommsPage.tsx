import { useState } from "react";
import { AlertTriangle, Plus, Search } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kpi, KpiRow } from "@/components/ui/kpi";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { useOpsProjects } from "@/features/ops/api";
import { useLeads } from "@/features/sales/api";
import { cn } from "@/lib/utils";
import { followUp, useComms, useCommsSummary, type ColdItem, type Communication } from "./api";
import { CommCard, CommDialog, type RelationOption } from "./CommsList";

type Tab = "all" | "emails" | "messages" | "calls" | "followups";
const TABS: { id: Tab; label: string; match: (c: Communication) => boolean }[] = [
  { id: "all", label: "Todas", match: () => true },
  { id: "emails", label: "Emails", match: (c) => c.kind === "email" },
  { id: "messages", label: "Mensajes", match: (c) => c.kind === "whatsapp" || c.kind === "slack" },
  { id: "calls", label: "Llamadas", match: (c) => c.kind === "call" },
  { id: "followups", label: "Seguimientos", match: (c) => Boolean(followUp(c)) },
];

const coldText = (c: ColdItem) => (c.since === "never" ? "Sin comunicaciones registradas" : c.since === "arrival" ? `Sin respuesta desde que llegó hace ${c.days} d` : `Sin contacto hace ${c.days} d`);

/**
 * Comunicaciones: emails, mensajes y llamadas con clientes y leads (registro manual). Avisa de los
 * proyectos sin contacto hace más de 7 días y de los leads sin respuesta hace más de 2.
 */
export default function CommsPage() {
  const { data, isLoading } = useComms(null);
  const summary = useCommsSummary().data;
  const projects = useOpsProjects("page=1&pageSize=100").data?.rows ?? [];
  const leads = useLeads("page=1&pageSize=100&view=active").data?.rows ?? [];
  const [tab, setTab] = useState<Tab>("all");
  const [q, setQ] = useState("");
  const [dialog, setDialog] = useState<{ relation: string } | null>(null);
  if (isLoading || !data) return <Skeleton className="h-64 w-full" />;

  const relations: RelationOption[] = [
    ...projects.map((p) => ({ value: `p:${p.id}`, label: `Proyecto · ${p.name}`, contact: p.client?.name ?? undefined })),
    ...leads.map((l) => ({ value: `l:${l.id}`, label: `Lead · ${l.title}`, contact: l.contactName ?? undefined })),
  ];
  const needle = q.trim().toLowerCase();
  const all = data.communications;
  const rows = all.filter((c) => TABS.find((t) => t.id === tab)!.match(c) && (!needle || [c.subject, c.body, c.contactName, c.owner?.name, c.project?.name, c.lead?.name].join(" ").toLowerCase().includes(needle)));
  const pending = all.filter((c) => followUp(c));
  const overdue = pending.filter((c) => followUp(c)?.tone === "danger").length;
  const cold = summary?.cold ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        stackOnMobile
        title="Comunicaciones"
        description={<span className="max-sm:hidden">Emails, mensajes y llamadas con clientes y leads. Registra cada contacto y programa el siguiente seguimiento.</span>}
        actions={
          data.canCreate ? (
            <Button size="lg" onClick={() => setDialog({ relation: "" })}>
              <Plus /> Registrar <span className="max-sm:hidden">comunicación</span>
            </Button>
          ) : undefined
        }
      />

      <KpiRow label="Indicadores">
        <Kpi label="Esta semana" value={summary?.lastWeek ?? "—"} sub="Comunicaciones registradas" />
        <Kpi label="Seguimientos pendientes" value={pending.length} sub={`${overdue} vencidos`} />
        <Kpi label="Sin comunicación" value={cold.length} sub="Proyectos y leads fuera de ritmo" />
      </KpiRow>

      {cold.length > 0 && (
        <section aria-label="Sin comunicación reciente" className="space-y-3 rounded-2xl border border-danger/40 bg-danger/5 p-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <p className="flex items-center gap-2 font-semibold text-danger">
              <AlertTriangle className="size-4" aria-hidden />
              {cold.length} sin comunicación reciente
            </p>
            <p className="text-sm text-muted-foreground">Proyectos sin contacto hace más de 7 días y leads sin respuesta hace más de 2 días. Haz clic para registrar el contacto.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {cold.slice(0, 12).map((c) => (
              <button key={`${c.kind}-${c.id}`} type="button" disabled={!data.canCreate} onClick={() => setDialog({ relation: `${c.kind === "project" ? "p" : "l"}:${c.id}` })} className="inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-border bg-card px-3 py-1.5 text-left text-sm hover:bg-accent disabled:cursor-default">
                <StatusBadge tone="neutral">{c.kind === "project" ? "Proyecto" : "Lead"}</StatusBadge>
                <b>{c.name}</b>
                <StatusBadge tone={c.kind === "project" || (c.days ?? 99) > 7 ? "danger" : "warn"}>{coldText(c)}</StatusBadge>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Tipo de comunicación" className="flex flex-wrap gap-1.5">
          {TABS.map((t) => (
            <button key={t.id} role="tab" type="button" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={cn("inline-flex h-9 items-center gap-2 rounded-full border px-3.5 text-sm font-medium", tab === t.id ? "border-primary bg-primary/10 font-semibold text-primary" : "border-border bg-card hover:bg-accent")}>
              {t.label}
              <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground">{all.filter(t.match).length}</span>
            </button>
          ))}
        </div>
        <label className="flex h-control w-full items-center gap-2 rounded-lg border border-input bg-card px-3 sm:w-80 dark:bg-white/[0.03]">
          <Search className="size-4 text-muted-foreground" aria-hidden />
          <Input className="h-auto border-0 bg-transparent p-0 focus-visible:ring-0 dark:bg-transparent" aria-label="Buscar comunicación" placeholder="Buscar por asunto, contacto o proyecto" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>

      <div className="space-y-2">
        {!rows.length && <p className="rounded-2xl border border-border bg-card p-10 text-center text-sm text-muted-foreground">No hay comunicaciones que coincidan.</p>}
        {rows.map((c) => (
          <CommCard key={c.id} c={c} showRelation canEdit={data.canCreate} />
        ))}
      </div>

      {dialog && <CommDialog open onOpenChange={(o) => !o && setDialog(null)} relations={relations} people={data.people} initialRelation={dialog.relation} />}
    </div>
  );
}
