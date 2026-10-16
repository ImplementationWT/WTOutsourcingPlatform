import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  Archive,
  ExternalLink,
  FolderGit2,
  Lock,
  Plus,
  RefreshCw,
  Search,
  Unlock,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { LinkedAccount, ProjectRepo } from "@/types/project";
import { usePlatform, useProjects } from "./api";
import { deriveResources } from "./config";
import { applyFilters, hasActiveFilters, type ProjectFilters, readFilters, tagCounts, writeFilters } from "./filters";
import { accountStatusMeta, providerMeta } from "./meta";
import StatusLabel from "./StatusLabel";
import TopicsEditor from "./TopicsEditor";

type Platform = ReturnType<typeof usePlatform>["data"];
type Account = LinkedAccount & { href?: string; hrefTitle?: string };

/**
 * Cuentas ligadas con enlace a cada servicio: el repo en GitHub, la base en la
 * consola de MongoDB Atlas y el subdominio publicado. Solo los repos que creó la
 * plataforma ({slug}-app) tienen base y subdominio propios.
 */
function linkedAccounts(repo: ProjectRepo, platform: Platform): Account[] {
  const accounts: Account[] = [
    { provider: "github", label: repo.fullName, status: "connected", href: repo.url, hrefTitle: `Abrir ${repo.fullName} en GitHub` },
  ];
  if (repo.clientId) {
    const names = deriveResources(repo.clientId, platform?.appBaseDomain);
    const status = repo.clientStatus === "ready" ? "connected" : repo.clientStatus === "failed" ? "error" : "pending";
    accounts.push(
      {
        provider: "mongodb",
        label: names.database,
        status,
        href: platform?.atlas.consoleUrl ?? undefined,
        hrefTitle: platform ? `Abrir el clúster ${platform.atlas.clusterName} en MongoDB Atlas` : undefined,
      },
      {
        provider: "domain",
        label: names.subdomain,
        status,
        href: `https://${names.subdomain}`,
        hrefTitle: `Abrir https://${names.subdomain}`,
      },
    );
  }
  return accounts;
}

/** Botón de filtro con estado pulsado (aria-pressed). */
function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded-full border px-3 text-xs font-medium transition-colors",
        active
          ? "border-violet-400/60 bg-violet-500/20 text-violet-200"
          : "border-foreground/15 text-muted-foreground hover:border-foreground/30 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function FilterRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-20 shrink-0 text-xs font-medium tracking-wider text-muted-foreground uppercase">{label}</span>
      {children}
    </div>
  );
}

const STATUS_OPTIONS = [
  ["ready", "Listo"],
  ["provisioning", "Aprovisionando"],
  ["failed", "Fallido"],
] as const;

export default function ProjectsPage() {
  const { data: projects, isLoading, isError, error, refetch, isFetching } = useProjects();
  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);

  const update = (patch: Partial<ProjectFilters>) => setParams(writeFilters({ ...filters, ...patch }), { replace: true });
  const toggleTag = (tag: string) =>
    update({ tags: filters.tags.includes(tag) ? filters.tags.filter((t) => t !== tag) : [...filters.tags, tag] });

  const all = projects ?? [];
  const filtered = applyFilters(all, filters);
  const tags = tagCounts(all);
  // Las etiquetas del filtro que ya no existen siguen visibles para poder quitarlas.
  const missingTags = filters.tags.filter((t) => !tags.some(([tag]) => tag === t));

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Proyectos</h1>
          <p className="mt-2 text-muted-foreground">
            Repositorios de GitHub de la organización y sus cuentas ligadas.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn(isFetching && "animate-spin")} />
            Actualizar
          </Button>
          <Button render={<Link to="/projects/new" />} nativeButton={false}>
            <Plus />
            Nuevo proyecto
          </Button>
        </div>
      </div>

      {!isError && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-4">
            <div className="relative w-full max-w-sm">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Buscar por nombre, descripción o etiqueta…"
                value={filters.q}
                onChange={(e) => update({ q: e.target.value })}
                className="pl-8"
              />
            </div>
            {projects && (
              <span className="text-sm text-muted-foreground tabular-nums">
                {filtered.length} de {projects.length} {projects.length === 1 ? "proyecto" : "proyectos"}
              </span>
            )}
            {hasActiveFilters(filters) && (
              <Button size="sm" variant="ghost" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                <X />
                Limpiar filtros
              </Button>
            )}
          </div>

          {projects && projects.length > 0 && (
            <div className="space-y-2">
              <FilterRow label="Origen">
                <Chip active={filters.origin === "all"} onClick={() => update({ origin: "all", status: null })}>
                  Todos
                </Chip>
                <Chip active={filters.origin === "platform"} onClick={() => update({ origin: "platform" })}>
                  Creados por la plataforma
                </Chip>
                <Chip active={filters.origin === "other"} onClick={() => update({ origin: "other", status: null })}>
                  Otros repos
                </Chip>
                <span className="mx-1 h-4 w-px bg-foreground/15" aria-hidden />
                <Chip active={filters.hideArchived} onClick={() => update({ hideArchived: !filters.hideArchived })}>
                  <Archive className="size-3" />
                  Ocultar archivados
                </Chip>
              </FilterRow>
              {filters.origin !== "other" && (
                <FilterRow label="Estado">
                  {STATUS_OPTIONS.map(([value, label]) => (
                    <Chip
                      key={value}
                      active={filters.status === value}
                      onClick={() => update({ status: filters.status === value ? null : value, origin: "platform" })}
                    >
                      {label}
                    </Chip>
                  ))}
                </FilterRow>
              )}
              <FilterRow label="Etiquetas">
                {tags.length === 0 && missingTags.length === 0 ? (
                  <span className="text-xs text-muted-foreground">
                    Ningún proyecto tiene etiquetas todavía: añádelas desde cada tarjeta.
                  </span>
                ) : (
                  <>
                    {tags.map(([tag, count]) => (
                      <Chip key={tag} active={filters.tags.includes(tag)} onClick={() => toggleTag(tag)}>
                        #{tag}
                        <span className="tabular-nums opacity-60">{count}</span>
                      </Chip>
                    ))}
                    {missingTags.map((tag) => (
                      <Chip key={tag} active onClick={() => toggleTag(tag)}>
                        #{tag}
                        <span className="tabular-nums opacity-60">0</span>
                      </Chip>
                    ))}
                  </>
                )}
              </FilterRow>
            </div>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-60 rounded-xl" />
          ))}
        </div>
      ) : isError ? (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-4">
            <AlertTriangle className="size-5 shrink-0 text-amber-400" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">No se pudieron cargar los proyectos</p>
              <p className="mt-0.5 text-sm text-muted-foreground">{error.message}</p>
            </div>
            <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={cn(isFetching && "animate-spin")} />
              Reintentar
            </Button>
          </CardContent>
        </Card>
      ) : projects?.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-10 text-center">
            <div className="flex size-12 items-center justify-center rounded-xl border border-foreground/10 bg-foreground/5">
              <FolderGit2 className="size-6" />
            </div>
            <p className="mt-4 font-medium">Aún no hay proyectos</p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Crea el primero y la plataforma generará su repositorio en GitHub.
            </p>
            <Button className="mt-6" render={<Link to="/projects/new" />} nativeButton={false}>
              <Plus />
              Nuevo proyecto
            </Button>
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">Ningún proyecto coincide con los filtros.</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {filtered.map((repo) => (
            <ProjectCard key={repo.id} repo={repo} activeTags={filters.tags} onToggleTag={toggleTag} />
          ))}
        </div>
      )}
    </section>
  );
}

function ProjectCard({
  repo,
  activeTags,
  onToggleTag,
}: {
  repo: ProjectRepo;
  activeTags: string[];
  onToggleTag: (tag: string) => void;
}) {
  const platform = usePlatform().data;
  return (
    <Card className={cn(repo.archived && "opacity-70")}>
      <CardHeader>
        <CardTitle className="flex min-w-0 items-center gap-2">
          {repo.clientId ? (
            <Link to={`/projects/${repo.clientId}`} className="truncate underline-offset-4 hover:underline">
              {repo.name}
            </Link>
          ) : (
            <span className="truncate">{repo.name}</span>
          )}
          <Badge variant="outline" className="shrink-0">
            {repo.private ? <Lock /> : <Unlock />}
            {repo.private ? "Privado" : "Público"}
          </Badge>
          {repo.archived && (
            <Badge variant="outline" className="shrink-0">
              <Archive />
              Archivado
            </Badge>
          )}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        {repo.description && <p className="-mt-2 text-sm text-muted-foreground">{repo.description}</p>}
        <TopicsEditor repo={repo} activeTags={activeTags} onToggleTag={onToggleTag} />
        <div>
          <p className="mb-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">
            Cuentas ligadas
          </p>
          <ul className="divide-y rounded-lg border">
            {linkedAccounts(repo, platform).map((account) => {
              const provider = providerMeta[account.provider];
              const Icon = provider.icon;
              return (
                <li
                  key={`${account.provider}-${account.label}`}
                  className="flex items-center gap-3 px-3 py-2 text-sm"
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="w-20 shrink-0 font-medium">{provider.name}</span>
                  {account.href ? (
                    <a
                      href={account.href}
                      target="_blank"
                      rel="noreferrer"
                      title={account.hrefTitle}
                      className="group inline-flex min-w-0 flex-1 items-center gap-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                      <span className="truncate">{account.label}</span>
                      <ExternalLink className="size-3.5 shrink-0 opacity-60 group-hover:opacity-100" />
                    </a>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{account.label}</span>
                  )}
                  <StatusLabel meta={accountStatusMeta[account.status]} />
                </li>
              );
            })}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
