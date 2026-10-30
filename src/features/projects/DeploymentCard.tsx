import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Boxes, ExternalLink, Loader2, Lock, LockOpen, Rocket, RotateCw, Server } from "lucide-react";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ClientDetail } from "@/types/project";
import { redeployClient } from "./api";
import { Code } from "./new-project/parts";
import { useCanOperate } from "@/features/auth/auth";
import { formatShortDateTime } from "@/lib/format";

const dateTime = (iso: string) =>
  formatShortDateTime(iso);

function Row({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
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

/** Despliegue en el VPS. Solo referencias: nunca claves, tokens ni variables de entorno. */
export default function DeploymentCard({ client }: { client: ClientDetail["client"] }) {
  const queryClient = useQueryClient();
  const [requesting, setRequesting] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string; href?: string } | null>(null);
  const { deployment, deployEnabled } = client;
  const canOperate = useCanOperate();
  const canRedeploy = canOperate && deployEnabled && !!deployment.certificate;

  async function handleRedeploy() {
    setRequesting(true);
    setMessage(null);
    try {
      const { actionsUrl } = await redeployClient(client.id);
      setMessage({ tone: "ok", text: "Despliegue lanzado. Puedes seguirlo en GitHub Actions.", href: actionsUrl });
      queryClient.invalidateQueries({ queryKey: ["client", client.id] });
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : "No se pudo lanzar el despliegue." });
    } finally {
      setRequesting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Rocket className="size-4 text-brand-300" />
          Despliegue
        </CardTitle>
        <CardDescription>
          {deployEnabled ? "VPS compartido detrás de nginx, con HTTPS de Let's Encrypt." : "El despliegue aún no está habilitado en la plataforma."}
        </CardDescription>
        {canRedeploy && (
          <CardAction>
            <Button size="sm" variant="outline" onClick={handleRedeploy} disabled={requesting}>
              {requesting ? <Loader2 className="animate-spin" /> : <RotateCw />}
              Redesplegar
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="divide-y divide-foreground/10">
          {client.server && (
            <Row icon={Server} label="Servidor">
              {client.server.name} <span className="text-muted-foreground">· *.{client.server.appsDomain}</span>
            </Row>
          )}
          <Row icon={ExternalLink} label="Aplicación">
            <a href={deployment.appUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
              {deployment.appUrl}
              <ExternalLink className="size-3.5" />
            </a>
          </Row>
          <Row icon={deployment.https?.trusted === false ? LockOpen : Lock} label="HTTPS">
            {deployment.https ? (
              deployment.https.trusted ? (
                <span className="text-ok-fg">Certificado válido · verificado {dateTime(deployment.https.verifiedAt)}</span>
              ) : (
                <span className="text-warn-fg">Funciona con la CA de pruebas (staging): no es de confianza</span>
              )
            ) : deployment.certificate ? (
              <span className="text-muted-foreground">
                Certificado {deployment.certificate === "issued" ? "emitido" : "existente"} · pendiente de verificar por HTTPS
              </span>
            ) : (
              <span className="text-muted-foreground">Sin certificado todavía</span>
            )}
          </Row>
          <Row icon={Boxes} label="Última imagen desplegada">
            {deployment.image?.digest ? (
              <span>
                <Code>{deployment.image.digest}</Code>
                {deployment.image.deployedAt && (
                  <span className="ml-2 text-muted-foreground">{dateTime(deployment.image.deployedAt)}</span>
                )}
              </span>
            ) : (
              <span className="text-muted-foreground">Aún no se ha desplegado</span>
            )}
          </Row>
        </div>
        {deployment.redeployRequestedAt && (
          <p className="text-xs text-muted-foreground">
            Último redespliegue solicitado {dateTime(deployment.redeployRequestedAt)}
            {deployment.redeployRequestedBy && ` por ${deployment.redeployRequestedBy}`}.
          </p>
        )}
        {message && (
          <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "text-sm text-danger-fg" : "text-sm text-ok-fg"}>
            {message.text}{" "}
            {message.href && (
              <a href={message.href} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                Ver en GitHub
              </a>
            )}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
