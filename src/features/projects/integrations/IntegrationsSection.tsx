import { useFormContext, useWatch } from "react-hook-form";
import { Plug } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useIntegrationCatalog } from "../api";
import type { NewProjectValues } from "../new-project/schema";
import IntegrationFields from "./IntegrationFields";

/** Interruptor accesible (role="switch"). */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex h-6 w-11 shrink-0 items-center rounded-full border border-foreground/15 p-0.5 transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50",
        checked ? "bg-brand-500/80" : "bg-foreground/10",
      )}
    >
      <span className={cn("size-4.5 rounded-full bg-background shadow transition-transform", checked && "translate-x-5")} />
    </button>
  );
}

/**
 * Integraciones opcionales del asistente, pintadas desde el catálogo del backend.
 * Las credenciales viven solo en el estado del formulario.
 */
export default function IntegrationsSection() {
  const { data: catalog, isLoading } = useIntegrationCatalog();
  const { control, setValue, clearErrors, formState } = useFormContext<NewProjectValues>();
  const integrations = useWatch({ control, name: "integrations" }) ?? {};
  const rawError = formState.errors.integrations?.message;
  const error = typeof rawError === "string" ? rawError : undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Plug className="size-4" />
          Integraciones
        </CardTitle>
        <CardDescription>Opcionales. La credencial se guarda solo como secret cifrado en el repositorio del cliente.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-14 rounded-lg" />
        ) : !catalog?.available ? (
          <p className="text-sm text-muted-foreground">Las integraciones no están disponibles en este servidor.</p>
        ) : (
          catalog.providers.map((provider) => {
            const state = integrations[provider.id] ?? { enabled: false, credentials: {} };
            return (
              <div key={provider.id} className="space-y-3">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="font-medium">{provider.label}</p>
                    <p className="text-sm text-muted-foreground">{provider.description}</p>
                  </div>
                  <Switch
                    checked={state.enabled}
                    label={`Activar ${provider.label}`}
                    onChange={(enabled) => {
                      clearErrors("integrations");
                      // Al desactivar se descarta la credencial escrita.
                      setValue(`integrations.${provider.id}`, { enabled, credentials: enabled ? state.credentials : {} });
                    }}
                  />
                </div>
                {state.enabled && (
                  <IntegrationFields
                    provider={provider}
                    values={state.credentials}
                    onChange={(field, value) => {
                      clearErrors("integrations");
                      setValue(`integrations.${provider.id}.credentials`, { ...state.credentials, [field]: value });
                    }}
                  />
                )}
              </div>
            );
          })
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
