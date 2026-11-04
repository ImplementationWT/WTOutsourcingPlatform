import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Loader2, Plus, Search, X } from "lucide-react";
import { useTableState } from "@/components/data-table/table-state";
import { Chip } from "@/components/ui/chip";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "@/features/auth/auth";
import { createContact, updateContact, useContacts, type Contact, type ContactInput } from "./api";
import { canWriteCore } from "./hooks";
import { PageHeader } from "@/components/layout/PageHeader";

/**
 * Alta o edición de un contacto; con `stay` el alta no navega al contacto nuevo.
 */
export function ContactForm({ contact, onClose, stay }: { contact?: Contact; onClose: () => void; stay?: boolean }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: contact?.name ?? "",
    emails: contact?.emails.join(", ") ?? "",
    phone: contact?.phone ?? "",
    title: contact?.title ?? "",
    linkedinUrl: contact?.linkedinUrl ?? "",
    company: contact?.company ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = form.name.trim().length >= 2;
  const set = (key: keyof typeof form, value: string) => setForm((f) => ({ ...f, [key]: value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    const input: ContactInput = {
      name: form.name.trim(),
      emails: form.emails
        .split(/[,;\s]+/)
        .map((v) => v.trim())
        .filter(Boolean),
      phone: form.phone.trim() || null,
      title: form.title.trim() || null,
      linkedinUrl: form.linkedinUrl.trim() || null,
      company: form.company.trim() || null,
    };
    try {
      if (contact) await updateContact(contact.id, input);
      const created = contact ? null : (await createContact(input)).contact;
      await queryClient.invalidateQueries({ queryKey: ["core"] });
      if (created && !stay) navigate(`/comercial/contactos/${created.id}`);
      else onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el contacto.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-foreground/10 p-4" aria-label={contact ? "Editar contacto" : "Nuevo contacto"}>
      <div className="flex items-center justify-between">
        <p className="font-medium">{contact ? "Editar contacto" : "Nuevo contacto"}</p>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Cerrar" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="ct-name">Nombre</Label>
          <Input id="ct-name" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Lucía Pérez" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ct-title">Cargo</Label>
          <Input id="ct-title" value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="Gerente de operaciones" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ct-emails">Correos (separados por coma)</Label>
          <Input id="ct-emails" value={form.emails} onChange={(e) => set("emails", e.target.value)} placeholder="lucia@empresa.com" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ct-phone">Teléfono</Label>
          <Input id="ct-phone" value={form.phone} onChange={(e) => set("phone", e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ct-linkedin">LinkedIn</Label>
          <Input id="ct-linkedin" value={form.linkedinUrl} onChange={(e) => set("linkedinUrl", e.target.value)} placeholder="https://linkedin.com/in/…" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ct-company">Empresa</Label>
          <Input id="ct-company" value={form.company} onChange={(e) => set("company", e.target.value)} placeholder="Manpersa SAC" />
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={!valid || busy}>
          {busy ? <Loader2 className="animate-spin" /> : !contact && <Plus />}
          {contact ? "Guardar cambios" : "Crear contacto"}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

const KINDS = [
  { id: undefined, label: "Todos", count: "all" },
  { id: "lead", label: "Leads", count: "lead" },
  { id: "client", label: "Clientes", count: "client" },
] as const;

/**
 * Contactos (prototipo): píldoras Todos / Leads / Clientes, buscador y una fila por persona con su
 * empresa, correo, teléfono y tipo. Al hacer clic se abre el lead del contacto (o su proyecto).
 */
export default function ContactsPage() {
  const role = useSession().data?.role;
  const navigate = useNavigate();
  const table = useTableState({ filterKeys: ["kind"] });
  const { data, isLoading, error } = useContacts(table.query);
  const [creating, setCreating] = useState(false);
  const kind = table.state.filters.kind;
  const open = (c: Contact) => navigate(c.leadId ? `/comercial/leads/${c.leadId}` : c.projectId ? `/operativa/${c.projectId}` : `/comercial/contactos/${c.id}`);
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / table.state.pageSize));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Contactos"
        description="Las personas de contacto de tus leads y clientes."
        actions={
          canWriteCore(role) && !creating ? (
            <Button size="lg" onClick={() => setCreating(true)}>
              <Plus />
              Nuevo <span className="max-sm:hidden">contacto</span>
            </Button>
          ) : undefined
        }
      />
      {creating && <ContactForm onClose={() => setCreating(false)} />}

      <div role="group" aria-label="Tipo de contacto" className="flex flex-wrap gap-2">
        {KINDS.map((k) => {
          const on = kind === k.id;
          return (
            <button key={k.label} type="button" aria-pressed={on} onClick={() => table.set({ filters: { kind: k.id } })} className={cn("inline-flex h-10 items-center gap-2 rounded-full border px-3.5 text-sm", on ? "border-primary bg-accent-soft font-semibold text-accent-text" : "border-border bg-card font-medium hover:border-line-strong hover:bg-muted")}>
              {k.label}
              <span className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs tabular-nums", on ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>{data?.counts?.[k.count] ?? "–"}</span>
            </button>
          );
        })}
      </div>

      <label className="flex h-11 w-full items-center gap-2 rounded-[10px] border border-border bg-muted px-3 text-muted-foreground focus-within:border-foreground sm:w-[24rem]">
        <Search className="size-4 shrink-0" aria-hidden />
        <input aria-label="Buscar contacto" className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none" placeholder="Buscar por nombre, empresa o correo" value={table.state.q} onChange={(e) => table.set({ q: e.target.value })} />
      </label>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error instanceof Error ? error.message : "No se pudieron cargar los contactos."}
        </p>
      ) : isLoading ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : !data?.rows.length ? (
        <p className="rounded-xl border border-dashed border-line-strong px-6 py-10 text-center text-sm text-muted-foreground">{table.state.q || kind ? "Sin resultados · Ajusta la búsqueda o el filtro." : "Aún no hay contactos."}</p>
      ) : (
        <ul aria-label="Contactos" className="space-y-3">
          {data.rows.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => open(c)} className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 rounded-xl border border-border bg-card px-4 py-3.5 text-left transition-colors hover:border-line-strong hover:bg-muted/50 md:grid-cols-[auto_minmax(0,1.5fr)_minmax(0,1.4fr)_9rem_5.5rem_auto]">
                <span aria-hidden className="flex size-9 items-center justify-center rounded-full bg-accent-soft text-sm font-bold text-accent-text">
                  {c.name.trim()[0]?.toUpperCase() ?? "?"}
                </span>
                <span className="min-w-0">
                  <b className="block truncate">{c.name}</b>
                  <span className="block truncate text-sm text-muted-foreground">{c.company ?? "Sin empresa"}</span>
                </span>
                <span className="truncate text-sm max-md:col-start-2 max-md:row-start-2 max-md:text-muted-foreground">{c.emails[0] ?? "—"}</span>
                <span className="truncate text-sm tabular-nums max-md:hidden">{c.phone ?? "—"}</span>
                <span className="max-md:col-start-3 max-md:row-start-1">{c.kind ? <Chip color={c.kind === "client" ? "green" : "blue"}>{c.kind === "client" ? "Cliente" : "Lead"}</Chip> : null}</span>
                <ChevronRight className="size-4 text-muted-foreground max-md:hidden" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      {(data?.total ?? 0) > table.state.pageSize && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {data!.total} contactos · página {table.state.page} de {pages}
          </span>
          <span className="flex gap-2">
            <Button size="icon-sm" variant="outline" aria-label="Página anterior" disabled={table.state.page <= 1} onClick={() => table.set({ page: table.state.page - 1 })}>
              <ChevronLeft />
            </Button>
            <Button size="icon-sm" variant="outline" aria-label="Página siguiente" disabled={table.state.page >= pages} onClick={() => table.set({ page: table.state.page + 1 })}>
              <ChevronRight />
            </Button>
          </span>
        </div>
      )}
    </div>
  );
}
