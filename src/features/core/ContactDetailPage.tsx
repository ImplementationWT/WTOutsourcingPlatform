import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/features/auth/auth";
import { StageBadge } from "@/features/ops/OpsBadges";
import { LEAD_STATUS_LABELS } from "@/features/sales/api";
import { useContact } from "./api";
import { canWriteCore } from "./hooks";
import { ContactForm } from "./ContactsPage";
import { DealStatusBadge } from "./DealsTable";
import { useCrumbs } from "@/components/layout/crumbs";

function Related({ title, empty, children, count }: { title: string; empty: string; count: number; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {title} ({count})
        </CardTitle>
      </CardHeader>
      <CardContent>{count ? <ul className="divide-y divide-foreground/10">{children}</ul> : <p className="text-sm text-muted-foreground">{empty}</p>}</CardContent>
    </Card>
  );
}

const link = "font-medium text-primary underline-offset-4 hover:underline";

export default function ContactDetailPage() {
  const { id = "" } = useParams();
  const role = useSession().data?.role;
  const { data, isLoading, error } = useContact(id);
  useCrumbs([data && { label: data.contact.name }]);
  const [editing, setEditing] = useState(false);
  const back = (
    <Link to="/comercial/contactos" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground lg:hidden">
      <ArrowLeft className="size-4" /> Contactos
    </Link>
  );

  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (error || !data) {
    return (
      <div className="space-y-4">
        {back}
        <p role="alert" className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Contacto no encontrado."}
        </p>
      </div>
    );
  }

  const { contact, deals, projects, leads } = data;
  return (
    <div className="space-y-6">
      <div>
        {back}
        <div className="mt-2 flex flex-wrap items-center gap-3 lg:mt-0">
          <h1 className="text-page-title">{contact.name}</h1>
          {canWriteCore(role) && !editing && (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              <Pencil />
              Editar
            </Button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {[contact.title ?? "Sin cargo", contact.company].filter(Boolean).join(" · ")}
        </p>
      </div>

      {editing ? (
        <ContactForm contact={contact} onClose={() => setEditing(false)} />
      ) : (
        <dl className="grid gap-3 rounded-xl border border-foreground/10 p-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">Correos</dt>
            <dd className="break-all">{contact.emails.length ? contact.emails.join(", ") : "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Teléfono</dt>
            <dd>{contact.phone ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">LinkedIn</dt>
            <dd className="truncate">
              {contact.linkedinUrl ? (
                <a className="text-primary underline-offset-4 hover:underline" href={contact.linkedinUrl} target="_blank" rel="noreferrer">
                  {contact.linkedinUrl}
                </a>
              ) : (
                "—"
              )}
            </dd>
          </div>
        </dl>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Related title="Leads" count={leads.length} empty="Sin leads.">
          {leads.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <Link className={link} to={`/comercial/leads/${l.id}`}>
                {l.title}
              </Link>
              <span className="text-xs text-muted-foreground">{LEAD_STATUS_LABELS[l.status]}</span>
            </li>
          ))}
        </Related>
        <Related title="Deals" count={deals.length} empty="Sin deals.">
          {deals.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <Link className={link} to={`/deals/${d.id}`}>
                {d.dealCode} · {d.title}
              </Link>
              <DealStatusBadge value={d.status} />
            </li>
          ))}
        </Related>
        <Related title="Proyectos" count={projects.length} empty="Sin proyectos.">
          {projects.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <Link className={link} to={`/operativa/${p.id}`}>
                {p.name}
              </Link>
              <StageBadge value={p.stage} />
            </li>
          ))}
        </Related>
      </div>
    </div>
  );
}
