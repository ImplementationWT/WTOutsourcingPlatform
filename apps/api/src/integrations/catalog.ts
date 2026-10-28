import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

/**
 * Catálogo de integraciones opcionales de las apps de clientes (fuente única).
 * Cada proveedor declara sus campos, la variable de entorno destino según el
 * contrato del template (§2, §3) y cómo validar la credencial. El panel pinta el
 * formulario a partir de `publicCatalog()`; las credenciales nunca salen de aquí.
 */
export type ValidationCode = "auth_failed" | "timeout" | "unavailable";
export type ValidationResult = { ok: true } | { ok: false; code: ValidationCode };

export interface IntegrationField {
  name: string;
  label: string;
  type: "secret" | "text";
  /** Secret del entorno production del repo (nombre del contrato). */
  envVar: string;
  placeholder?: string;
  maxLength: number;
}

export interface IntegrationProvider {
  id: string;
  label: string;
  description: string;
  /** Pasos para obtener la credencial (texto de ayuda del formulario). */
  help: string[];
  helpUrl: string;
  fields: IntegrationField[];
  /** Comprueba la credencial contra el host fijo del proveedor. */
  validate(credentials: Record<string, string>, fetchImpl?: typeof fetch): Promise<ValidationResult>;
}

const VALIDATION_TIMEOUT_MS = 10_000;

/** POST JSON a un endpoint FIJO del catálogo: timeout y sin seguir redirecciones. */
async function postFixed(url: string, headers: Record<string, string>, body: unknown, fetchImpl: typeof fetch) {
  try {
    return await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS)
    });
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === "TimeoutError" || name === "AbortError") return "timeout" as const;
    return "unavailable" as const;
  }
}

/** API GraphQL de Monday: el token va tal cual en Authorization y la versión en API-Version. */
export const MONDAY_API_URL = "https://api.monday.com/v2";
export const MONDAY_API_VERSION = "2026-07";

const monday: IntegrationProvider = {
  id: "monday",
  label: "Monday.com",
  description: "La app del cliente muestra un tab Monday con los tableros de la cuenta.",
  help: [
    "En Monday.com: avatar → Developers → My access tokens → Show → copiar el token personal.",
    "Recomendado: crea un usuario dedicado con acceso solo a los tableros que deba ver la app. El token hereda los permisos de su dueño: la app mostrará exactamente los tableros que ve ese usuario."
  ],
  helpUrl: "https://developer.monday.com/api-reference/docs/authentication",
  fields: [{ name: "token", label: "Token de la API", type: "secret", envVar: "MONDAY_API_TOKEN", maxLength: 2_000 }],
  async validate(credentials, fetchImpl = fetch) {
    // Consulta mínima: quién es el dueño del token.
    const response = await postFixed(
      MONDAY_API_URL,
      { Authorization: credentials.token, "API-Version": MONDAY_API_VERSION },
      { query: "query { me { id } }" },
      fetchImpl
    );
    if (typeof response === "string") return { ok: false, code: response };
    if (response.status === 401 || response.status === 403) return { ok: false, code: "auth_failed" };
    if (!response.ok) return { ok: false, code: "unavailable" };
    const body = (await response.json().catch(() => null)) as { data?: { me?: { id?: unknown } | null }; errors?: unknown[] } | null;
    if (body?.data?.me?.id !== undefined && body.data.me.id !== null) return { ok: true };
    // GraphQL responde 200 con errores cuando el token no autentica.
    return { ok: false, code: body?.errors ? "auth_failed" : "unavailable" };
  }
};

/**
 * Will Doo, el co-pilot de la app del cliente (plantilla 1.7.0): habla con Claude con la clave
 * de Anthropic DE ESTE PROYECTO, así el gasto queda separado por cliente. No es la clave del AI
 * Developer de Launchpad.
 */
const willDoo: IntegrationProvider = {
  id: "anthropic",
  label: "Will Doo (Claude)",
  description: "El co-pilot de la app: responde con los datos del sistema según los permisos de cada usuario.",
  help: [
    "En console.anthropic.com: Settings → API keys → Create key. Usa una clave solo para este proyecto (mejor en un workspace propio) para separar y limitar su gasto.",
    "La app la usa solo desde su servidor; nunca llega al navegador. Requiere la plantilla 1.7.0 o posterior y el permiso willdoo.use en los roles que deban usarlo."
  ],
  helpUrl: "https://docs.anthropic.com/en/api/admin-api/apikeys/get-api-key",
  fields: [{ name: "apiKey", label: "Clave de la API de Anthropic", type: "secret", envVar: "ANTHROPIC_API_KEY", maxLength: 400 }],
  async validate(credentials, fetchImpl = fetch) {
    // Consulta mínima con el SDK oficial: lista un modelo (no genera ni gasta tokens).
    const client = new Anthropic({ apiKey: credentials.apiKey, fetch: fetchImpl, maxRetries: 0, timeout: VALIDATION_TIMEOUT_MS });
    try {
      await client.models.list({ limit: 1 });
      return { ok: true };
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return { ok: false, code: "auth_failed" };
      if (error instanceof Anthropic.APIConnectionTimeoutError) return { ok: false, code: "timeout" };
      return { ok: false, code: "unavailable" };
    }
  }
};

export const INTEGRATIONS: Record<string, IntegrationProvider> = { [monday.id]: monday, [willDoo.id]: willDoo };

export function getProvider(id: string) {
  return Object.hasOwn(INTEGRATIONS, id) ? INTEGRATIONS[id] : undefined;
}

/** Lo que ve el panel: sin funciones ni nada sensible. */
export function publicCatalog() {
  return Object.values(INTEGRATIONS).map(({ id, label, description, help, helpUrl, fields }) => ({
    id,
    label,
    description,
    help,
    helpUrl,
    fields: fields.map(({ name, label: fieldLabel, type, placeholder, maxLength }) => ({ name, label: fieldLabel, type, placeholder, maxLength }))
  }));
}

/** Credenciales de un proveedor: exactamente sus campos, sin espacios ni saltos de línea. */
export function credentialsSchema(provider: IntegrationProvider) {
  return z
    .object(
      Object.fromEntries(
        provider.fields.map((field) => [
          field.name,
          z
            .string()
            .min(1, `Falta ${field.label}`)
            .max(field.maxLength)
            .regex(/^\S+$/, `${field.label} no puede contener espacios ni saltos de línea`)
        ])
      )
    )
    .strict();
}

/** `integrations` de POST /api/clients: solo proveedores del catálogo, sin campos extra. */
export const integrationsInputSchema = z
  .object(Object.fromEntries(Object.values(INTEGRATIONS).map((p) => [p.id, credentialsSchema(p).optional()])))
  .strict();
