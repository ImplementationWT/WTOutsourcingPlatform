import { useState } from "react";
import { Link } from "react-router-dom";
import { Archive, BarChart3, Copy, Download, ExternalLink, Eye, FileCode2, Lock, MoreHorizontal, Pencil, RotateCcw, Settings2, Trash2 } from "lucide-react";
import { Chip } from "@/components/ui/chip";
import { useConfirm } from "@/components/ui/confirm-context";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/format";
import { errorText, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { sitesApi, useSitesRefresh, type Site } from "./api";
import { CustomizeSiteDialog, SiteStatsDialog, UpdateSiteDialog } from "./SiteDialogs";

const iconButton = "inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] border border-border bg-card text-foreground transition-[background-color,border-color,transform] hover:border-line-strong hover:bg-muted active:scale-[.97]";

/** Abre el sitio marcando este navegador como del equipo (esa visita no cuenta en las estadísticas). */
async function openSite(site: Site) {
  const tab = window.open("about:blank", "_blank");
  let url = site.url;
  try {
    const { mark } = await sitesApi.teamMark();
    if (mark) url = `${site.url}/__team?${new URLSearchParams({ t: mark, next: "/" })}`;
  } catch {
    // Sin la marca, se abre igual (esa visita contará).
  }
  if (tab) tab.location.href = url;
  else window.open(url, "_blank", "noopener");
}

/** Tarjeta de una propuesta (prototipo `.pprop`): enlace, modificación y acciones. */
function SiteCard({ site, canWrite, showLinks, onUpdate, onStats, onCustomize }: { site: Site; canWrite: boolean; showLinks: boolean; onUpdate: () => void; onStats: () => void; onCustomize: () => void }) {
  const refresh = useSitesRefresh();
  const confirm = useConfirm();
  const host = site.url.replace(/^https?:\/\//, "");
  const run = async (action: () => Promise<unknown>, done: string, undo?: () => Promise<unknown>) => {
    try {
      await action();
      await refresh();
      toast.success(done, undo ? { undo: async () => { await undo(); await refresh(); } } : undefined);
    } catch (err) {
      toast.error("No se pudo completar la acción.", { description: errorText(err, "Inténtalo de nuevo.") });
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(site.url);
      toast.success("Enlace copiado");
    } catch {
      toast.error("No se pudo copiar el enlace.");
    }
  };
  const purge = async () => {
    const ok = await confirm({ title: `¿Eliminar ${host} para siempre?`, description: "Se borran los archivos y sus estadísticas, y el enlace deja de funcionar. No se puede deshacer.", confirmLabel: "Eliminar definitivamente", tone: "danger" });
    if (ok) await run(() => sitesApi.remove(site.id), "Propuesta eliminada");
  };
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-border bg-card px-4 py-3.5">
      <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-accent-soft text-accent-text">
        <FileCode2 className="size-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-2">
          <a href={site.url} target="_blank" rel="noreferrer" onClick={(e) => { e.preventDefault(); void openSite(site); }} className="truncate text-sm hover:underline">
            {host}
          </a>
          {site.access.mode === "password" && <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-label="Con contraseña" />}
          {site.domain === "pending" && <Chip color="amber">Publicando</Chip>}
          {site.domain === "error" && <Chip color="red" title="WTProposalPlatform reintenta al restaurar la propuesta">Error HTTPS</Chip>}
        </p>
        <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
          <span>Modificado {formatDate(site.updatedAt)}</span>
          {showLinks && site.lead && (
            <Link to={`/comercial/leads/${site.lead.id}`} className="font-medium text-accent-text hover:underline">
              · {site.lead.name}
            </Link>
          )}
          {showLinks && site.project && (
            <Link to={`/operativa/${site.project.id}`} className="font-medium text-accent-text hover:underline">
              · {site.project.name}
            </Link>
          )}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {canWrite && site.status === "live" && (
          <button type="button" onClick={onUpdate} className={cn(iconButton, "w-auto gap-2 px-3.5 text-sm font-semibold")}>
            <Pencil className="size-4" aria-hidden /> Actualizar
          </button>
        )}
        <button type="button" aria-label={`Abrir ${host}`} title="Ver" onClick={() => void openSite(site)} className={iconButton} disabled={site.status !== "live"}>
          <Eye className="size-4" />
        </button>
        <button type="button" aria-label={`Estadísticas de ${host}`} title="Estadísticas" onClick={onStats} className={iconButton}>
          <BarChart3 className="size-4" />
        </button>
        <button type="button" aria-label={`Copiar enlace de ${host}`} title="Copiar enlace" onClick={() => void copy()} className={iconButton}>
          <Copy className="size-4" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger aria-label={`Más acciones de ${host}`} className={cn(iconButton, "data-[popup-open]:bg-muted")}>
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6} className="w-56">
            {site.status === "live" && (
              <DropdownMenuItem onClick={() => void openSite(site)}>
                <ExternalLink /> Abrir el sitio
              </DropdownMenuItem>
            )}
            {canWrite && site.status === "live" && (
              <DropdownMenuItem onClick={onCustomize}>
                <Settings2 /> Personalizar
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => window.open(sitesApi.downloadUrl(site.id), "_self")}>
              <Download /> Descargar ZIP
            </DropdownMenuItem>
            {canWrite && (
              <>
                <DropdownMenuSeparator />
                {site.status === "live" && (
                  <DropdownMenuItem onClick={() => void run(() => sitesApi.setStatus(site.id, "archived"), "Propuesta archivada", () => sitesApi.setStatus(site.id, "live"))}>
                    <Archive /> Archivar
                  </DropdownMenuItem>
                )}
                {site.status !== "live" && (
                  <DropdownMenuItem onClick={() => void run(() => sitesApi.setStatus(site.id, "live"), "Propuesta publicada de nuevo")}>
                    <RotateCcw /> {site.status === "deleted" ? "Restaurar" : "Publicar de nuevo"}
                  </DropdownMenuItem>
                )}
                {site.status !== "deleted" ? (
                  <DropdownMenuItem variant="destructive" onClick={() => void run(() => sitesApi.setStatus(site.id, "deleted"), "Propuesta en la papelera", () => sitesApi.setStatus(site.id, site.status))}>
                    <Trash2 /> Borrar
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem variant="destructive" onClick={() => void purge()}>
                    <Trash2 /> Eliminar definitivamente
                  </DropdownMenuItem>
                )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

/** Lista de propuestas (tarjetas) con sus ventanas de actualizar, personalizar y estadísticas. */
export function SitesList({ sites, isLoading, canWrite, showLinks = true, empty }: { sites: Site[] | undefined; isLoading: boolean; canWrite: boolean; showLinks?: boolean; empty: string }) {
  const [updating, setUpdating] = useState<Site | null>(null);
  const [stats, setStats] = useState<Site | null>(null);
  const [customizing, setCustomizing] = useState<Site | null>(null);
  if (isLoading) return <Skeleton className="h-20 w-full rounded-xl" />;
  return (
    <>
      {!sites?.length ? (
        <p className="rounded-xl border border-dashed border-line-strong px-6 py-10 text-center text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-3">
          {sites.map((s) => (
            <SiteCard key={s.id} site={s} canWrite={canWrite} showLinks={showLinks} onUpdate={() => setUpdating(s)} onStats={() => setStats(s)} onCustomize={() => setCustomizing(s)} />
          ))}
        </ul>
      )}
      <UpdateSiteDialog site={updating} onClose={() => setUpdating(null)} />
      <SiteStatsDialog site={stats} onClose={() => setStats(null)} />
      {customizing && <CustomizeSiteDialog key={customizing.id} site={customizing} onClose={() => setCustomizing(null)} />}
    </>
  );
}
