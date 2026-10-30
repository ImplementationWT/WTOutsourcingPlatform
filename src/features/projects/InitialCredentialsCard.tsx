import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Copy, Eye, ExternalLink, KeyRound, Loader2, ShieldAlert, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { RevealedCredentials } from "@/types/project";
import { revealInitialPassword, useClient } from "./api";
import { Code } from "./new-project/parts";
import { useCanOperate } from "@/features/auth/auth";
import { formatTime } from "@/lib/format";

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      aria-label={label}
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="text-ok-fg" /> : <Copy />}
    </Button>
  );
}

function Row({ icon: Icon, label, children }: { icon: typeof User; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-foreground/10 bg-foreground/5">
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">{label}</p>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-sm">{children}</div>
      </div>
    </div>
  );
}

const time = (iso: string) => formatTime(iso);

/**
 * Credenciales de primer ingreso a la app del cliente. La contraseña generada
 * solo se puede ver una vez: tras mostrarla vive únicamente en el estado de
 * este componente (no en la caché de consultas) y el servidor ya la borró.
 */
export default function InitialCredentialsCard({ slug }: { slug: string }) {
  const canOperate = useCanOperate();
  const queryClient = useQueryClient();
  const { data } = useClient(slug);
  const [revealed, setRevealed] = useState<RevealedCredentials | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!data) return null;
  const { initialAdmin: status, readiness } = data.client;
  const appUrl = data.resources.baseUrl;

  async function handleReveal() {
    setRevealing(true);
    setError(null);
    try {
      setRevealed(await revealInitialPassword(slug));
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo mostrar la contraseña.");
    } finally {
      setRevealing(false);
      queryClient.invalidateQueries({ queryKey: ["client", slug] });
    }
  }

  let password: React.ReactNode;
  if (revealed) {
    password = (
      <>
        <Code>{revealed.password}</Code>
        <CopyButton value={revealed.password} label="Copiar contraseña" />
      </>
    );
  } else if (status.state === "available") {
    password = (
      <>
        <span className="font-mono tracking-widest text-muted-foreground">••••••••••••</span>
        {canOperate && (
          <Button type="button" size="xs" onClick={handleReveal} disabled={revealing}>
            {revealing ? <Loader2 className="animate-spin" /> : <Eye />}
            Mostrar contraseña inicial
          </Button>
        )}
      </>
    );
  } else if (status.state === "default") {
    password = (
      <span className="text-muted-foreground">
        La del template por defecto: <Code>admin123</Code>
      </span>
    );
  } else {
    const messages: Record<string, string> = {
      pending: "Se generará al escribir los secrets del entorno production.",
      revealed: `Ya se mostró${status.revealedAt ? ` a las ${time(status.revealedAt)}` : ""}${status.revealedBy ? ` (${status.revealedBy})` : ""} y se eliminó.`,
      expired: "Venció el plazo de 30 minutos para verla; se eliminó y no se puede mostrar.",
      unavailable: "Se generó en un intento anterior y ya no está disponible. No se puede mostrar.",
    };
    password = <span className="text-muted-foreground">{messages[status.state]}</span>;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4 text-brand-300" />
          Credenciales de primer ingreso
        </CardTitle>
        <CardDescription>
          {status.state === "available" && !revealed
            ? `La contraseña solo se puede ver una vez${status.expiresAt ? `, hasta las ${time(status.expiresAt)}` : ""}. Cópiala al mostrarla.`
            : "Usuario administrador inicial de la aplicación del cliente."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Row icon={ExternalLink} label="Aplicación">
          <a href={appUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
            {appUrl}
            <ExternalLink className="size-3.5" />
          </a>
          {!readiness.ready && <span className="text-xs text-muted-foreground">(aún no desplegada)</span>}
        </Row>
        <Row icon={User} label="Usuario">
          <Code>{status.username}</Code>
          <CopyButton value={status.username} label="Copiar usuario" />
        </Row>
        <Row icon={KeyRound} label="Contraseña">
          {password}
        </Row>

        {revealed && (
          <p role="status" className="flex items-start gap-2 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn-fg">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            Esta es la única vez que se muestra: el servidor ya la eliminó. Entrégala por un canal seguro.
          </p>
        )}
        {status.state !== "pending" && (
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
            La aplicación obliga a cambiar esta contraseña en el primer ingreso.
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger-fg">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
