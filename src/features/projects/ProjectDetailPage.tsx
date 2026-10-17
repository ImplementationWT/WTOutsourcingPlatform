import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  Database,
  ExternalLink,
  FolderGit2,
  Globe,
  KeyRound,
  Layers,
  Loader2,
  RotateCcw,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useClient } from "./api";
import DeleteProjectCard from "./DeleteProjectCard";
import DeploymentCard from "./DeploymentCard";
import InitialCredentialsCard from "./InitialCredentialsCard";
import IntegrationsCard from "./IntegrationsCard";
import JobStages from "./JobStages";
import { Code } from "./new-project/parts";
import { isFinished, retryJob, useJobStream } from "./provisioning";

function ResourceRow({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 py-3 first:pt-0 last:pb-0">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-foreground/10 bg-foreground/5">
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">{label}</p>
        <div className="mt-0.5 truncate text-sm">{children}</div>
      </div>
    </div>
  );
}

export default function ProjectDetailPage() {
  const { slug = "" } = useParams();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error } = useClient(slug);
  const [generation, setGeneration] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  // Mientras el trabajo no termine, se sigue en vivo.
  const initialJob = data?.job ?? null;
  const live = useJobStream(initialJob && (!isFinished(initialJob) || generation > 0) ? initialJob.id : null, generation);
  const job = live.job ?? initialJob;

  async function handleRetry() {
    if (!job) return;
    setRetrying(true);
    setRetryError(null);
    try {
      await retryJob(job.id);
      setGeneration((g) => g + 1);
      queryClient.invalidateQueries({ queryKey: ["client", slug] });
    } catch (e) {
      setRetryError(e instanceof Error ? e.message : "No se pudo reintentar.");
    } finally {
      setRetrying(false);
    }
  }

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <Link to="/projects" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />
        Proyectos
      </Link>

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-48 rounded-xl" />
        </div>
      ) : isError || !data ? (
        <Card>
          <CardContent className="flex items-center gap-3 text-sm">
            <AlertTriangle className="size-5 text-amber-400" />
            {error?.message ?? "No se encontró el proyecto."}
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">{data.client.name}</h1>
              <p className="mt-2 text-muted-foreground">{data.client.description}</p>
            </div>
            {data.client.status === "ready" && (
              <Button render={<Link to={`/projects/${slug}/ai`} />} nativeButton={false}>
                <Bot />
                AI Developer
              </Button>
            )}
          </div>

          <div className="grid gap-6 lg:grid-cols-5">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Recursos</CardTitle>
                <CardDescription>Referencias; las credenciales nunca se muestran.</CardDescription>
              </CardHeader>
              <CardContent className="divide-y divide-foreground/10">
                <ResourceRow icon={FolderGit2} label="Repositorio">
                  {data.resources.repository.url ? (
                    <a
                      href={data.resources.repository.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
                    >
                      {data.resources.repository.fullName}
                      <ExternalLink className="size-3.5" />
                    </a>
                  ) : (
                    <span className="text-muted-foreground">{data.resources.repository.fullName} (pendiente)</span>
                  )}
                </ResourceRow>
                <ResourceRow icon={Database} label="Base de datos">
                  <Code>{data.resources.database}</Code>
                </ResourceRow>
                <ResourceRow icon={KeyRound} label="Usuario de la base">
                  <Code>{data.resources.databaseUser}</Code>
                </ResourceRow>
                <ResourceRow icon={Layers} label="Template">
                  {data.client.template ? (
                    <span>
                      <Code>
                        {data.client.template.name}@{data.client.template.version}
                      </Code>
                      <span className="ml-2 text-muted-foreground">
                        {data.client.template.schemaVersion !== null
                          ? `schemaVersion ${data.client.template.schemaVersion}`
                          : "schemaVersion pendiente"}
                      </span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Pendiente de verificar</span>
                  )}
                </ResourceRow>
                <ResourceRow icon={Globe} label="Aplicación">
                  {data.client.readiness.ready ? (
                    <a
                      href={data.resources.baseUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
                    >
                      {data.resources.subdomain}
                      <ExternalLink className="size-3.5" />
                    </a>
                  ) : (
                    data.resources.subdomain
                  )}
                </ResourceRow>
                <ResourceRow icon={data.client.readiness.ready ? CheckCircle2 : Loader2} label="Readiness">
                  {data.client.readiness.ready ? (
                    <span className="text-emerald-400">
                      Listo{data.client.readiness.detail && ` · ${data.client.readiness.detail}`}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      {data.client.status === "failed"
                        ? "No listo (el aprovisionamiento falló)"
                        : data.client.status === "ready" && !data.client.deployEnabled
                          ? "Repo y base conectados · el despliegue no está habilitado"
                          : "Pendiente"}
                    </span>
                  )}
                </ResourceRow>
              </CardContent>
            </Card>

            <Card className="lg:col-span-3">
              <CardHeader>
                <CardTitle>Aprovisionamiento</CardTitle>
                <CardDescription>
                  {job ? `Trabajo ${job.id.slice(0, 8)} · ${job.status}` : "Sin trabajos"}
                </CardDescription>
                {job?.status === "failed" && (
                  <CardAction>
                    <Button size="sm" onClick={handleRetry} disabled={retrying}>
                      {retrying ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                      Reintentar
                    </Button>
                  </CardAction>
                )}
              </CardHeader>
              <CardContent className="space-y-3">
                {job && <JobStages job={job} />}
                {(retryError || live.error) && <p className="text-sm text-amber-200">{retryError ?? live.error}</p>}
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <DeploymentCard client={data.client} />
            <InitialCredentialsCard slug={data.client.id} />
          </div>

          <IntegrationsCard client={data.client} />

          {/* Sin borrar mientras se aprovisiona: el servidor lo rechazaría. */}
          {job && isFinished(job) && (
            <DeleteProjectCard
              client={data.client}
              repository={data.resources.repository.fullName}
              database={data.resources.database}
            />
          )}
        </>
      )}
    </section>
  );
}
