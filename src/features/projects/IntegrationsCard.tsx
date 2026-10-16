import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Hourglass, Loader2, Plug, Power, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ClientDetail, IntegrationProvider } from "@/types/project";
import { removeIntegration, saveIntegration, useIntegrationCatalog } from "./api";
import IntegrationFields from "./integrations/IntegrationFields";

const dateTime = (iso: string) => new Date(iso).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

/** Una fila por proveedor: estado, actualizar la credencial o desactivar. */
function ProviderRow({ client, provider }: { client: ClientDetail["client"]; provider: IntegrationProvider }) {
  const queryClient = useQueryClient();
  const state = client.integrations.find((i) => i.provider === provider.id);
  const [mode, setMode] = useState<"idle" | "edit" | "confirm-remove">("idle");
  // La credencial solo vive aquí, en el estado del componente, y se borra al guardar o cancelar.
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const editable = client.status === "ready" || client.status === "failed";
  const complete = provider.fields.every((f) => (credentials[f.name] ?? "").length > 0);

  function close() {
    setCredentials({});
    setMode("idle");
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await saveIntegration(client.id, provider.id, credentials);
      const text =
        result.action === "redeploy"
          ? "Credencial guardada. Se está redesplegando la app (sigue el progreso en Aprovisionamiento)."
          : (result.message ?? "Credencial guardada.");
      setMessage({ tone: "ok", text });
      close();
      queryClient.invalidateQueries({ queryKey: ["client", client.id] });
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : "No se pudo guardar la credencial." });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setMessage(null);
    try {
      await removeIntegration(client.id, provider.id);
      setMessage({ tone: "ok", text: `Desactivando ${provider.label}: se borra el secret y se redespliega la app.` });
      setMode("idle");
      queryClient.invalidateQueries({ queryKey: ["client", client.id] });
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : "No se pudo desactivar." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium">{provider.label}</p>
          <p className="mt-0.5 text-sm">
            {!state ? (
              <span className="text-muted-foreground">Desactivada</span>
            ) : state.configuredAt ? (
              <span className="inline-flex items-center gap-1.5 text-emerald-400">
                <CheckCircle2 className="size-4" />
                Activa · configurada {dateTime(state.updatedAt ?? state.configuredAt)}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-sky-400">
                <Hourglass className="size-4" />
                Pendiente: se escribirá al completar el aprovisionamiento
              </span>
            )}
          </p>
        </div>
        {mode === "idle" && editable && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setMode("edit")}>
              <Plug />
              {state ? "Actualizar credencial" : "Activar"}
            </Button>
            {state && client.status === "ready" && (
              <Button size="sm" variant="ghost" onClick={() => setMode("confirm-remove")}>
                <Power />
                Desactivar
              </Button>
            )}
          </div>
        )}
      </div>

      {mode === "edit" && (
        <>
          <IntegrationFields provider={provider} values={credentials} onChange={(field, value) => setCredentials((c) => ({ ...c, [field]: value }))} disabled={busy} />
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={!complete || busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Save />}
              Guardar
            </Button>
            <Button size="sm" variant="ghost" onClick={close} disabled={busy}>
              Cancelar
            </Button>
          </div>
        </>
      )}

      {mode === "confirm-remove" && (
        <div className="space-y-3 rounded-md border border-amber-400/30 bg-amber-500/10 p-3 text-sm">
          <p>
            Se borrará la credencial de {provider.label} del repositorio y se redesplegará la app: dejará de mostrar los tableros. ¿Desactivar?
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" onClick={remove} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Power />}
              Sí, desactivar
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode("idle")} disabled={busy}>
              Cancelar
            </Button>
          </div>
        </div>
      )}

      {message && (
        <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "text-sm text-red-300" : "text-sm text-emerald-300"}>
          {message.text}
        </p>
      )}
    </div>
  );
}

/** Integraciones del cliente: estado y fechas (nunca valores), con acciones. */
export default function IntegrationsCard({ client }: { client: ClientDetail["client"] }) {
  const { data: catalog } = useIntegrationCatalog();
  if (!catalog?.available || !catalog.providers.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Plug className="size-4 text-violet-300" />
          Integraciones
        </CardTitle>
        <CardDescription>Las credenciales se guardan solo como secrets cifrados del repositorio del cliente.</CardDescription>
      </CardHeader>
      <CardContent className="divide-y divide-foreground/10 [&>*]:py-4 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
        {catalog.providers.map((provider) => (
          <ProviderRow key={provider.id} client={client} provider={provider} />
        ))}
      </CardContent>
    </Card>
  );
}
