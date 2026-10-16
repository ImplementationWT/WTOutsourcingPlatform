import { getProvider, type IntegrationProvider } from "../../integrations/catalog.js";
import { FatalError } from "../../lib/errors.js";
import { registerSecret } from "../../lib/redact.js";
import type { Deps, Stage, StageContext } from "../types.js";

export function requireProvider(id: string): IntegrationProvider {
  const provider = getProvider(id);
  if (!provider) throw new FatalError("integration_unknown", `Integración desconocida: ${id}.`);
  return provider;
}

/**
 * Escribe las credenciales de un proveedor como secrets del entorno production
 * (nombres del contrato), cifradas con la clave pública del entorno. Reescribir el
 * mismo valor en un reintento es válido. Las credenciales solo pasan por memoria.
 */
export async function writeIntegrationSecrets(
  deps: Deps,
  repository: string,
  provider: IntegrationProvider,
  credentials: Record<string, string>
) {
  const environment = deps.config.template.environment;
  for (const field of provider.fields) {
    const value = credentials[field.name];
    if (!value) throw new FatalError("integration_incomplete", `Falta ${field.label} de ${provider.label}.`);
    registerSecret(value);
    await deps.github.putEnvironmentSecret(repository, environment, field.envVar, value);
  }
  return provider.fields.map((f) => f.envVar);
}

/** Marca la integración como configurada (solo estado y fechas). */
export async function markConfigured(ctx: Pick<StageContext, "store" | "client">, providerId: string) {
  const current = (await ctx.store.getClient(ctx.client._id))?.integrations?.[providerId];
  const now = new Date();
  await ctx.store.setClientFields(ctx.client._id, {
    [`integrations.${providerId}`]: {
      enabled: true,
      requestedAt: current?.requestedAt ?? now,
      configuredAt: current?.configuredAt ?? now,
      updatedAt: now
    }
  });
  return { firstTime: !current?.configuredAt };
}

function integrationOf(ctx: StageContext) {
  const integration = ctx.job.integration;
  if (!integration) throw new FatalError("integration_missing", "El trabajo no indica qué integración actualizar.");
  return { ...integration, provider: requireProvider(integration.provider) };
}

/** PUT sobre un cliente listo: escribe la credencial (ya validada y cifrada en tránsito). */
export const integrationSecretStage: Stage = {
  name: "integration_secret",
  async run(ctx) {
    const { provider } = integrationOf(ctx);
    const { deps, names, client } = ctx;
    await ctx.report(`Escribiendo la credencial de ${provider.label}…`);
    const credentials = await deps.secrets.get(client._id, provider.id);
    if (!credentials) {
      throw new FatalError(
        "integration_credential_expired",
        `La credencial de ${provider.label} ya no está disponible (caducó o se borró). Vuelve a introducirla desde el detalle del cliente.`
      );
    }
    const written = await writeIntegrationSecrets(deps, names.repository, provider, credentials);
    const { firstTime } = await markConfigured(ctx, provider.id);
    await deps.secrets.delete(client._id, provider.id);
    await ctx.audit(firstTime ? "integration_enabled" : "integration_updated", names.repositoryFullName, {
      provider: provider.id,
      names: written
    });
    await ctx.report(`${provider.label}: credencial escrita en el entorno production (${written.join(", ")}).`);
  }
};

/** DELETE: borra los secrets del proveedor; el redespliegue posterior quita la variable de la app. */
export const integrationRemoveStage: Stage = {
  name: "integration_remove",
  async run(ctx) {
    const { provider } = integrationOf(ctx);
    const { deps, names, client, store } = ctx;
    await ctx.report(`Quitando ${provider.label}…`);
    for (const field of provider.fields) {
      await deps.github.deleteEnvironmentSecret(names.repository, deps.config.template.environment, field.envVar);
    }
    await deps.secrets.delete(client._id, provider.id);
    await store.unsetClientFields(client._id, [`integrations.${provider.id}`]);
    await ctx.audit("integration_removed", names.repositoryFullName, { provider: provider.id, names: provider.fields.map((f) => f.envVar) });
    await ctx.report(`${provider.label} desactivada: secrets borrados del entorno production.`);
  }
};
