import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, X } from "lucide-react";
import { DataTable, type Column } from "@/components/data-table/DataTable";
import { useTableState } from "@/components/data-table/table-state";
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

export default function ContactsPage() {
  const role = useSession().data?.role;
  const table = useTableState();
  const { data, isLoading, isFetching, error } = useContacts(table.query);
  const [creating, setCreating] = useState(false);
  const muted = (v: string | null | undefined) => v || <span className="text-muted-foreground">—</span>;

  const columns: Column<Contact>[] = [
    { id: "name", header: "Contacto", sortKey: "name", card: "title", cell: (c) => <span className="font-medium">{c.name}</span> },
    { id: "title", header: "Cargo", sortKey: "title", cell: (c) => muted(c.title) },
    { id: "company", header: "Empresa", sortKey: "company", cell: (c) => muted(c.company) },
    { id: "emails", header: "Correo", cell: (c) => muted(c.emails[0]) },
    { id: "phone", header: "Teléfono", cell: (c) => muted(c.phone) },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Contactos"
        description="Las personas de cada empresa, con sus leads, deals y proyectos."
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
      />
    </div>
  );
}
