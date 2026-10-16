import { randomBytes } from "node:crypto";
import { buildMongoUri } from "../../adapters/mongo-bootstrap.js";
import { getProvider } from "../../integrations/catalog.js";
import { FatalError } from "../../lib/errors.js";
import { registerSecret } from "../../lib/redact.js";
import type { Stage, StageContext } from "../types.js";
import { ensureCredential } from "./credentials.js";
import { markConfigured, writeIntegrationSecrets } from "./integrations.js";

/** Usuario que crea la migración 1 del template (contrato §8). */
export const INITIAL_ADMIN_USERNAME = "admin";

/** Clave HMAC de las sesiones de la app: 48 bytes aleatorios en base64url (64 caracteres), uno por cliente. */
export function generateSessionSecret() {
  return randomBytes(48).toString("base64url");
}

/** Contraseña inicial: 18 bytes aleatorios en base64url (24 caracteres, sin saltos de línea). */
export function generateInitialAdminPassword() {
  return randomBytes(18).toString("base64url");
}

/**
 * INITIAL_ADMIN_PASSWORD (contrato §3). Se genera solo si el secret no existe:
 * su valor no se puede leer de GitHub y rotarlo después de que la app creó el
 * admin no tendría efecto (el template nunca sobrescribe un admin existente).
 *
 * Orden: primero se cifra en el almacén temporal y después se escribe el secret.
 * Así, si el secret queda escrito, su valor siempre está en el almacén (hasta que
 * se revele o venza). `generatedAt` se marca al final: el panel no ofrece una
 * contraseña cuyo secret no llegó a escribirse.
 */
async function writeInitialAdminPassword(ctx: StageContext, present: Set<string>, written: string[]) {
  const { names, store, deps, client, memory } = ctx;
  const { github, config, vault } = deps;
  const environment = config.template.environment;
  const current = (await store.getClient(client._id))?.initialAdmin;

  if (config.initialAdmin.mode === "default") {
    if (current?.mode !== "default") await store.setClientFields(client._id, { initialAdmin: { mode: "default" } });
    await ctx.step("initial_admin", "skipped", "Modo default: el template usa su contraseña por defecto y obliga a cambiarla en el primer ingreso.");
    return;
  }

  if (present.has("INITIAL_ADMIN_PASSWORD")) {
    // El proceso pudo morir entre escribir el secret y marcarlo: si el almacén aún tiene el valor, sigue disponible.
    const pendingUntil = current?.generatedAt ? null : await vault.pendingUntil(client._id);
    if (pendingUntil) {
      await store.setClientFields(client._id, { initialAdmin: { mode: "random", generatedAt: new Date(), revealExpiresAt: pendingUntil } });
    } else if (!current?.generatedAt) {
      await store.setClientFields(client._id, { initialAdmin: { mode: "random", reused: true } });
    }
    await ctx.step(
      "initial_admin",
      "skipped",
      pendingUntil || current?.generatedAt
        ? "Ya existe de este trabajo; no se sobrescribe."
        : "Ya existía de un intento anterior; no se sobrescribe y su valor no está disponible para mostrarlo."
    );
    return;
  }

  await ctx.step("initial_admin", "running", "Generando la contraseña inicial…");
  const password = (deps.generateInitialAdminPassword ?? generateInitialAdminPassword)();
  registerSecret(password);
  memory.initialAdminPassword = password;
  try {
    const expiresAt = await vault.put(client._id, password, config.initialAdmin.revealTtlMs);
    await github.putEnvironmentSecret(names.repository, environment, "INITIAL_ADMIN_PASSWORD", password);
    written.push("INITIAL_ADMIN_PASSWORD");
    await store.setClientFields(client._id, { initialAdmin: { mode: "random", generatedAt: new Date(), revealExpiresAt: expiresAt } });
  } finally {
    memory.initialAdminPassword = undefined;
  }
  const minutes = Math.round(config.initialAdmin.revealTtlMs / 60_000);
  await ctx.step("initial_admin", "done", `Generada y escrita. El operador puede verla una sola vez durante ${minutes} min.`);
}

/**
 * Integraciones activadas al crear el cliente (o al actualizar la credencial de un
 * cliente cuyo trabajo falló antes de esta etapa). La credencial llega cifrada en
 * provisioning_secrets y se borra en cuanto se escribe. Sin valor transitorio, si
 * el secret ya existe en GitHub no se toca; si tampoco existe, la credencial caducó.
 */
async function writeRequestedIntegrations(ctx: StageContext, present: Set<string>, written: string[]) {
  const { deps, names, store, client } = ctx;
  const requested = Object.entries((await store.getClient(client._id))?.integrations ?? {}).filter(([, state]) => state.enabled);
  if (!requested.length) {
    await ctx.step("integrations", "skipped", "Ninguna integración activada.");
    return;
  }
  await ctx.step("integrations", "running");
  const done: string[] = [];
  for (const [providerId] of requested) {
    const provider = getProvider(providerId);
    if (!provider) continue;
    const credentials = await deps.secrets.get(client._id, provider.id);
    if (credentials) {
      written.push(...(await writeIntegrationSecrets(deps, names.repository, provider, credentials)));
      const { firstTime } = await markConfigured(ctx, provider.id);
      await deps.secrets.delete(client._id, provider.id);
      await ctx.audit(firstTime ? "integration_enabled" : "integration_updated", names.repositoryFullName, {
        provider: provider.id,
        names: provider.fields.map((f) => f.envVar)
      });
      done.push(`${provider.label}: escrita`);
    } else if (provider.fields.every((f) => present.has(f.envVar))) {
      done.push(`${provider.label}: ya configurada`);
    } else {
      throw new FatalError(
        "integration_credential_expired",
        `La credencial de ${provider.label} caducó antes de escribirse (el trabajo estuvo detenido más del plazo). ` +
          "Vuelve a introducirla desde el detalle del cliente (Integraciones → Actualizar credencial) y reintenta."
      );
    }
  }
  await ctx.step("integrations", "done", done.join(" · "));
}

export const githubSecretsStage: Stage = {
  name: "github_secrets",
  async run(ctx) {
    const { names, store, deps, client, memory } = ctx;
    const { github, config } = deps;
    const environment = config.template.environment;

    await ctx.plan([
      { id: "environment", label: `Entorno ${environment}` },
      { id: "mongodb", label: "MONGODB_URI y MONGODB_DB" },
      { id: "session_secret", label: "SESSION_SECRET único del cliente" },
      {
        id: "initial_admin",
        label: config.initialAdmin.mode === "random" ? "INITIAL_ADMIN_PASSWORD aleatoria" : "INITIAL_ADMIN_PASSWORD (modo default: no se escribe)"
      },
      { id: "integrations", label: "Integraciones activadas (secrets del contrato)" },
      { id: "variables", label: "Variable APP_DISPLAY_NAME" }
    ]);

    try {
      await ctx.step("environment", "running");
      await store.claimResource("github_environment", names.repositoryFullName, client._id);

      if (!(await github.environmentExists(names.repository, environment))) {
        await ctx.report(`Creando el entorno ${environment}…`);
        await github.createEnvironment(names.repository, environment);
        await ctx.audit("github.environment.created", names.repositoryFullName, { environment });
        await ctx.step("environment", "done", `Entorno ${environment} creado.`);
      } else {
        await ctx.step("environment", "skipped", `El entorno ${environment} ya existía.`);
      }

      // Idempotencia: lo que ya existe se decide con los nombres, nunca leyendo valores.
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
        await ctx.step("mongodb", "running", "Cifrando y escribiendo la conexión del usuario del cliente…");
        // Usa la credencial de esta ejecución; si no existe en memoria, ensureCredential rota.
        const credential = await ensureCredential(ctx);
        await ctx.report("Cifrando y escribiendo MONGODB_URI y MONGODB_DB…");
        const uri = buildMongoUri(config.atlas.srvHost, names.dbUser, credential.password, client._id);
        await github.putEnvironmentSecret(names.repository, environment, "MONGODB_URI", uri);
        await github.putEnvironmentSecret(names.repository, environment, "MONGODB_DB", names.database);
        written.push("MONGODB_URI", "MONGODB_DB");
        credentialVersion = credential.version;
        await ctx.step("mongodb", "done", `Escritos con la credencial vigente de ${names.dbUser}.`);
      } else {
        await ctx.step("mongodb", "skipped", "Ya escritos con la credencial vigente.");
      }

      // SESSION_SECRET: nunca se sobrescribe (no se puede leer y rotarlo cerraría todas las sesiones de la app).
      if (present.has("SESSION_SECRET")) {
        await ctx.step("session_secret", "skipped", "Ya existe; no se sobrescribe para no cerrar las sesiones de la app.");
      } else {
        const sessionSecret = (deps.generateSessionSecret ?? generateSessionSecret)();
        registerSecret(sessionSecret);
        await github.putEnvironmentSecret(names.repository, environment, "SESSION_SECRET", sessionSecret);
        written.push("SESSION_SECRET");
        await ctx.step("session_secret", "done", "Generado para este cliente y escrito.");
      }

      await writeInitialAdminPassword(ctx, present, written);
      await writeRequestedIntegrations(ctx, present, written);

      // Contrato 1.3.0 (§3): DEPLOY_SSH_KEY, DEPLOY_HOST, DEPLOY_KNOWN_HOSTS y APP_HOSTNAME los
      // escribe server_prepare. Los nombres anteriores (DEPLOY_SSH_*, APP_BASE_URL) ya no se escriben;
      // en repos antiguos se dejan como están.
      await ctx.step("variables", "running");
      await github.setEnvironmentVariable(names.repository, environment, "APP_DISPLAY_NAME", client.name);
      await ctx.step("variables", "done", `APP_DISPLAY_NAME "${client.name}".`);

      if (written.length) {
        await ctx.audit("github.environment_secrets.written", names.repositoryFullName, { environment, names: written });
      }
      const variables = ["APP_DISPLAY_NAME"];
      await store.updateResourceRef("github_environment", names.repositoryFullName, client._id, {
        repository: names.repositoryFullName,
        environment,
        configuredKeys: [...new Set([...present, ...written])].sort(),
        variables,
        credentialVersion
      });
      await ctx.report(written.length ? `Escritos en ${environment}: ${written.join(", ")}.` : `El entorno ${environment} ya estaba configurado.`);
    } finally {
      // Las contraseñas se descartan en cuanto se han escrito (o si algo falla).
      memory.credential = undefined;
      memory.initialAdminPassword = undefined;
    }
  }
};
