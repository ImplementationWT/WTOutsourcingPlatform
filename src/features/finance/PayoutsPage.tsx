import { useState } from "react";
import { ChevronLeft, ChevronRight, Copy } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Kpi, KpiRow } from "@/components/ui/kpi";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { TONE_CLASS } from "@/components/ui/tones";
import { money } from "@/features/ops/api";
import { hoursLabel } from "@/features/tasks/api";
import { formatDate } from "@/lib/format";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { monthLabel, PAY_ROLE_LABELS, PAY_ROLE_TONE, payoutsApi, payRoleOf, SENIORITIES, shiftMonth, useFinanceAction, usePayouts, type PayRole, type PayoutRow } from "./api";
import { MoneyInput } from "./MoneyInput";

type Tab = "all" | "leads" | "devs" | "pending";
const TABS: { id: Tab; label: string; match: (r: PayoutRow) => boolean }[] = [
  { id: "all", label: "Todos", match: () => true },
  { id: "leads", label: "Team Leaders", match: (r) => r.user.role === "lead" },
  { id: "devs", label: "Developers", match: (r) => r.user.role === "developer" },
  { id: "pending", label: "Pendientes", match: (r) => r.status !== "paid" },
];
const ROLE_OPTIONS: PayRole[] = ["lead", ...SENIORITIES, "developer"];
const roleSelect = (v: PayRole) => (v === "lead" ? { role: "lead" as const } : { role: "developer" as const, seniority: v === "developer" ? null : v });

/**
 * Pagos / Comisiones: un registro por persona y mes (básico + comisiones = total). La comisión se
 * escribe a mano. Rol, seniority y team salen del usuario y solo boss los cambia.
 */
export default function PayoutsPage() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const { data, isLoading, error } = usePayouts(month);
  const run = useFinanceAction();
  const [tab, setTab] = useState<Tab>("all");
  const [roleFilter, setRoleFilter] = useState<PayRole | null>(null);
  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error || !data) return <p role="alert" className="text-sm text-destructive">{error instanceof Error ? error.message : "No se pudo cargar Pagos."}</p>;

  const all = data.rows;
  const rows = all.filter((r) => TABS.find((t) => t.id === tab)!.match(r) && (!roleFilter || payRoleOf(r.user) === roleFilter));
  const sum = (list: PayoutRow[], f: (r: PayoutRow) => number) => list.reduce((n, r) => n + f(r), 0);
  const basic = sum(all, (r) => r.basicCents);
  const comm = sum(all, (r) => r.commissionCents);
  const paid = sum(all.filter((r) => r.status === "paid"), (r) => r.totalCents);
  const save = (r: PayoutRow, patch: Parameters<typeof payoutsApi.save>[2]) => void run(() => payoutsApi.save(r.user.id, month, patch));
  const person = async (r: PayoutRow, patch: Parameters<typeof payoutsApi.person>[1]) => {
    const res = await run(() => payoutsApi.person(r.user.id, patch));
    if (res?.replacedLead) toast.info(`${r.user.name} ahora es el Team Leader del equipo (antes: ${res.replacedLead}).`);
  };
  const copy = async () => {
    const res = await run(() => payoutsApi.copyBasics(month));
    if (res) toast.success(res.copied ? `Básicos copiados de ${monthLabel(res.from)} (${res.copied})` : "No hay básicos por copiar");
  };
  const th = "text-caps-label sticky top-0 z-10 border-b border-border bg-card px-3 py-2.5 text-left font-semibold";
  const td = "border-t border-border px-3 py-2 align-middle";

  return (
    <div className="space-y-6">
      <PageHeader
        stackOnMobile
        title="Pagos / Comisiones"
        description={<span className="max-sm:hidden">Pagos mensuales a team leaders y developers. Pago total = Básico ($) + Comisiones ($).</span>}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button size="icon" variant="outline" aria-label="Mes anterior" onClick={() => setMonth(shiftMonth(month, -1))}>
              <ChevronLeft />
            </Button>
            <b className="min-w-36 text-center">{monthLabel(month)}</b>
            <Button size="icon" variant="outline" aria-label="Mes siguiente" onClick={() => setMonth(shiftMonth(month, 1))}>
              <ChevronRight />
            </Button>
            <Button variant="outline" onClick={() => setMonth(new Date().toISOString().slice(0, 7))}>
              Hoy
            </Button>
            <Button variant="outline" onClick={() => void copy()}>
              <Copy /> Copiar básicos del mes anterior
            </Button>
          </div>
        }
      />

      <KpiRow label="Indicadores">
        <Kpi label="Total a pagar" value={money(basic + comm)} sub={`${all.length} personas · ${monthLabel(month)}`} />
        <Kpi label="Básico" value={money(basic)} sub="Suma de básicos" />
        <Kpi label="Comisiones" value={money(comm)} sub={basic ? `${Math.round((comm / basic) * 1000) / 10}% sobre el básico` : "—"} />
        <Kpi label="Pagado" value={money(paid)} sub={`${all.filter((r) => r.status === "paid").length} de ${all.length} personas`} />
        <Kpi label="Pendiente" value={money(basic + comm - paid)} sub={`${all.filter((r) => r.status !== "paid").length} por pagar`} />
      </KpiRow>

      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Personas" className="flex flex-wrap gap-1.5">
          {TABS.map((t) => (
            <button key={t.id} role="tab" type="button" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={cn("inline-flex h-9 items-center gap-2 rounded-full border px-3.5 text-sm font-medium", tab === t.id ? "border-primary bg-primary/10 font-semibold text-primary" : "border-border bg-card hover:bg-accent")}>
              {t.label}
              <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground">{all.filter(t.match).length}</span>
            </button>
          ))}
        </div>
        <div className="w-full sm:ml-auto sm:w-60">
          <Select label="Filtrar por rol" value={roleFilter} emptyLabel="Todos los roles" options={ROLE_OPTIONS.map((r) => ({ value: r, label: PAY_ROLE_LABELS[r] }))} onValueChange={(v) => setRoleFilter(v as PayRole | null)} />
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-border bg-card">
        <table className="w-full min-w-[78rem] border-separate border-spacing-0 text-sm">
          <caption className="sr-only">Pagos de {monthLabel(month)}</caption>
          <thead>
            <tr>
              {["Persona", "Rol", "Team", "H. inv.", "H. fact.", "Básico", "Comisiones", "Total", "Estado", "Fecha de pago"].map((h) => (
                <th key={h} scope="col" className={th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const role = payRoleOf(r.user);
              return (
                <tr key={r.user.id} className="hover:bg-muted/40">
                  <td className={cn(td, "font-semibold whitespace-nowrap")}>{r.user.name}</td>
                  <td className={cn(td, "w-56")}>
                    {data.canEditPeople ? (
                      <Select
                        label={`Rol de ${r.user.name}`}
                        size="sm"
                        value={role}
                        options={ROLE_OPTIONS.map((o) => ({ value: o, label: PAY_ROLE_LABELS[o] }))}
                        renderValue={(o) => <span className={cn("rounded-md px-2 py-0.5 text-xs font-semibold", TONE_CLASS[PAY_ROLE_TONE[(o?.value as PayRole) ?? role]])}>{o?.label}</span>}
                        onValueChange={(v) => v && v !== role && void person(r, roleSelect(v as PayRole))}
                      />
                    ) : (
                      <StatusBadge tone={PAY_ROLE_TONE[role]}>{PAY_ROLE_LABELS[role]}</StatusBadge>
                    )}
                  </td>
                  <td className={cn(td, "w-44")}>
                    {data.canEditPeople ? (
                      <Select label={`Team de ${r.user.name}`} size="sm" value={r.user.team?.id ?? null} options={data.teams.map((t) => ({ value: t.id, label: t.name }))} onValueChange={(v) => v && v !== r.user.team?.id && void person(r, { teamId: v })} />
                    ) : (
                      <StatusBadge tone="outline">{r.user.team?.name ?? "Sin team"}</StatusBadge>
                    )}
                  </td>
                  <td className={cn(td, "text-muted-foreground tabular-nums")}>{hoursLabel(r.hours.invested)}</td>
                  <td className={cn(td, "text-muted-foreground tabular-nums")}>{hoursLabel(r.hours.billable)}</td>
                  <td className={td}>
                    <MoneyInput label={`Básico de ${r.user.name}`} cents={r.basicCents} onSave={(basicCents) => save(r, { basicCents })} />
                  </td>
                  <td className={td}>
                    <MoneyInput label={`Comisiones de ${r.user.name}`} cents={r.commissionCents} onSave={(commissionCents) => save(r, { commissionCents })} />
                  </td>
                  <td className={cn(td, "font-bold whitespace-nowrap tabular-nums")}>{money(r.totalCents)}</td>
                  <td className={cn(td, "w-36")}>
                    <Select
                      label={`Estado de pago de ${r.user.name}`}
                      size="sm"
                      value={r.status}
                      options={[{ value: "pending", label: "Pendiente" }, { value: "paid", label: "Pagado" }]}
                      renderValue={(o) => <span className={cn("rounded-md px-2 py-0.5 text-xs font-semibold", TONE_CLASS[o?.value === "paid" ? "ok" : "warn"])}>{o?.label}</span>}
                      onValueChange={(v) => v && v !== r.status && save(r, { status: v as "pending" | "paid" })}
                    />
                  </td>
                  <td className={cn(td, "whitespace-nowrap text-muted-foreground")}>{r.paidDate ? formatDate(r.paidDate) : "—"}</td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr>
                <td colSpan={10} className="p-10 text-center text-sm text-muted-foreground">
                  No hay personas para este filtro.
                </td>
              </tr>
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="font-bold">
                <td className="border-t-2 border-border px-3 py-3">Total</td>
                <td className="border-t-2 border-border" />
                <td className="border-t-2 border-border" />
                <td className="border-t-2 border-border px-3 text-muted-foreground tabular-nums">{hoursLabel(sum(rows, (r) => r.hours.invested))}</td>
                <td className="border-t-2 border-border px-3 text-muted-foreground tabular-nums">{hoursLabel(sum(rows, (r) => r.hours.billable))}</td>
                <td className="border-t-2 border-border px-3 tabular-nums">{money(sum(rows, (r) => r.basicCents))}</td>
                <td className="border-t-2 border-border px-3 tabular-nums">{money(sum(rows, (r) => r.commissionCents))}</td>
                <td className="border-t-2 border-border px-3 tabular-nums">{money(sum(rows, (r) => r.totalCents))}</td>
                <td className="border-t-2 border-border" />
                <td className="border-t-2 border-border" />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Las horas son referenciales: se reparten por día entre el inicio y el fin de cada tarea y no cambian el monto. Básico y comisiones se escriben a mano (la regla de cálculo de comisiones aún no está definida).
        {!data.canEditPeople && " Rol y team los cambia un CEO/CCO."}
      </p>
    </div>
  );
}
