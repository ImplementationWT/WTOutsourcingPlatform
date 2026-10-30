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
import { searchProjects } from "./filters";
import { accountStatusMeta, providerMeta } from "./meta";
import StatusLabel from "./StatusLabel";
import TopicsEditor from "./TopicsEditor";
import { useCanOperate } from "@/features/auth/auth";

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

export default function ProjectsPage() {
  const { data: projects, isLoading, isError, error, refetch, isFetching } = useProjects();
  const canOperate = useCanOperate();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  // La búsqueda vive en la URL para poder compartirla.
  const setQuery = (value: string) => setParams(value ? { q: value } : {}, { replace: true });
  // Pulsar una etiqueta de una tarjeta la busca (y pulsarla otra vez quita la búsqueda).
  const searchTag = (tag: string) => setQuery(q === tag ? "" : tag);

  const filtered = searchProjects(projects ?? [], q);

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Apps y repositorios</h1>
          <p className="mt-1 text-sm text-muted-foreground sm:text-base">
            Repositorios de GitHub de la organización y sus cuentas ligadas.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn(isFetching && "animate-spin")} />
            Actualizar
          </Button>
          {canOperate && (
            <Button render={<Link to="/projects/new" />} nativeButton={false}>
              <Plus />
              Nueva app
            </Button>
          )}
        </div>
      </div>

      {!isError && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-4">
            <div className="relative w-full max-w-sm">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Buscar por nombre, descripción o etiqueta…"
                value={q}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-8"
              />
            </div>
            {projects && (
              <span className="text-sm text-muted-foreground tabular-nums">
                {filtered.length} de {projects.length} {projects.length === 1 ? "proyecto" : "proyectos"}
              </span>
            )}
            {q && (
              <Button size="sm" variant="ghost" onClick={() => setQuery("")}>
                <X />
                Limpiar búsqueda
              </Button>
            )}
          </div>

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
              {canOperate
                ? "Crea el primero y la plataforma generará su repositorio en GitHub."
                : "Los proyectos los crean los team leaders y developers de cada equipo."}
            </p>
            {canOperate && (
              <Button className="mt-6" render={<Link to="/projects/new" />} nativeButton={false}>
                <Plus />
                Nueva app
              </Button>
            )}
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">Ningún proyecto coincide con la búsqueda.</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {filtered.map((repo) => (
            <ProjectCard key={repo.id} repo={repo} activeTags={q ? [q] : []} onToggleTag={searchTag} />
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
  const canOperate = useCanOperate();
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
        <TopicsEditor repo={repo} activeTags={activeTags} onToggleTag={onToggleTag} editable={canOperate && Boolean(repo.clientId)} />
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
