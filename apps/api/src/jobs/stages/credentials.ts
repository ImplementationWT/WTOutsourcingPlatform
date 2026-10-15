import { randomBytes } from "node:crypto";
import { AtlasUserExistsError, type AtlasDatabaseUser } from "../../adapters/atlas.js";
import { type BootstrapPhase, buildMongoUri } from "../../adapters/mongo-bootstrap.js";
import { FatalError, OwnershipError, TransientError } from "../../lib/errors.js";
import { registerSecret } from "../../lib/redact.js";
import { pollUntil } from "../../lib/retry.js";
import type { StageContext } from "../types.js";

export const MANAGED_BY = "provisioning-platform";

/**
 * Pasos de MongoDB en el orden en que DEBEN ejecutarse (cada uno necesita lo
 * que produce el anterior):
 *  1. ownership   → saber si el usuario existe y es de este cliente (antes de tocar nada).
 *  2. atlas_user  → crear el usuario o rotar su contraseña (produce la credencial).
 *  3. propagation → Atlas tarda en aplicar el usuario al clúster; sin esto la conexión falla.
 *  4. collection  → con la conexión autenticada, app_metadata + índice único sobre key.
 *  5. document    → el índice debe existir antes de insertar el bootstrap.
 *  6. verify      → lectura de lo escrito: lo que expondrá /api/meta.
 */
export function mongoSteps(names: { dbUser: string; database: string }) {
  return [
    { id: "ownership", label: `Comprobar el usuario ${names.dbUser} en Atlas` },
    { id: "atlas_user", label: `Crear ${names.dbUser} con acceso solo a ${names.database}` },
    { id: "propagation", label: "Esperar a que el clúster active las credenciales" },
    { id: "collection", label: "Crear la colección app_metadata y su índice único" },
    { id: "document", label: "Escribir el documento de bootstrap" },
    { id: "verify", label: "Verificar la lectura del documento" }
  ];
}

const PHASE_TO_STEP: Record<BootstrapPhase, { done: string; next?: string; nextDetail?: string }> = {
  connected: { done: "propagation", next: "collection", nextDetail: "Creando app_metadata e índice único sobre key…" },
  collection: { done: "collection", next: "document", nextDetail: "Escribiendo { key: \"bootstrap\", clientId, templateVersion, schemaVersion }…" },
  document: { done: "document", next: "verify", nextDetail: "Leyendo el documento para confirmar los tres campos…" },
  verified: { done: "verify" }
};

export function ownershipLabels(clientId: string) {
  return [
    { key: "managed-by", value: MANAGED_BY },
    { key: "client-id", value: clientId }
  ];
}

/** Contraseña fuerte: 256 bits de crypto.randomBytes en hex (Atlas exige alfanumérica). */
export function generatePassword() {
  return randomBytes(32).toString("hex");
}

function assertOwnedByClient(user: AtlasDatabaseUser, clientId: string) {
  const label = (key: string) => user.labels.find((l) => l.key === key)?.value;
  if (label("managed-by") !== MANAGED_BY || label("client-id") !== clientId) {
    throw new OwnershipError(
      `El usuario ${user.username} ya existe en Atlas y no está marcado como de este cliente. No se modifica.`
    );
  }
}

export async function getTemplateVersion(ctx: StageContext) {
  const repo = await ctx.store.getResource("github_repository", ctx.names.repositoryFullName);
  const version = repo?.ref.templateVersion;
  if (typeof version !== "string") {
    throw new FatalError("missing_template_version", "No se conoce la versión del template; reintenta desde la etapa del repositorio.");
  }
  return version;
}

/**
 * Garantiza una credencial válida del usuario app_<slug> y la base inicializada.
 *
 * La contraseña nunca se guarda: si no está en memoria (p. ej. el trabajo se
 * interrumpió tras crear el usuario) no se puede recuperar, así que se rota
 * la del usuario existente, solo si pertenece a este cliente según
 * `resources` y las etiquetas de Atlas.
 *
 * `credentialVersion` se incrementa ANTES de llamar a Atlas: si el proceso
 * muere tras cambiar la contraseña, la versión ya no coincide con la del
 * secret de GitHub y el reintento vuelve a rotar en lugar de dar por buena
 * una contraseña desconocida.
 *
 * Los ctx.step(...) solo se muestran si la etapa declaró esos pasos (mongodb_database).
 */
export async function ensureCredential(ctx: StageContext) {
  const { names, store, deps, client } = ctx;

  await ctx.step("ownership", "running", `Consultando si ${names.dbUser} ya existe…`);
  const { resource: claim, created: newClaim } = await store.claimResource("mongodb_user", names.dbUser, client._id);
  const existing = await deps.atlas.getDatabaseUser(names.dbUser);
  if (existing) {
    if (newClaim) {
      throw new OwnershipError(`El usuario ${names.dbUser} ya existía en Atlas antes de este cliente. No se reutiliza.`);
    }
    assertOwnedByClient(existing, client._id);
  }
  await ctx.step(
    "ownership",
    "done",
    existing ? `${names.dbUser} ya existe y pertenece a este cliente.` : `${names.dbUser} no existe todavía; se creará.`
  );

  const currentVersion = typeof claim.ref.credentialVersion === "number" ? claim.ref.credentialVersion : 0;
  const credential =
    existing && ctx.memory.credential?.version === currentVersion
      ? ctx.memory.credential
      : await createOrRotate(ctx, Boolean(existing), currentVersion + 1);
  if (credential === ctx.memory.credential && existing) {
    await ctx.step("atlas_user", "skipped", "La credencial generada en este intento sigue vigente.");
  }
  ctx.memory.credential = credential;
  const { password } = credential;

  // Inicializa/verifica la base con la credencial nueva. Atlas tarda unos
  // segundos en propagar el usuario: se reintenta mientras la autenticación falle.
  await ctx.report(`Inicializando ${names.database} con el usuario ${names.dbUser}…`);
  await ctx.step("propagation", "running", "Atlas suele tardar entre 10 s y 1 min en aplicar un usuario nuevo…");
  const uri = buildMongoUri(deps.config.atlas.srvHost, names.dbUser, password, client._id);
  const document = {
    clientId: client._id,
    templateVersion: await getTemplateVersion(ctx),
    schemaVersion: deps.config.template.schemaVersion
  };

  let attempt = 0;
  await pollUntil(
    async () => {
      attempt++;
      try {
        await deps.mongo.bootstrap({ uri, database: names.database, document }, async (phase, detail) => {
          const step = PHASE_TO_STEP[phase];
          await ctx.step(step.done, "done", phase === "connected" && attempt > 1 ? `${detail} (intento ${attempt})` : detail);
          if (step.next) await ctx.step(step.next, "running", step.nextDetail);
        });
      } catch (error) {
        if (error instanceof TransientError && error.code === "mongodb_auth_pending") {
          await ctx.step("propagation", "running", `El clúster todavía no acepta las credenciales · intento ${attempt}, reintentando…`);
        }
        throw error;
      }
      return true;
    },
    { timeoutMs: deps.timing.mongoAuthTimeoutMs, intervalMs: deps.timing.pollIntervalMs, sleep: deps.sleep }
  );

  return credential;
}

/** Crea el usuario o rota su contraseña. Persiste la versión ANTES de llamar a Atlas. */
async function createOrRotate(ctx: StageContext, exists: boolean, version: number) {
  const { names, store, deps, client } = ctx;
  await store.updateResourceRef("mongodb_user", names.dbUser, client._id, {
    username: names.dbUser,
    database: names.database,
    cluster: deps.config.atlas.clusterName,
    credentialVersion: version
  });

  const password = (deps.generatePassword ?? generatePassword)();
  registerSecret(password);
  const spec = {
    username: names.dbUser,
    password,
    database: names.database,
    labels: ownershipLabels(client._id),
    description: `${MANAGED_BY}: ${client._id}`
  };

  if (!exists) {
    await ctx.step("atlas_user", "running", `Creando ${names.dbUser} con rol readWrite sobre ${names.database}…`);
    await ctx.report(`Creando el usuario ${names.dbUser} en Atlas…`);
    try {
      await deps.atlas.createDatabaseUser(spec);
      await ctx.audit("atlas.database_user.created", names.dbUser, { role: "readWrite", database: names.database });
      await ctx.step("atlas_user", "done", `Usuario creado: readWrite solo sobre ${names.database}, limitado a ${deps.config.atlas.clusterName}.`);
    } catch (error) {
      if (!(error instanceof AtlasUserExistsError)) throw error;
      // La creación anterior sí llegó (timeout del cliente HTTP): se verifica y se rota.
      const now = await deps.atlas.getDatabaseUser(names.dbUser);
      if (!now) throw error;
      assertOwnedByClient(now, client._id);
      await deps.atlas.updateDatabaseUser(spec);
      await ctx.audit("atlas.database_user.password_rotated", names.dbUser, { reason: "create_conflict" });
      await ctx.step("atlas_user", "done", "El usuario ya se había creado en un intento anterior; contraseña regenerada.");
    }
  } else {
    await ctx.step("atlas_user", "running", "La contraseña anterior no es recuperable: generando una nueva…");
    await ctx.report(`Rotando la contraseña de ${names.dbUser} (la anterior no es recuperable)…`);
    await deps.atlas.updateDatabaseUser(spec);
    await ctx.audit("atlas.database_user.password_rotated", names.dbUser, { reason: "credential_not_in_memory" });
    await ctx.step("atlas_user", "done", "Contraseña regenerada (la anterior no se guarda en ningún sitio).");
  }
  return { password, version };
}
