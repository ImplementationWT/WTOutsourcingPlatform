import { Link } from "react-router-dom";
import { ArrowLeft, ArrowRight, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import InitialCredentialsCard from "../InitialCredentialsCard";
import JobStages from "../JobStages";
import { formatDuration, type useProvisioning } from "../provisioning";
import { Pill } from "./parts";

type Provisioning = ReturnType<typeof useProvisioning>;

export default function ProvisioningPanel({
  projectName,
  provisioning,
  onBack,
}: {
  projectName: string;
  provisioning: Provisioning;
  onBack: () => void;
}) {
  const { job, submitError, streamError, submitting, retry } = provisioning;

  // Error antes de crear el trabajo (validación, slug existente, sesión…).
  if (!job && submitError) {
    return (
      <div className="space-y-6">
        <p role="alert" className="rounded-md border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {submitError.message}
        </p>
        <div className="flex items-center justify-between border-t border-foreground/10 pt-6">
          <Button type="button" variant="ghost" onClick={onBack}>
            <ArrowLeft />
            Volver al resumen
          </Button>
          {submitError.existingClientId && (
            <Button nativeButton={false} render={<Link to={`/projects/${submitError.existingClientId}`} />}>
              Ver el proyecto existente
              <ArrowRight />
            </Button>
          )}
        </div>
      </div>
    );
  }

  const elapsed =
    job && formatDuration(job.stages.reduce((sum, s) => sum + (s.durationMs ?? 0), 0));
  const headline = !job
    ? "Creando el trabajo…"
    : job.status === "succeeded"
      ? "Proyecto listo"
      : job.status === "failed"
        ? "El aprovisionamiento se detuvo"
        : "Aprovisionando proyecto…";

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {(!job || job.status === "running" || job.status === "queued") && (
              <Loader2 className="size-4 animate-spin text-violet-300" />
            )}
            {headline}
          </CardTitle>
          <CardDescription>
            {projectName}
            {elapsed && ` · ${elapsed}`}
          </CardDescription>
          <CardAction>
            {job?.status === "succeeded" && <Pill tone="emerald">Ready</Pill>}
            {job?.status === "failed" && (
              <span className="rounded-full border border-red-400/25 bg-red-400/10 px-2.5 py-0.5 text-xs font-medium text-red-300">
                Error
              </span>
            )}
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          {job ? (
            <JobStages job={job} />
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Conectando con el servidor…
            </p>
          )}
          {(streamError || submitError) && (
            <p role="status" className="text-sm text-amber-200">
              {submitError?.message ?? streamError}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Al terminar: con qué credenciales entrar por primera vez a la app del cliente. */}
      {job?.status === "succeeded" && <InitialCredentialsCard slug={job.clientId} />}

      <div className="flex items-center justify-between border-t border-foreground/10 pt-6">
        {job?.status === "failed" ? (
          <>
            <Button nativeButton={false} variant="ghost" render={<Link to={`/projects/${job.clientId}`} />}>
              Ver detalle
            </Button>
            <Button type="button" onClick={retry} disabled={submitting}>
              {submitting ? <Loader2 className="animate-spin" /> : <RotateCcw />}
              Reintentar desde la etapa fallida
            </Button>
          </>
        ) : job?.status === "succeeded" ? (
          <>
            <span />
            <Button nativeButton={false} render={<Link to={`/projects/${job.clientId}`} />}>
              Ver proyecto
              <ArrowRight />
            </Button>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Puedes salir de esta página: el servidor continúa el trabajo y podrás seguirlo desde el detalle del proyecto.
          </p>
        )}
      </div>
    </div>
  );
}
