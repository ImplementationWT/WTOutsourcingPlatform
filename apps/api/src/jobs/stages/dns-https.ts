import { FatalError, TransientError } from "../../lib/errors.js";
import type { DeployTarget } from "../../servers/directory.js";
import { serverFor } from "../../servers/resolve.js";
import type { Stage, StageContext } from "../types.js";

/** Servidor del proyecto o error accionable (se comparte con las demás etapas del despliegue). */
export async function requireServer(ctx: StageContext): Promise<DeployTarget> {
  const server = await serverFor(ctx.deps, ctx.client);
  if (!server) {
    throw new FatalError(
      "server_not_configured",
      "DEPLOY_ENABLED=true pero faltan DEPLOY_HOST, DEPLOY_HOST_KEY, PROVISIONER_SSH_KEY_SECRET_REF, GHCR_ORG o VPS_PUBLIC_IP."
    );
  }
  return server;
}

const NOT_FOUND = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

/**
 * Antes de preparar el servidor: Certbot necesita que <slug>.<APP_BASE_DOMAIN>
 * ya resuelva al VPS. El registro comodín *.<APP_BASE_DOMAIN> es único para
 * todos los clientes: aquí no se crea nada. Tampoco se verifican certificados.
 */
export const dnsHttpsStage: Stage = {
  name: "dns_https",
  async run(ctx) {
    const { names, deps, store, client } = ctx;
    const server = await requireServer(ctx);
    const domain = server.appsDomain;
    await ctx.plan([
      { id: "resolve", label: `Resolver ${names.host}` },
      { id: "match", label: `Comprobar que apunta al servidor (${server.publicIp})` }
    ]);

    await ctx.step("resolve", "running");
    let addresses: string[];
    try {
      addresses = await deps.resolver.resolve4(names.host);
    } catch (error) {
      const code = (error as { code?: string }).code ?? "";
      if (NOT_FOUND.has(code)) {
        throw new FatalError(
          "dns_not_resolving",
          `${names.host} no resuelve. Crea en tu proveedor DNS el registro comodín A *.${domain} → ${server.publicIp} y reintenta.`
        );
      }
      throw new TransientError("dns_lookup_failed", `No se pudo consultar el DNS de ${names.host} (${code || "error de red"}).`);
    }
    await ctx.step("resolve", "done", `${names.host} → ${addresses.join(", ")}`);

    await ctx.step("match", "running");
    if (!addresses.includes(server.publicIp)) {
      throw new FatalError(
        "dns_wrong_ip",
        `${names.host} resuelve a ${addresses.join(", ")} y debe apuntar a ${server.publicIp}. Revisa el registro *.${domain}.`
      );
    }
    await ctx.step("match", "done", "Apunta al servidor: Certbot podrá validar el dominio.");
    await store.setClientFields(client._id, { "deployment.host": names.host, "deployment.dnsVerifiedAt": new Date() });
    await ctx.report(`${names.host} resuelve a ${server.publicIp}.`);
  }
};
