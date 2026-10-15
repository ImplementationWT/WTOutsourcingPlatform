import {
  FatalError,
  isNetworkError,
  isTransientStatus,
  ProvisioningError,
  TransientError
} from "../lib/errors.js";
import { registerSecret } from "../lib/redact.js";

/**
 * Adaptador de la Atlas Administration API v2.
 *
 * Autenticación: Service Account (OAuth 2.0 client credentials).
 *   POST https://cloud.mongodb.com/api/oauth/token  (Basic clientId:secret,
 *   grant_type=client_credentials) → Bearer válido 1 h. El token se cachea y se
 *   renueva un minuto antes de expirar; generarlo tiene rate limit (10/min).
 * Versionado: cada recurso declara su versión en el Accept. Database Users
 *   usa application/vnd.atlas.2023-01-01+json.
 */
const DATABASE_USERS_VERSION = "application/vnd.atlas.2023-01-01+json";
const REQUEST_TIMEOUT_MS = 15_000;

export interface AtlasConfig {
  projectId: string;
  clientId: string;
  clientSecret: string;
  clusterName: string;
  baseUrl?: string;
}

export interface AtlasLabel {
  key: string;
  value: string;
}

export interface AtlasDatabaseUser {
  username: string;
  databaseName: string;
  labels: AtlasLabel[];
  roles: { roleName: string; databaseName: string; collectionName?: string }[];
  scopes: { name: string; type: string }[];
  description?: string;
}

export interface DatabaseUserSpec {
  username: string;
  password: string;
  /** Base sobre la que tendrá readWrite (y nada más). */
  database: string;
  labels: AtlasLabel[];
  description: string;
}

/** 409 al crear: el usuario ya existe (p. ej. una llamada anterior sí llegó). */
export class AtlasUserExistsError extends ProvisioningError {
  constructor() {
    super("atlas_user_exists", "El usuario de base de datos ya existe en Atlas.");
  }
}

export interface AtlasAdapter {
  getDatabaseUser(username: string): Promise<AtlasDatabaseUser | null>;
  createDatabaseUser(spec: DatabaseUserSpec): Promise<void>;
  /** Reafirma rol/scope/etiquetas y fija una contraseña nueva. */
  updateDatabaseUser(spec: DatabaseUserSpec): Promise<void>;
}

interface AtlasApiError {
  error?: number;
  errorCode?: string;
  detail?: string;
  reason?: string;
}

export function createAtlasAdapter(
  config: AtlasConfig,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now
): AtlasAdapter {
  const baseUrl = (config.baseUrl ?? "https://cloud.mongodb.com").replace(/\/$/, "");
  registerSecret(config.clientSecret);

  let token: { value: string; expiresAt: number } | undefined;

  async function send(url: string, init: RequestInit) {
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      if (isNetworkError(error)) {
        throw new TransientError("atlas_unreachable", "No se pudo conectar con la API de Atlas (timeout o red).", {
          cause: error
        });
      }
      throw error;
    }
  }

  async function getToken(forceRefresh = false) {
    if (!forceRefresh && token && token.expiresAt > now()) return token.value;

    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
    const response = await send(`${baseUrl}/api/oauth/token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "Cache-Control": "no-cache",
        Authorization: `Basic ${basic}`
      },
      body: "grant_type=client_credentials"
    });

    if (response.ok) {
      const body = (await response.json()) as { access_token: string; expires_in: number };
      registerSecret(body.access_token);
      token = { value: body.access_token, expiresAt: now() + Math.max(60, body.expires_in - 60) * 1000 };
      return token.value;
    }

    if (isTransientStatus(response.status)) {
      throw new TransientError("atlas_token_unavailable", `Atlas no pudo emitir el token (HTTP ${response.status}).`);
    }
    throw new FatalError(
      "atlas_invalid_credentials",
      "Atlas rechazó las credenciales de la Service Account (ATLAS_CLIENT_ID / ATLAS_CLIENT_SECRET). Revísalas o genera un secret nuevo."
    );
  }

  async function request(method: string, path: string, body?: unknown, retried = false): Promise<Response> {
    const accessToken = await getToken();
    const response = await send(`${baseUrl}/api/atlas/v2${path}`, {
      method,
      headers: {
        Accept: DATABASE_USERS_VERSION,
        Authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { "Content-Type": DATABASE_USERS_VERSION })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    // Token caducado o revocado entre llamadas: se renueva una vez.
    if (response.status === 401 && !retried) {
      token = undefined;
      await getToken(true);
      return request(method, path, body, true);
    }
    return response;
  }

  async function fail(response: Response, action: string): Promise<never> {
    const info = (await response.json().catch(() => ({}))) as AtlasApiError;
    const code = info.errorCode ? ` [${info.errorCode}]` : "";

    if (isTransientStatus(response.status)) {
      throw new TransientError("atlas_unavailable", `Atlas respondió HTTP ${response.status} al ${action}${code}.`);
    }
    if (response.status === 401) {
      throw new FatalError("atlas_invalid_credentials", `Atlas rechazó el token al ${action}${code}. Revisa la Service Account.`);
    }
    if (response.status === 403) {
      throw new FatalError(
        "atlas_forbidden",
        `Atlas denegó el acceso al ${action}${code}. La Service Account necesita el rol Project Database Access Admin (o superior) en el proyecto y la IP del servidor debe estar en su access list.`
      );
    }
    if (response.status === 404) {
      throw new FatalError("atlas_not_found", `Atlas no encontró el proyecto al ${action}${code}. Revisa ATLAS_PROJECT_ID.`);
    }
    throw new FatalError("atlas_rejected", `Atlas rechazó la petición al ${action} (HTTP ${response.status})${code}.`);
  }

  function userBody(spec: DatabaseUserSpec) {
    registerSecret(spec.password);
    return {
      groupId: config.projectId,
      databaseName: "admin",
      username: spec.username,
      password: spec.password,
      description: spec.description.slice(0, 100),
      labels: spec.labels,
      // readWrite SOLO sobre la base del cliente y solo en el clúster compartido.
      roles: [{ roleName: "readWrite", databaseName: spec.database }],
      scopes: [{ name: config.clusterName, type: "CLUSTER" }]
    };
  }

  const usersPath = `/groups/${encodeURIComponent(config.projectId)}/databaseUsers`;
  const userPath = (username: string) => `${usersPath}/admin/${encodeURIComponent(username)}`;

  return {
    async getDatabaseUser(username) {
      const response = await request("GET", userPath(username));
      if (response.status === 404) {
        const info = (await response.json().catch(() => ({}))) as AtlasApiError;
        // 404 del usuario (no del proyecto) significa "no existe".
        if (info.errorCode !== "GROUP_NOT_FOUND" && info.errorCode !== "INVALID_GROUP_ID") return null;
        throw new FatalError("atlas_not_found", `Atlas no encontró el proyecto [${info.errorCode}]. Revisa ATLAS_PROJECT_ID.`);
      }
      if (!response.ok) return fail(response, "consultar el usuario de base de datos");
      const user = (await response.json()) as AtlasDatabaseUser;
      return { ...user, labels: user.labels ?? [], roles: user.roles ?? [], scopes: user.scopes ?? [] };
    },

    async createDatabaseUser(spec) {
      const response = await request("POST", usersPath, userBody(spec));
      if (response.status === 409) throw new AtlasUserExistsError();
      if (!response.ok) return fail(response, "crear el usuario de base de datos");
    },

    async updateDatabaseUser(spec) {
      const response = await request("PATCH", userPath(spec.username), userBody(spec));
      if (!response.ok) return fail(response, "actualizar el usuario de base de datos");
    }
  };
}
