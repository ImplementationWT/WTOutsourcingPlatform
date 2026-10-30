import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Circle, Loader2, Minus, RotateCcw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { ClientDetail, Deletion } from "@/types/project";
import { deleteClient, fetchDeletion } from "./api";
import { Code } from "./new-project/parts";

function StepIcon({ status }: { status: Deletion["steps"][number]["status"] }) {
  switch (status) {
    case "running":
      return <Loader2 className="size-4 animate-spin text-brand-300" aria-label="En curso" />;
    case "done":
      return <Check className="size-4 text-emerald-400" aria-label="Hecho" />;
    case "skipped":
      return <Minus className="size-4 text-muted-foreground" aria-label="No aplica" />;
    case "warning":
      return <AlertTriangle className="size-4 text-amber-400" aria-label="Aviso" />;
    case "failed":
      return <X className="size-4 text-red-400" aria-label="Falló" />;
    default:
      return <Circle className="size-2.5 fill-foreground/15 text-transparent" aria-label="Pendiente" />;
  }
}

/**
 * Borrado del proyecto y de todo lo que la plataforma creó para él. Irreversible:
 * hay que escribir el identificador exacto. El progreso se consulta cada 1,5 s.
 */
export default function DeleteProjectCard({ client, repository, database }: { client: ClientDetail["client"]; repository: string; database: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [deletion, setDeletion] = useState<Deletion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const running = deletion?.status === "running";

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(async () => {
      try {
        const next = await fetchDeletion(client.id);
        setDeletion(next);
        if (next.status === "succeeded") {
          queryClient.invalidateQueries({ queryKey: ["projects"] });
          queryClient.invalidateQueries({ queryKey: ["dashboard"] });
        }
      } catch {
        // Se reintenta en el siguiente ciclo.
      }
    }, 1_500);
    return () => clearInterval(timer);
  }, [running, client.id, queryClient]);

  async function handleDelete() {
    setSubmitting(true);
    setError(null);
    try {
      setDeletion(await deleteClient(client.id, confirm));
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo iniciar el borrado.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="border-red-400/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-red-300">
          <Trash2 className="size-4" />
          Zona de peligro
        </CardTitle>
        <CardDescription>Borrar el proyecto elimina todo lo que la plataforma creó para él. No se puede deshacer.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {deletion ? (
          <>
            <ul className="space-y-2">
              {deletion.steps.map((step) => (
                <li key={step.id} className="flex gap-3 text-sm">
                  <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                    <StepIcon status={step.status} />
                  </span>
                  <span className="min-w-0">
                    <span className={step.status === "pending" ? "text-muted-foreground" : ""}>{step.label}</span>
                    {step.detail && <span className="block break-words text-xs text-muted-foreground">{step.detail}</span>}
                  </span>
                </li>
              ))}
            </ul>
            {deletion.status === "succeeded" && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-200">
                Proyecto borrado.
                <Button size="sm" nativeButton={false} render={<Link to="/projects" />}>
                  Volver a proyectos
                </Button>
              </div>
            )}
            {deletion.status === "failed" && (
              <div className="space-y-3">
                <p role="alert" className="rounded-md border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                  {deletion.error?.message ?? "El borrado se detuvo."} Lo ya borrado no se repite al reintentar.
                </p>
                <Button size="sm" variant="destructive" onClick={handleDelete} disabled={submitting}>
                  {submitting ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                  Reintentar el borrado
                </Button>
              </div>
            )}
          </>
        ) : !open ? (
          <Button variant="destructive" onClick={() => setOpen(true)}>
            <Trash2 />
            Eliminar proyecto
          </Button>
        ) : (
          <div className="space-y-4">
            <div className="text-sm">
              <p className="font-medium">Se borrará:</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
                <li>
                  Servidor: la app de <Code>{client.deployment.host ?? client.deployment.appUrl}</Code>, su sitio de nginx, el certificado HTTPS, la clave SSH, el puerto y sus archivos.
                </li>
                <li>
                  GitHub: el repositorio <Code>{repository}</Code> y su imagen en GHCR.
                </li>
                <li>
                  MongoDB: los datos de <Code>{database}</Code> y su usuario de Atlas.
                </li>
                <li>Los registros del proyecto en la plataforma (la auditoría se conserva).</li>
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">El DNS no se toca: el registro comodín es compartido por todos los proyectos.</p>
            </div>
            <label className="block space-y-2 text-sm">
              <span>
                Para confirmar, escribe <Code>{client.id}</Code>
              </span>
              <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" spellCheck={false} aria-label="Identificador del proyecto" />
            </label>
            {error && (
              <p role="alert" className="text-sm text-red-300">
                {error}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="destructive" onClick={handleDelete} disabled={confirm !== client.id || submitting}>
                {submitting ? <Loader2 className="animate-spin" /> : <Trash2 />}
                Borrar definitivamente
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setOpen(false);
                  setConfirm("");
                }}
              >
                Cancelar
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
