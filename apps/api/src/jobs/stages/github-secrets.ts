import { buildMongoUri } from "../../adapters/mongo-bootstrap.js";
import type { Stage } from "../types.js";
import { ensureCredential } from "./credentials.js";

export const DEPLOY_SECRET_NAMES = ["DEPLOY_SSH_HOST", "DEPLOY_SSH_USER", "DEPLOY_SSH_PRIVATE_KEY", "DEPLOY_SSH_KNOWN_HOSTS"] as const;

export const githubSecretsStage: Stage = {
  name: "github_secrets",
  async run(ctx) {
    const { names, store, deps, client, memory } = ctx;
    const { github, config } = deps;
    const environment = config.template.environment;

    try {
      await store.claimResource("github_environment", names.repositoryFullName, client._id);

      if (!(await github.environmentExists(names.repository, environment))) {
        await ctx.report(`Creando el entorno ${environment}…`);
        await github.createEnvironment(names.repository, environment);
        await ctx.audit("github.environment.created", names.repositoryFullName, { environment });
      }

      const present = new Set(await github.listEnvironmentSecretNames(names.repository, environment));
      const [user, env] = await Promise.all([
        store.getResource("mongodb_user", names.dbUser),
        store.getResource("github_environment", names.repositoryFullName)
      ]);

      const mongoInSync =
        present.has("MONGODB_URI") &&
        present.has("MONGODB_DB") &&
        typeof user?.ref.credentialVersion === "number" &&
        env?.ref.credentialVersion === user.ref.credentialVersion;

      const written: string[] = [];
      let credentialVersion = env?.ref.credentialVersion ?? null;

      if (!mongoInSync) {
        // Usa la credencial de esta ejecución; si no existe en memoria, ensureCredential rota.
        const credential = await ensureCredential(ctx);
        await ctx.report("Cifrando y escribiendo MONGODB_URI y MONGODB_DB…");
        const uri = buildMongoUri(config.atlas.srvHost, names.dbUser, credential.password, client._id);
        await github.putEnvironmentSecret(names.repository, environment, "MONGODB_URI", uri);
        await github.putEnvironmentSecret(names.repository, environment, "MONGODB_DB", names.database);
        written.push("MONGODB_URI", "MONGODB_DB");
        credentialVersion = credential.version;
      }

      const deploy = config.deploy;
      if (deploy) {
        const values: Record<(typeof DEPLOY_SECRET_NAMES)[number], string> = {
          DEPLOY_SSH_HOST: deploy.host,
          DEPLOY_SSH_USER: deploy.user,
          DEPLOY_SSH_PRIVATE_KEY: deploy.privateKey,
          DEPLOY_SSH_KNOWN_HOSTS: deploy.knownHosts
        };
        for (const name of DEPLOY_SECRET_NAMES) {
          if (present.has(name)) continue;
          await github.putEnvironmentSecret(names.repository, environment, name, values[name]);
          written.push(name);
        }
        if (deploy.port) await github.setEnvironmentVariable(names.repository, environment, "DEPLOY_SSH_PORT", String(deploy.port));
      }

      await github.setEnvironmentVariable(names.repository, environment, "APP_BASE_URL", names.baseUrl);

      if (written.length) {
        await ctx.audit("github.environment_secrets.written", names.repositoryFullName, { environment, names: written });
      }
      await store.updateResourceRef("github_environment", names.repositoryFullName, client._id, {
        repository: names.repositoryFullName,
        environment,
        configuredKeys: [...new Set([...present, ...written])].sort(),
        variables: deploy?.port ? ["APP_BASE_URL", "DEPLOY_SSH_PORT"] : ["APP_BASE_URL"],
        credentialVersion
      });
      await ctx.report(written.length ? `Escritos en ${environment}: ${written.join(", ")}.` : `El entorno ${environment} ya estaba configurado.`);
    } finally {
      // La contraseña se descarta en cuanto se ha escrito (o si algo falla).
      memory.credential = undefined;
    }
  }
};
