import { useState } from "react";
import { Link } from "react-router-dom";
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
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { LinkedAccount, ProjectRepo } from "@/types/project";
import { useProjects } from "./api";
import { deriveResources } from "./config";
import { accountStatusMeta, providerMeta } from "./meta";
import StatusLabel from "./StatusLabel";

/**
 * GitHub es la única cuenta que se consulta de verdad. Los repos creados por la
 * plataforma ({slug}-app) muestran además MongoDB y dominio, que aún no se aprovisionan.
 */
function linkedAccounts(repo: ProjectRepo): (LinkedAccount & { href?: string })[] {
  const accounts: (LinkedAccount & { href?: string })[] = [
    { provider: "github", label: repo.fullName, status: "connected", href: repo.url },
  ];
  // Solo los repos que creó la plataforma tienen base y subdominio propios.
  if (repo.clientId) {
    const names = deriveResources(repo.clientId);
    const status = repo.clientStatus === "ready" ? "connected" : repo.clientStatus === "failed" ? "error" : "pending";
    accounts.push(
      { provider: "mongodb", label: names.database, status },
      { provider: "domain", label: names.subdomain, status },
    );
  }
  return accounts;
}

export default function ProjectsPage() {
  const { data: projects, isLoading, isError, error, refetch, isFetching } = useProjects();
  const [search, setSearch] = useState("");

  const query = search.trim().toLowerCase();
  const filtered = (projects ?? []).filter((repo) => repo.name.toLowerCase().includes(query));

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
        <div className="flex flex-wrap items-center gap-4">
          <div className="relative w-full max-w-sm">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Buscar proyecto…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          {projects && (
            <span className="text-sm text-muted-foreground tabular-nums">
              {filtered.length} de {projects.length} {projects.length === 1 ? "proyecto" : "proyectos"}
            </span>
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
            <div className="flex size-12 items-center justify-center rounded-xl border border-white/10 bg-white/5">
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
        <p className="text-sm text-muted-foreground">No hay proyectos que coincidan con “{search}”.</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {filtered.map((repo) => (
            <ProjectCard key={repo.id} repo={repo} />
          ))}
        </div>
      )}
    </section>
  );
}

function ProjectCard({ repo }: { repo: ProjectRepo }) {
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

      <CardContent>
        <div>
          <p className="mb-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">
            Cuentas ligadas
          </p>
          <ul className="divide-y rounded-lg border">
            {linkedAccounts(repo).map((account) => {
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
                      title={`Abrir ${account.label} en GitHub`}
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
