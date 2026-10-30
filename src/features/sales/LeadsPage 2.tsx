import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { selectClass } from "@/features/admin/TeamAssignCard";
import { textareaClass } from "@/features/activity/ActivityPanels";
import { cn } from "@/lib/utils";
import { createLead, LEAD_STATUS_LABELS, LEAD_STATUSES, salesKeys, useLeads, useSources, type LeadFilters, type LeadStatus } from "./api";
import { LeadStatusBadge } from "./SalesBadges";

function NewLeadForm({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const sources = useSources().data ?? [];
  const [company, setCompany] = useState("");
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = Boolean(company.trim() || contactName.trim() || email.trim());

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const { lead } = await createLead({
        company: company.trim(),
        contactName: contactName.trim(),
        email: email.trim() || null,
        phone: phone.trim() || null,
        notes: notes.trim(),
        ...(sourceId ? { sourceId } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: salesKeys.all });
      navigate(`/comercial/leads/${lead.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear el lead.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Nuevo lead</CardTitle>
        <Button size="icon-sm" variant="ghost" aria-label="Cerrar" onClick={onClose}>
          <X />
        </Button>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="lead-company">Empresa</Label>
              <Input id="lead-company" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Manpersa SAC" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lead-contact">Contacto</Label>
              <Input id="lead-contact" value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Francisco Wong" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lead-email">Correo</Label>
              <Input id="lead-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lead-phone">Teléfono</Label>
              <Input id="lead-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lead-source">Source</Label>
              <select id="lead-source" className={cn(selectClass, "w-full")} value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                <option value="">Manual</option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="lead-notes">Notas</Label>
              <textarea id="lead-notes" rows={2} className={textareaClass} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={!valid || busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Plus />}
              Crear lead
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export default function LeadsPage() {
  const [filters, setFilters] = useState<LeadFilters>({});
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const { data, isLoading, error } = useLeads(filters);
  const sources = useSources().data ?? [];
  const toggleStatus = (status: LeadStatus) => setFilters((f) => ({ ...f, status: f.status === status ? undefined : status }));

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Comercial</h1>
          <p className="text-sm text-muted-foreground">Leads de todos los sources: contacto, demo, propuesta y conversión en cliente.</p>
        </div>
        {!creating && (
          <Button onClick={() => setCreating(true)}>
            <Plus />
            Nuevo lead
          </Button>
        )}
      </div>

      {creating && <NewLeadForm onClose={() => setCreating(false)} />}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" role="group" aria-label="Embudo">
        {LEAD_STATUSES.map((status) => (
          <button
            key={status}
            type="button"
            aria-pressed={filters.status === status}
            onClick={() => toggleStatus(status)}
            className={cn(
              "rounded-xl border p-3 text-left transition-colors",
              filters.status === status ? "border-primary bg-primary/10" : "border-foreground/10 bg-foreground/[0.02] hover:bg-foreground/[0.05]",
            )}
          >
            <p className="text-xs text-muted-foreground">{LEAD_STATUS_LABELS[status]}</p>
            <p className="text-xl font-semibold tabular-nums">{data?.counts[status] ?? "–"}</p>
          </button>
        ))}
      </div>

      <form
        className="flex flex-wrap gap-2"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setFilters((f) => ({ ...f, q: search.trim() || undefined }));
        }}
      >
        <Input aria-label="Buscar leads" className="max-w-xs" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por empresa, contacto o correo" />
        <select aria-label="Filtrar por source" className={selectClass} value={filters.sourceId ?? ""} onChange={(e) => setFilters((f) => ({ ...f, sourceId: e.target.value || undefined }))}>
          <option value="">Todos los sources</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <Button type="submit" variant="outline">
          Buscar
        </Button>
      </form>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error instanceof Error ? error.message : "No se pudieron cargar los leads."}
        </p>
      ) : isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : !data?.leads.length ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {Object.values(filters).some(Boolean) ? "Ningún lead coincide con los filtros." : "Aún no hay leads. Crea uno o conecta un source."}
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2">
          {data.leads.map((lead) => (
            <li key={lead.id}>
              <Link
                to={`/comercial/leads/${lead.id}`}
                className="grid items-center gap-3 rounded-xl border border-foreground/10 bg-foreground/[0.02] p-4 transition-colors hover:bg-foreground/[0.05] md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{lead.title}</p>
                  <p className="truncate text-xs text-muted-foreground">{[lead.contactName, lead.email, lead.phone].filter(Boolean).join(" · ") || "Sin datos de contacto"}</p>
                </div>
                <p className="truncate text-sm text-muted-foreground">{lead.source.name}</p>
                <p className="truncate text-sm text-muted-foreground">{lead.owner?.name ?? "Sin responsable"}</p>
                <LeadStatusBadge value={lead.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
