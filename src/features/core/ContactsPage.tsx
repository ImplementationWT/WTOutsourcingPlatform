import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, X } from "lucide-react";
import { DataTable, tableSelectClass, type Column } from "@/components/data-table/DataTable";
import { RelationCell } from "@/components/data-table/cells";
import { useTableState } from "@/components/data-table/table-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "@/features/auth/auth";
import { cn } from "@/lib/utils";
import { CONTACT_FILTERS, createContact, updateContact, useCompanyOptions, useContacts, type Contact, type ContactInput } from "./api";
import { canWriteCore } from "./hooks";

/**
 * Alta o edición de un contacto. `companyId` fija la empresa (desde su detalle); con `stay` el alta
 * no navega al contacto nuevo.
 */
export function ContactForm({ contact, companyId, onClose, stay }: { contact?: Contact; companyId?: string; onClose: () => void; stay?: boolean }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const companies = useCompanyOptions(!companyId).data ?? [];
  const [form, setForm] = useState({
    name: contact?.name ?? "",
    emails: contact?.emails.join(", ") ?? "",
    phone: contact?.phone ?? "",
    title: contact?.title ?? "",
    linkedinUrl: contact?.linkedinUrl ?? "",
    companyId: companyId ?? contact?.company?.id ?? "",
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
      companyId: form.companyId || null,
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
        {!companyId && (
          <div className="space-y-1.5">
            <Label htmlFor="ct-company">Empresa</Label>
            <select id="ct-company" className={cn(tableSelectClass, "w-full")} value={form.companyId} onChange={(e) => set("companyId", e.target.value)}>
              <option value="">Sin empresa</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}
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

export default function ContactsPage() {
  const role = useSession().data?.role;
  const table = useTableState({ filterKeys: CONTACT_FILTERS });
  const { data, isLoading, isFetching, error } = useContacts(table.query);
  const companies = useCompanyOptions().data ?? [];
  const [creating, setCreating] = useState(false);
  const muted = (v: string | null | undefined) => v || <span className="text-muted-foreground">—</span>;

  const columns: Column<Contact>[] = [
    { id: "name", header: "Contacto", sortKey: "name", card: "title", cell: (c) => <span className="font-medium">{c.name}</span> },
    { id: "title", header: "Cargo", sortKey: "title", cell: (c) => muted(c.title) },
    { id: "company", header: "Empresa", cell: (c) => <RelationCell to={c.company ? `/comercial/empresas/${c.company.id}` : null}>{c.company?.name}</RelationCell> },
    { id: "emails", header: "Correo", cell: (c) => muted(c.emails[0]) },
    { id: "phone", header: "Teléfono", cell: (c) => muted(c.phone) },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Contactos</h1>
        <p className="mt-1 text-sm text-muted-foreground sm:text-base">Las personas de cada empresa, con sus leads, deals y proyectos.</p>
      </div>
      {creating && <ContactForm onClose={() => setCreating(false)} />}
      <DataTable
        label="Contactos"
        columns={columns}
        table={table}
        data={data}
        isLoading={isLoading}
        isFetching={isFetching}
        error={error}
        rowKey={(c) => c.id}
        rowHref={(c) => `/comercial/contactos/${c.id}`}
        empty="Aún no hay contactos."
        searchPlaceholder="Buscar por nombre, correo o cargo"
        filters={[{ key: "companyId", label: "Filtrar por empresa", all: "Todas las empresas", options: companies.map((c) => ({ value: c.id, label: c.name })) }]}
        actions={
          canWriteCore(role) && !creating ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus />
              Nuevo contacto
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}
