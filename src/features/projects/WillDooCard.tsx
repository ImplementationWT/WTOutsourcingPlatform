import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useCanOperate } from "@/features/auth/auth";
import { cn } from "@/lib/utils";
import type { ClientDetail, WillDooMode } from "@/types/project";
import { setWillDooMode } from "./api";

const OPTIONS: { mode: WillDooMode; title: string; description: string }[] = [
  {
    mode: "claude",
    title: "Will Doo + Claude",
    description: "Chat libre: responde con los datos vivos, entiende la pantalla y analiza. Requiere la clave de Anthropic de la cuenta del cliente.",
  },
  {
    mode: "basic",
    title: "Will Doo solo",
    description: "Por defecto. Informativo, sin IA y sin costo: consultas rápidas sobre los datos que existen y la guía de uso.",
  },
  { mode: "off", title: "Sin Will Doo", description: "Will no aparece en la app." },
];

/** Plantilla 1.7.0 o posterior (antes no hay Will Doo en la app). */
function supportsWillDoo(version: string | undefined) {
  if (!version) return false;
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 1 || (major === 1 && minor >= 7);
}

/** Elige el modo de Will Doo de la app del cliente (variable WILL_DOO_MODE + redespliegue). */
export default function WillDooCard({ client }: { client: ClientDetail["client"] }) {
  const queryClient = useQueryClient();
  const canOperate = useCanOperate();
  const current = client.willDoo?.mode ?? "basic";
  const [selected, setSelected] = useState<WillDooMode>(current);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const hasKey = Boolean(client.integrations.find((i) => i.provider === "anthropic")?.configuredAt);
  const supported = supportsWillDoo(client.template?.version);
  const editable = canOperate && client.status === "ready";

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await setWillDooMode(client.id, selected);
      setMessage({
        tone: "ok",
        text: result.redeploy ? "Guardado. Se está redesplegando la app para aplicarlo." : "Guardado. Se aplicará en el próximo despliegue.",
      });
      await queryClient.invalidateQueries({ queryKey: ["client", client.id] });
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : "No se pudo guardar." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="size-4 text-violet-300" />
          Will Doo
        </CardTitle>
        <CardDescription>
          El co-pilot de la app: solo consulta datos, siempre con los permisos de cada usuario.
          {!supported && " Necesita la plantilla 1.7.0 o posterior: en este proyecto aún no aparece."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div role="radiogroup" aria-label="Modo de Will Doo" className="grid gap-2 md:grid-cols-3">
          {OPTIONS.map((option) => {
            const needsKey = option.mode === "claude" && !hasKey;
            const disabled = !editable || busy || needsKey;
            return (
              <button
                key={option.mode}
                type="button"
                role="radio"
                aria-checked={selected === option.mode}
                disabled={disabled}
                onClick={() => setSelected(option.mode)}
                className={cn(
                  "rounded-lg border p-3 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                  selected === option.mode ? "border-violet-400/60 bg-violet-500/10" : "border-foreground/10 hover:border-foreground/25",
                )}
              >
                <span className="flex items-center justify-between gap-2 font-medium">
                  {option.title}
                  {current === option.mode && <span className="text-xs font-normal text-muted-foreground">Actual</span>}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">{option.description}</span>
                {needsKey && <span className="mt-1.5 block text-xs text-amber-300">Primero guarda la clave de Anthropic en Integraciones.</span>}
              </button>
            );
          })}
        </div>
        {editable && (
          <Button size="sm" onClick={save} disabled={busy || selected === current}>
            {busy && <Loader2 className="animate-spin" />}
            Guardar
          </Button>
        )}
        {message && <p className={cn("text-sm", message.tone === "ok" ? "text-emerald-400" : "text-red-300")}>{message.text}</p>}
      </CardContent>
    </Card>
  );
}
