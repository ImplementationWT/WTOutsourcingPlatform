import { useId, useState } from "react";
import { CheckCircle2, ExternalLink, Eye, EyeOff, Loader2, PlugZap, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { IntegrationProvider, ValidationOutcome } from "@/types/project";
import { validateIntegration } from "../api";
import { fieldClass } from "../new-project/parts";

/**
 * Campos de credenciales de un proveedor del catálogo, con ayuda y "Probar conexión".
 * Los valores los guarda el componente padre (estado del formulario), nunca aquí
 * ni en almacenamiento del navegador.
 */
export default function IntegrationFields({
  provider,
  values,
  onChange,
  disabled,
}: {
  provider: IntegrationProvider;
  values: Record<string, string>;
  onChange: (field: string, value: string) => void;
  disabled?: boolean;
}) {
  const baseId = useId();
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [testing, setTesting] = useState(false);
  const [outcome, setOutcome] = useState<ValidationOutcome | { ok: false; error: string; code?: undefined } | null>(null);
  const complete = provider.fields.every((f) => (values[f.name] ?? "").trim().length > 0);

  async function test() {
    setTesting(true);
    setOutcome(null);
    try {
      setOutcome(await validateIntegration(provider.id, values));
    } catch (e) {
      setOutcome({ ok: false, error: e instanceof Error ? e.message : "No se pudo probar la conexión." });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-foreground/10 bg-foreground/[0.03] p-4">
      {provider.fields.map((field) => {
        const id = `${baseId}-${field.name}`;
        const secret = field.type === "secret";
        const shown = visible[field.name] ?? false;
        return (
          <div key={field.name} className="space-y-2">
            <label htmlFor={id} className="text-sm font-medium">
              {field.label}
            </label>
            <div className="flex gap-2">
              <Input
                id={id}
                type={secret && !shown ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                data-1p-ignore
                data-lpignore="true"
                maxLength={field.maxLength}
                placeholder={field.placeholder}
                value={values[field.name] ?? ""}
                onChange={(e) => {
                  onChange(field.name, e.target.value.trim());
                  setOutcome(null);
                }}
                disabled={disabled}
                className={fieldClass}
              />
              {secret && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setVisible((v) => ({ ...v, [field.name]: !shown }))}
                  aria-label={shown ? `Ocultar ${field.label}` : `Mostrar ${field.label}`}
                  aria-pressed={shown}
                  disabled={disabled}
                  className="size-10"
                >
                  {shown ? <EyeOff /> : <Eye />}
                </Button>
              )}
            </div>
          </div>
        );
      })}

      <ul className="space-y-1 text-xs text-muted-foreground">
        {provider.help.map((line) => (
          <li key={line}>{line}</li>
        ))}
        <li>
          <a href={provider.helpUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
            Documentación de {provider.label}
            <ExternalLink className="size-3" />
          </a>
        </li>
      </ul>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={test} disabled={!complete || testing || disabled}>
          {testing ? <Loader2 className="animate-spin" /> : <PlugZap />}
          Probar conexión
        </Button>
        <span role="status" aria-live="polite" className="text-sm">
          {outcome?.ok === true && (
            <span className="inline-flex items-center gap-1.5 text-emerald-400">
              <CheckCircle2 className="size-4" />
              Conexión correcta
            </span>
          )}
          {outcome && outcome.ok === false && (
            <span className="inline-flex items-center gap-1.5 text-red-300">
              <XCircle className="size-4" />
              {outcome.error}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
