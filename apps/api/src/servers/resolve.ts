import type { ServerAdapter } from "../adapters/server.js";
import { FatalError } from "../lib/errors.js";
import type { ProvisioningConfig } from "../jobs/types.js";
import type { ClientDoc } from "../store/models.js";
import { type DeployTarget, PRIMARY_SERVER_ID, type ServerTargets } from "./directory.js";

type ServerDeps = { config: ProvisioningConfig; server: ServerAdapter; servers?: ServerTargets };
type WithServer = Pick<ClientDoc, "server"> | null | undefined;

/**
 * Servidor de un proyecto: el que se eligió al crearlo o, si no tiene (proyectos
 * anteriores), el principal de la configuración. undefined si no hay ninguno configurado.
 */
export async function serverFor(deps: ServerDeps, client: WithServer): Promise<DeployTarget | undefined> {
  const id = client?.server?.id;
  if (id && id !== PRIMARY_SERVER_ID) {
    if (!deps.servers) throw new FatalError("server_not_found", "El servidor del proyecto no está disponible en la plataforma.");
    return deps.servers.target(id);
  }
  const primary = deps.config.server;
  return primary ? { id: PRIMARY_SERVER_ID, name: "Principal", ...primary, appsDomain: deps.config.appsDomain, adapter: deps.server } : undefined;
}

/** Dominio de apps del proyecto (fijo desde que se creó). */
export const appsDomainOf = (client: WithServer, config: Pick<ProvisioningConfig, "appsDomain">) => client?.server?.appsDomain ?? config.appsDomain;
