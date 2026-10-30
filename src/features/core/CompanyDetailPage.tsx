import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/features/auth/auth";
import { HealthBadge, StageBadge } from "@/features/ops/OpsBadges";
import { COMPANY_SIZE_LABELS, useCompany } from "./api";
import { CompanyForm } from "./CompaniesPage";
import { canWriteCore } from "./hooks";
import { ContactForm } from "./ContactsPage";

export default function CompanyDetailPage() {
  const { id = "" } = useParams();
  const role = useSession().data?.role;
  const { data, isLoading, error } = useCompany(id);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const back = (
    <Link to="/comercial/empresas" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="size-4" /> Empresas
    </Link>
  );

  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (error || !data) {
    return (
      <div className="space-y-4">
        {back}
        <p role="alert" className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Empresa no encontrada."}
        </p>
      </div>
    );
  }

  const { company, contacts, projects } = data;
  const canWrite = canWriteCore(role);
  const facts = [
    ["Dominio", company.domain],
    ["Industria", company.industry],
    ["Tamaño", company.size ? COMPANY_SIZE_LABELS[company.size] : null],
    ["País / ubicación", company.location],
  ] as const;

  return (
    <div className="space-y-6">
      <div>
        {back}
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{company.name}</h1>
          {canWrite && !editing && (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              <Pencil />
              Editar
            </Button>
          )}
        </div>
      </div>

      {editing ? (
        <CompanyForm company={company} onClose={() => setEditing(false)} />
      ) : (
        <dl className="grid gap-3 rounded-xl border border-foreground/10 p-4 text-sm sm:grid-cols-4">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd>{value ?? "—"}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Contactos ({contacts.length})</CardTitle>
            {canWrite && !adding && (
              <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
                <Plus />
                Agregar
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-3">
            {adding && <ContactForm companyId={company.id} onClose={() => setAdding(false)} stay />}
            {!contacts.length ? (
              <p className="text-sm text-muted-foreground">Esta empresa aún no tiene contactos.</p>
            ) : (
              <ul className="divide-y divide-foreground/10">
                {contacts.map((c) => (
                  <li key={c.id} className="py-2">
                    <Link to={`/comercial/contactos/${c.id}`} className="font-medium text-primary underline-offset-4 hover:underline">
                      {c.name}
                    </Link>
                    <p className="text-xs text-muted-foreground">{[c.title, ...c.emails, c.phone].filter(Boolean).join(" · ") || "Sin datos de contacto"}</p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Proyectos ({projects.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {!projects.length ? (
              <p className="text-sm text-muted-foreground">Esta empresa aún no tiene proyectos.</p>
            ) : (
              <ul className="divide-y divide-foreground/10">
                {projects.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-2 py-2">
                    <Link to={`/operativa/${p.id}`} className="font-medium text-primary underline-offset-4 hover:underline">
                      {p.name}
                    </Link>
                    <StageBadge value={p.stage} />
                    <HealthBadge value={p.health} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
