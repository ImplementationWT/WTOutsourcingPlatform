import { MongoClient, MongoServerError, MongoServerSelectionError } from "mongodb";
import { FatalError, OwnershipError, TransientError } from "../lib/errors.js";
import { registerSecret } from "../lib/redact.js";

/** Documento que exige el contrato del template (§8). */
export interface BootstrapDocument {
  clientId: string;
  templateVersion: string;
  schemaVersion: number | string;
}

/** Fases del bootstrap, en orden; se notifican al completarse cada una. */
export type BootstrapPhase = "connected" | "collection" | "document" | "verified";

export interface MongoBootstrapAdapter {
  /**
   * Conecta con el usuario del cliente, crea `app_metadata`, el índice único
   * sobre `key` y el documento de bootstrap (idempotente) y hace una lectura
   * de verificación.
   */
  bootstrap(
    input: { uri: string; database: string; document: BootstrapDocument },
    onPhase?: (phase: BootstrapPhase, detail: string) => Promise<void> | void
  ): Promise<void>;
}

export const METADATA_COLLECTION = "app_metadata";

/** mongodb+srv://<user>:<pass>@<host>/  (credenciales codificadas para URL). Solo en memoria. */
export function buildMongoUri(srvHost: string, username: string, password: string, appName: string) {
  registerSecret(password);
  const uri =
    `mongodb+srv://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${srvHost}/` +
    `?retryWrites=true&w=majority&appName=${encodeURIComponent(appName)}`;
  registerSecret(uri);
  return uri;
}

function classify(error: unknown): never {
  if (error instanceof OwnershipError || error instanceof FatalError || error instanceof TransientError) throw error;
  if (error instanceof MongoServerError) {
    // 18 AuthenticationFailed: en Atlas el usuario/contraseña tarda unos segundos
    // en propagarse al clúster tras crearlo o rotarlo.
    if (error.code === 18) {
      throw new TransientError("mongodb_auth_pending", "MongoDB aún no acepta las credenciales nuevas (propagación de Atlas).");
    }
    if (error.code === 13) {
      throw new FatalError("mongodb_unauthorized", "El usuario del cliente no tiene permisos sobre su base. Revisa su rol en Atlas.");
    }
  }
  if (error instanceof MongoServerSelectionError) {
    throw new TransientError(
      "mongodb_unreachable",
      "No se pudo conectar al clúster de MongoDB. Si persiste, revisa que la IP del servidor esté en la Network Access List de Atlas y ATLAS_CLUSTER_SRV_HOST."
    );
  }
  throw new TransientError("mongodb_error", "Error al inicializar la base del cliente.", { cause: error });
}

export function createMongoBootstrapAdapter(
  connect: (uri: string) => MongoClient = (uri) =>
    new MongoClient(uri, { serverSelectionTimeoutMS: 10_000, connectTimeoutMS: 10_000, maxPoolSize: 2 })
): MongoBootstrapAdapter {
  return {
    async bootstrap({ uri, database, document }, onPhase = () => {}) {
      const client = connect(uri);
      try {
        await client.connect();
        // connect() no autentica hasta la primera operación: un ping lo confirma.
        await client.db(database).command({ ping: 1 });
        await onPhase("connected", "Conexión autenticada con el usuario del cliente.");
        const db = client.db(database);

        const existing = await db.listCollections({ name: METADATA_COLLECTION }, { nameOnly: true }).toArray();
        if (existing.length === 0) {
          try {
            await db.createCollection(METADATA_COLLECTION);
          } catch (error) {
            // 48 NamespaceExists: otra ejecución la creó entre medias.
            if (!(error instanceof MongoServerError && error.code === 48)) throw error;
          }
        }

        const collection = db.collection(METADATA_COLLECTION);
        await collection.createIndex({ key: 1 }, { unique: true, name: "key_unique" });
        await onPhase(
          "collection",
          existing.length ? "app_metadata ya existía; índice único sobre key asegurado." : "app_metadata creada con índice único sobre key."
        );

        const current = await collection.findOne({ key: "bootstrap" });
        if (current && current.clientId !== document.clientId) {
          throw new OwnershipError(
            `La base ${database} ya tiene un bootstrap de otro cliente (${String(current.clientId)}). No se modifica.`
          );
        }
        if (!current) {
          try {
            await collection.insertOne({ key: "bootstrap", ...document });
          } catch (error) {
            // 11000: inserción concurrente; la verificación de abajo decide.
            if (!(error instanceof MongoServerError && error.code === 11000)) throw error;
          }
        }
        await onPhase(
          "document",
          current
            ? "El documento de bootstrap ya existía para este cliente."
            : `Documento escrito: clientId ${document.clientId}, template ${document.templateVersion}, schema ${document.schemaVersion}.`
        );

        // Lectura de verificación: los tres campos que expone /api/meta.
        const verified = await collection.findOne(
          { key: "bootstrap" },
          { projection: { _id: 0, clientId: 1, templateVersion: 1, schemaVersion: 1 } }
        );
        if (
          !verified ||
          verified.clientId !== document.clientId ||
          typeof verified.templateVersion !== "string" ||
          verified.schemaVersion === undefined
        ) {
          throw new FatalError("mongodb_bootstrap_invalid", `El documento de bootstrap de ${database} no es válido tras escribirlo.`);
        }
        await onPhase("verified", "Lectura correcta: /api/meta podrá devolver clientId, templateVersion y schemaVersion.");
      } catch (error) {
        classify(error);
      } finally {
        await client.close().catch(() => undefined);
      }
    }
  };
}
