import { useState } from "react";
import { Search, Upload } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useSites, useSitesConfig, type Site, type SiteStatus } from "./api";
import { UploadSiteDialog } from "./SiteDialogs";
import { SitesList } from "./SitesList";

const TABS: { id: SiteStatus; label: string }[] = [
  { id: "live", label: "Publicadas" },
  { id: "archived", label: "Archivadas" },
  { id: "deleted", label: "Papelera" },
];

const matches = (s: Site, q: string) => !q || [s.name, s.lead?.name, s.project?.name].some((v) => v?.toLowerCase().includes(q.toLowerCase()));

/**
 * Propuestas (prototipo): cada propuesta es un sitio HTML con enlace propio en WTProposalPlatform.
 * Se suben aquí o desde el lead; actualizar, ver, estadísticas, copiar el enlace y el menú ⋯.
 */
export default function SitesPage() {
  const [status, setStatus] = useState<SiteStatus>("live");
  const [q, setQ] = useState("");
  const [uploading, setUploading] = useState(false);
  const config = useSitesConfig();
  const { data, isLoading, error } = useSites(status);
  const canWrite = data?.canWrite ?? false;
  const sites = data?.items.filter((s) => matches(s, q.trim()));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Propuestas"
        description={<span className="max-sm:hidden">Adjunta una propuesta a partir de un HTML y compártela con un enlace propio.</span>}
        actions={
          canWrite ? (
            <Button size="lg" onClick={() => setUploading(true)}>
              <Upload /> Subir <span className="max-sm:hidden">propuesta</span>
            </Button>
          ) : undefined
        }
      />

      {config.data && !config.data.configured ? (
        <p role="alert" className="rounded-[14px] border border-[var(--chip-amber-fg)] bg-card px-5 py-4 text-sm">
          Propuestas aún no está conectada a WTProposalPlatform. Falta configurar <code>PROPOSAL_SITES_URL</code> y <code>PROPOSAL_SITES_KEY_PATH</code> en la API (ver docs/migracion-prototipo.md).
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex h-11 w-full items-center gap-2 rounded-[10px] border border-border bg-muted px-3 text-muted-foreground focus-within:border-foreground sm:w-[26rem]">
              <Search className="size-4 shrink-0" aria-hidden />
              <input aria-label="Buscar propuesta" className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none" placeholder="Buscar propuesta o lead" value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            <div role="tablist" aria-label="Estado" className="flex flex-wrap gap-1.5 sm:ml-auto">
              {TABS.map((t) => (
                <button key={t.id} role="tab" type="button" aria-selected={status === t.id} onClick={() => setStatus(t.id)} className={cn("inline-flex h-10 items-center gap-2 rounded-full border px-3.5 text-sm", status === t.id ? "border-primary bg-accent-soft font-semibold text-accent-text" : "border-border bg-card font-medium hover:bg-muted")}>
                  {t.label}
                  <span className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs tabular-nums", status === t.id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>{data?.counts[t.id] ?? "–"}</span>
                </button>
              ))}
            </div>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error instanceof Error ? error.message : "No se pudieron cargar las propuestas."}
            </p>
          ) : (
            <SitesList sites={sites} isLoading={isLoading} canWrite={canWrite} empty={q ? "Ninguna propuesta coincide con la búsqueda." : status === "live" ? "Aún no hay propuestas publicadas. Sube la primera con «Subir propuesta»." : "No hay propuestas aquí."} />
          )}
        </>
      )}

      {uploading && <UploadSiteDialog open onClose={() => setUploading(false)} />}
    </div>
  );
}
