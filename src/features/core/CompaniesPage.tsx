import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, X } from "lucide-react";
import { DataTable, type Column } from "@/components/data-table/DataTable";
import { useTableState } from "@/components/data-table/table-state";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "@/features/auth/auth";
import { canWriteCore } from "./hooks";
import { COMPANY_FILTERS, COMPANY_SIZE_LABELS, COMPANY_SIZES, coreKeys, createCompany, updateCompany, useCompanies, type Company, type CompanyInput, type CompanyRow, type CompanySize } from "./api";

/** Alta o edición de una empresa (CEO/CCO y Comercial). */
export function CompanyForm({ company, onClose }: { company?: Company; onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: company?.name ?? "",
    domain: company?.domain ?? "",
    industry: company?.industry ?? "",
    size: company?.size ?? "",
    location: company?.location ?? "",
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
    const input: CompanyInput = {
      name: form.name.trim(),
      domain: form.domain.trim() || null,
      industry: form.industry.trim() || null,
      size: (form.size || null) as CompanySize | null,
      location: form.location.trim() || null,
    };
    try {
      if (company) {
        await updateCompany(company.id, input);
        await queryClient.invalidateQueries({ queryKey: ["core"] });
        onClose();
      } else {
        const { company: created } = await createCompany(input);
        await queryClient.invalidateQueries({ queryKey: coreKeys.companies });
        navigate(`/comercial/empresas/${created.id}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la empresa.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-foreground/10 p-4" aria-label={company ? "Editar empresa" : "Nueva empresa"}>
      <div className="flex items-center justify-between">
        <p className="font-medium">{company ? "Editar empresa" : "Nueva empresa"}</p>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Cerrar" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="co-name">Nombre</Label>
          <Input id="co-name" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Manpersa SAC" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="co-domain">Dominio</Label>
          <Input id="co-domain" value={form.domain} onChange={(e) => set("domain", e.target.value)} placeholder="manpersa.com" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="co-industry">Industria</Label>
          <Input id="co-industry" value={form.industry} onChange={(e) => set("industry", e.target.value)} placeholder="Logística" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="co-size">Tamaño</Label>
          <Select
            id="co-size"
            value={form.size || null}
            emptyLabel="Sin definir"
            options={COMPANY_SIZES.map((s) => ({ value: s, label: COMPANY_SIZE_LABELS[s] }))}
            onValueChange={(v) => set("size", (v ?? ""))}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="co-location">País / ubicación</Label>
          <Input id="co-location" value={form.location} onChange={(e) => set("location", e.target.value)} placeholder="Lima, Perú" />
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={!valid || busy}>
          {busy ? <Loader2 className="animate-spin" /> : !company && <Plus />}
          {company ? "Guardar cambios" : "Crear empresa"}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

export default function CompaniesPage() {
  const role = useSession().data?.role;
  const table = useTableState({ filterKeys: COMPANY_FILTERS });
  const { data, isLoading, isFetching, error } = useCompanies(table.query);
  const [creating, setCreating] = useState(false);
  const muted = (v: string | null) => v ?? <span className="text-muted-foreground">—</span>;

  const columns: Column<CompanyRow>[] = [
    { id: "name", header: "Empresa", sortKey: "name", card: "title", cell: (c) => <span className="font-medium">{c.name}</span> },
    { id: "domain", header: "Dominio", cell: (c) => muted(c.domain) },
    { id: "industry", header: "Industria", sortKey: "industry", cell: (c) => muted(c.industry) },
    { id: "size", header: "Tamaño", sortKey: "size", cell: (c) => muted(c.size ? COMPANY_SIZE_LABELS[c.size] : null) },
    { id: "location", header: "Ubicación", sortKey: "location", cell: (c) => muted(c.location) },
    { id: "contacts", header: "Contactos", align: "right", cell: (c) => c.contacts },
    { id: "projects", header: "Proyectos", align: "right", cell: (c) => c.projects },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Empresas</h1>
        <p className="mt-1 text-sm text-muted-foreground sm:text-base">Los clientes y prospectos: sus contactos y sus proyectos.</p>
      </div>
      {creating && <CompanyForm onClose={() => setCreating(false)} />}
      <DataTable
        label="Empresas"
        columns={columns}
        table={table}
        data={data}
        isLoading={isLoading}
        isFetching={isFetching}
        error={error}
        rowKey={(c) => c.id}
        rowHref={(c) => `/comercial/empresas/${c.id}`}
        empty="Aún no hay empresas."
        searchPlaceholder="Buscar por nombre, dominio o industria"
        filters={[{ key: "size", label: "Filtrar por tamaño", all: "Todos los tamaños", options: COMPANY_SIZES.map((s) => ({ value: s, label: COMPANY_SIZE_LABELS[s] })) }]}
        actions={
          canWriteCore(role) && !creating ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus />
              Nueva empresa
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}
