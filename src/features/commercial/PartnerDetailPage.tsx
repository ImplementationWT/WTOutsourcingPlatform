import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Pencil } from "lucide-react";
import { TotalCell } from "@/components/data-table/cells";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DealStatusBadge } from "@/features/core/DealsTable";
import { PARTNER_KIND_LABELS, usePartner } from "./api";
import { PartnerForm } from "./PartnersPage";

export default function PartnerDetailPage() {
  const { id = "" } = useParams();
  const { data, isLoading, error } = usePartner(id);
  const [editing, setEditing] = useState(false);
  const back = (
    <Link to="/comercial/partners" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="size-4" /> Partners
    </Link>
  );
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (error || !data) {
    return (
      <div className="space-y-4">
        {back}
        <p role="alert" className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Partner no encontrado."}
        </p>
      </div>
    );
  }
  const { partner, deals, contact, canWrite } = data;

  return (
    <div className="space-y-6">
      <div>
        {back}
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{partner.name}</h1>
          {canWrite && !editing && (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              <Pencil />
              Editar
            </Button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {PARTNER_KIND_LABELS[partner.kind]} · comisión por defecto {partner.commissionPct}%
          {contact && (
            <>
              {" · "}
              <Link className="text-primary underline-offset-4 hover:underline" to={`/comercial/contactos/${contact.id}`}>
                {contact.name}
              </Link>
            </>
          )}
        </p>
      </div>

      {editing && <PartnerForm partner={partner} onClose={() => setEditing(false)} />}

      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { label: "Deals originados", value: <span className="font-medium">{partner.deals}</span> },
          { label: "Valor vendido", value: <TotalCell cents={partner.soldCents} strong /> },
          { label: "Comisión generada", value: <TotalCell cents={partner.commissionCents} strong /> },
        ].map((k) => (
          <Card key={k.label} size="sm">
            <CardContent>
              <p className="text-xs text-muted-foreground">{k.label}</p>
              <p className="mt-1 text-lg">{k.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Deals que originó</CardTitle>
        </CardHeader>
        <CardContent>
          {!deals.length ? (
            <p className="text-sm text-muted-foreground">Aún no tiene deals.</p>
          ) : (
            <ul className="divide-y divide-foreground/10">
              {deals.map((d) => (
                <li key={d.id} className="grid items-center gap-2 py-2 text-sm sm:grid-cols-[minmax(0,2fr)_auto_auto_auto]">
                  <Link className="font-medium text-primary underline-offset-4 hover:underline" to={`/deals/${d.id}`}>
                    {d.dealCode} · {d.title}
                  </Link>
                  <DealStatusBadge value={d.status} />
                  <TotalCell cents={d.amountCents} currency={d.currency} />
                  <span className="text-right">
                    {d.partnerCommissionPct ?? 0}% → <TotalCell cents={d.commissionCents} currency={d.currency} strong />
                  </span>
                </li>
              ))}
            </ul>
          )}
          {partner.notes && <p className="mt-3 text-sm whitespace-pre-wrap text-muted-foreground">{partner.notes}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
