import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, ErrorLine, Loading } from "@/features/activity/ActivityPanels";
import { dateText } from "@/features/activity/api";
import { STAGE_LABELS } from "@/features/ops/api";
import { HealthBadge } from "@/features/ops/OpsBadges";
import { useCustomers } from "./api";

/** Clientes: nacen al convertir un lead ganado. Cada uno con sus proyectos en Operativa. */
export default function CustomersPage() {
  const { data: customers, isLoading, error } = useCustomers();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Clientes</h1>
        <p className="mt-1 text-sm text-muted-foreground sm:text-base">Leads convertidos y el estado de sus proyectos.</p>
      </div>
      <ErrorLine error={error ? (error instanceof Error ? error.message : "No se pudieron cargar los clientes.") : null} />
      {isLoading ? (
        <Loading />
      ) : !customers?.length ? (
        <Empty>Aún no hay clientes. Se crean al convertir un lead con su propuesta aceptada.</Empty>
      ) : (
        <ul className="space-y-2">
          {customers.map((c) => (
            <li key={c.id}>
              <Card>
                <CardContent className="grid items-center gap-3 pt-4 md:grid-cols-[minmax(0,1.5fr)_minmax(0,2fr)]">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{c.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {[c.contactName, c.email, c.phone].filter(Boolean).join(" · ") || "Sin datos de contacto"} · cliente desde {dateText(c.createdAt)}
                    </p>
                    {c.leadId && (
                      <Link className="text-xs text-primary underline-offset-4 hover:underline" to={`/comercial/leads/${c.leadId}`}>
                        Ver lead
                      </Link>
                    )}
                  </div>
                  <ul className="space-y-1">
                    {c.projects.map((p) => (
                      <li key={p.id} className="flex flex-wrap items-center gap-2 text-sm">
                        <Link className="text-primary underline-offset-4 hover:underline" to={`/operativa/${p.id}`}>
                          {p.name}
                        </Link>
                        <span className="text-xs text-muted-foreground">{STAGE_LABELS[p.stage]}</span>
                        <HealthBadge value={p.health} />
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
