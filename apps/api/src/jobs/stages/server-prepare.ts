import { generateClientKeyPair } from "../../adapters/server.js";
import type { Stage } from "../types.js";
import { requireServer } from "./dns-https.js";

/**
 * Prepara el VPS para el cliente y le da a su repo lo necesario para desplegar
 * (contrato §3 y §5):
 *  1. Par ed25519 propio del cliente, generado en memoria (solo si hace falta).
 *  2. install-client: carpeta, puerto, certificado, server de nginx y la clave
 *     pública con comando forzado en ~deploy/.ssh/authorized_keys.
 *  3. DEPLOY_SSH_KEY (secret) y DEPLOY_HOST, DEPLOY_KNOWN_HOSTS, APP_HOSTNAME (variables).
 *
 * Idempotencia: si DEPLOY_SSH_KEY ya existe no se sobrescribe e install-client se
 * llama sin clave, conservando la instalada (así nunca se reinstala una clave
 * antigua tras una rotación manual). Si falta (trabajo interrumpido), se genera
 * un par nuevo, se instala (reemplaza al anterior) y se escribe.
 */
export const serverPrepareStage: Stage = {
  name: "server_prepare",
  async run(ctx) {
    const { names, deps, store, client, memory } = ctx;
    const { github, server: serverAdapter, config } = deps;
    const server = requireServer(ctx);
    const environment = config.template.environment;

    await ctx.plan([
      { id: "key", label: "Clave SSH propia del cliente (ed25519)" },
      { id: "install", label: "Servidor: carpeta, puerto, certificado HTTPS y nginx" },
      { id: "secret", label: "Secret DEPLOY_SSH_KEY" },
      { id: "variables", label: "Variables DEPLOY_HOST, DEPLOY_KNOWN_HOSTS y APP_HOSTNAME" }
    ]);

    try {
      await store.claimResource("server_client", names.host, client._id);
      const present = new Set(await github.listEnvironmentSecretNames(names.repository, environment));

      await ctx.step("key", "running");
      let publicKey: string | undefined;
      if (present.has("DEPLOY_SSH_KEY")) {
        await ctx.step("key", "skipped", "DEPLOY_SSH_KEY ya existe: no se sobrescribe y el servidor conserva su clave.");
      } else {
        const pair = generateClientKeyPair(`${github.owner}/${names.repository}`);
        memory.deployKey = pair.privateKey;
        publicKey = pair.publicKey;
        await ctx.step("key", "done", "Par nuevo generado; la clave privada solo existe en memoria hasta escribirla en GitHub.");
      }

      await ctx.step("install", "running", "Puede tardar si hay que emitir el certificado…");
      await ctx.report(`Preparando ${names.host} en el servidor…`);
      const installed = await serverAdapter.installClient(names.slug, publicKey);
      await ctx.audit("server.client_installed", names.host, {
        port: installed.port,
        certificate: installed.certificate,
        key: installed.key
      });
      await store.setClientFields(client._id, {
        "deployment.host": installed.host,
        "deployment.port": installed.port,
        "deployment.certificate": installed.certificate,
        "deployment.preparedAt": new Date()
      });
      await ctx.step(
        "install",
        "done",
        `Puerto ${installed.port} · certificado ${installed.certificate === "issued" ? "emitido" : "ya existente (no se reemite)"} · nginx recargado.`
      );

      await ctx.step("secret", "running");
      if (publicKey) {
        await github.putEnvironmentSecret(names.repository, environment, "DEPLOY_SSH_KEY", memory.deployKey!);
        memory.deployKey = undefined;
        await ctx.audit("github.environment_secrets.written", names.repositoryFullName, { environment, names: ["DEPLOY_SSH_KEY"] });
        await ctx.step("secret", "done", "Escrito (cifrado con la clave pública del entorno).");
      } else {
        await ctx.step("secret", "skipped", "Ya existía; no se sobrescribe.");
      }
      // Solo referencias: host, puerto y la clave pública vigente (nunca la privada).
      await store.updateResourceRef("server_client", names.host, client._id, {
        host: names.host,
        port: installed.port,
        ...(publicKey ? { publicKey } : {})
      });

      await ctx.step("variables", "running");
      await github.setEnvironmentVariable(names.repository, environment, "DEPLOY_HOST", server.host);
      await github.setEnvironmentVariable(names.repository, environment, "DEPLOY_KNOWN_HOSTS", server.knownHosts);
      await github.setEnvironmentVariable(names.repository, environment, "APP_HOSTNAME", names.host);
      await ctx.step("variables", "done", `DEPLOY_HOST ${server.host} · APP_HOSTNAME ${names.host}.`);
      await ctx.report(`${names.host} preparado en el servidor (puerto ${installed.port}).`);
    } finally {
      memory.deployKey = undefined;
    }
  }
};
