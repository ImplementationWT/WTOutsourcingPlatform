import { type ReactNode, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, CircleDashed, Fingerprint, KeyRound, Loader2, RefreshCw, Server, ShieldCheck, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { textareaClass } from "@/features/ai/ChatPanel";
import { Code } from "@/features/projects/new-project/parts";
import type { DeployServer, ServerCheck } from "@/types/server";
import { bootstrapCommands } from "./bootstrap";
import CommandBlock from "./CommandBlock";
import { deleteServer, pinHostKey, readFingerprint, rotateServerKey, verifyServer } from "./api";

const STATUS: Record<DeployServer["status"], { label: string; className: string }> = {
  host_key: { label: "Falta confirmar la huella", className: "border-amber-400/30 text-amber-300" },
  verify: { label: "Pendiente de verificar", className: "border-amber-400/30 text-amber-300" },
  ready: { label: "Listo", className: "border-emerald-400/30 text-emerald-300" },
};

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <div
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium",
          done ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-300" : "border-foreground/20 text-muted-foreground",
        )}
      >
        {done ? <Check className="size-3.5" /> : n}
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm font-medium">{title}</p>
        {children}
      </div>
    </li>
  );
}

function Checks({ checks }: { checks: ServerCheck[] }) {
  return (
    <ul className="space-y-1.5 text-sm">
      {checks.map((check) => (
        <li key={check.id} className="flex items-start gap-2">
          {check.ok ? (
            <Check className="mt-0.5 size-4 shrink-0 text-emerald-400" />
          ) : check.required ? (
            <X className="mt-0.5 size-4 shrink-0 text-red-400" />
          ) : (
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" />
          )}
          <span>
            {check.label}
            {check.detail && <span className="text-muted-foreground"> · {check.detail}</span>}
            {!check.ok && !check.required && <span className="text-muted-foreground"> (opcional)</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Un servidor: datos, pasos para dejarlo listo (preparar, huella, verificar) y acciones. */
export default function ServerCard({ server, ghcrOrg }: { server: DeployServer; ghcrOrg: string | null }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [consoleOutput, setConsoleOutput] = useState("");
  const [seen, setSeen] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);

  async function act(name: string, fn: () => Promise<unknown>) {
    setBusy(name);
    setError(null);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: ["servers"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo completar la acción.");
    } finally {
      setBusy(null);
    }
  }

  const status = STATUS[server.status];
  const checks = server.verification?.checks ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Server className="size-4 text-violet-300" />
          {server.name}
          <Badge variant="outline" className={status.className}>
            {status.label}
          </Badge>
          {server.primary && <Badge variant="outline">Configuración de la plataforma</Badge>}
        </CardTitle>
        <CardDescription>
          Apps en <Code>{`<proyecto>.${server.appsDomain}`}</Code> · SSH {server.host}
          {server.sshPort && server.sshPort !== 22 ? `:${server.sshPort}` : ""} · IP {server.publicIp} · {server.projects} proyecto
          {server.projects === 1 ? "" : "s"}
        </CardDescription>
        {!server.primary && server.status === "ready" && (
          <CardAction>
            <Button size="sm" variant="outline" onClick={() => act("verify", () => verifyServer(server.id))} disabled={busy !== null}>
              {busy === "verify" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Verificar de nuevo
            </Button>
          </CardAction>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {server.primary ? (
          <p className="text-sm text-muted-foreground">
            Definido en la configuración de la plataforma (DEPLOY_HOST, DEPLOY_HOST_KEY y la clave del provisioner del despliegue).
            Los proyectos creados antes de los servidores múltiples están aquí.
          </p>
        ) : server.status !== "ready" ? (
          <ol className="space-y-5">
            <Step n={1} title="Prepara el VPS" done={server.status !== "host_key"}>
              <p className="text-sm text-muted-foreground">
                Crea antes el registro DNS <Code>{`*.${server.appsDomain}`}</Code> tipo A → <Code>{server.publicIp}</Code>. Launchpad generó
                una clave solo para este servidor: aquí va su parte pública; la privada nunca sale de la plataforma.
              </p>
              <CommandBlock label="Comandos para preparar el VPS">{bootstrapCommands(server, ghcrOrg)}</CommandBlock>
            </Step>

            <Step n={2} title="Confirma la huella del servidor" done={server.status === "verify"}>
              {server.hostKeyFingerprint ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Fingerprint className="size-4" /> Fijada: <Code>{server.hostKeyFingerprint}</Code>
                </p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    En la consola del VPS (la del proveedor, no por SSH desde aquí) ejecuta y pega el resultado. Launchpad solo fija la clave
                    si coincide con la que le presenta el servidor: así nadie puede suplantarlo.
                  </p>
                  <CommandBlock label="Comando para ver la huella">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</CommandBlock>
                  <textarea
                    rows={2}
                    value={consoleOutput}
                    onChange={(e) => setConsoleOutput(e.target.value)}
                    placeholder="256 SHA256:… root@servidor (ED25519)"
                    aria-label="Salida de ssh-keygen"
                    className={cn(textareaClass, "font-mono text-xs")}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => act("pin", () => pinHostKey(server.id, consoleOutput))}
                      disabled={busy !== null || !consoleOutput.trim()}
                    >
                      {busy === "pin" ? <Loader2 className="animate-spin" /> : <Fingerprint />}
                      Confirmar huella
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => act("read", async () => setSeen((await readFingerprint(server.id)).fingerprint))}
                      disabled={busy !== null}
                    >
                      {busy === "read" ? <Loader2 className="animate-spin" /> : <CircleDashed />}
                      Ver la que recibe Launchpad
                    </Button>
                    {seen && <Code>{seen}</Code>}
                  </div>
                </>
              )}
            </Step>

            <Step n={3} title="Verifica el servidor" done={false}>
              <p className="text-sm text-muted-foreground">
                Comprueba la conexión con la clave y la huella, los scripts, <Code>platform.conf</Code>, nginx, Docker, certbot y el DNS
                comodín. Solo los servidores verificados se pueden elegir al crear un proyecto.
              </p>
              {server.verification?.error && (
                <p role="alert" className="text-sm text-red-300">
                  {server.verification.error}
                </p>
              )}
              {checks.length > 0 && <Checks checks={checks} />}
              <Button
                size="sm"
                onClick={() => act("verify", () => verifyServer(server.id))}
                disabled={busy !== null || server.status === "host_key"}
              >
                {busy === "verify" ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                Verificar
              </Button>
            </Step>
          </ol>
        ) : (
          checks.length > 0 && <Checks checks={checks} />
        )}

        {error && (
          <p role="alert" className="text-sm text-red-300">
            {error}
          </p>
        )}

        {!server.primary && (
          <div className="flex flex-wrap items-center gap-2 border-t border-foreground/10 pt-4">
            {confirmRotate ? (
              <>
                <span className="text-xs text-muted-foreground">
                  Se genera una clave nueva: habrá que repetir el paso 3 del VPS (bootstrap con la nueva clave) y verificar.
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    act("rotate", async () => {
                      await rotateServerKey(server.id);
                      setConfirmRotate(false);
                    })
                  }
                  disabled={busy !== null}
                >
                  {busy === "rotate" && <Loader2 className="animate-spin" />}
                  Rotar
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setConfirmRotate(false)}>
                  Cancelar
                </Button>
              </>
            ) : (
              <Button size="xs" variant="ghost" onClick={() => setConfirmRotate(true)} disabled={busy !== null}>
                <KeyRound />
                Rotar clave
              </Button>
            )}

            {confirmDelete === null ? (
              <Button
                size="xs"
                variant="ghost"
                className="text-red-300"
                onClick={() => setConfirmDelete("")}
                disabled={busy !== null || server.projects > 0}
                title={server.projects > 0 ? "Tiene proyectos: bórralos antes" : undefined}
              >
                <Trash2 />
                Quitar
              </Button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={confirmDelete}
                  onChange={(e) => setConfirmDelete(e.target.value)}
                  placeholder={server.appsDomain}
                  aria-label="Escribe el dominio para confirmar"
                  className="h-7 w-56 text-xs"
                />
                <Button
                  size="xs"
                  variant="destructive"
                  onClick={() => act("delete", () => deleteServer(server.id, confirmDelete))}
                  disabled={busy !== null || confirmDelete !== server.appsDomain}
                >
                  {busy === "delete" && <Loader2 className="animate-spin" />}
                  Quitar servidor
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setConfirmDelete(null)}>
                  Cancelar
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
