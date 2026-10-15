import { FatalError } from "../../lib/errors.js";
import { pollUntil } from "../../lib/retry.js";
import type { Stage } from "../types.js";

/** Forma de GET /api/meta desde el template 1.1.0 (contrato §1 y §7). */
interface AppMeta {
  appName?: unknown;
  clientId?: unknown;
  templateVersion?: unknown;
  schemaVersion?: unknown;
}

export const healthCheckStage: Stage = {
  name: "health_check",
  async run(ctx) {
    const { names, store, deps, client } = ctx;
    const { probe, timing, sleep, config } = deps;
    const minSchema = config.template.minSchemaVersion;

    await ctx.plan([
      { id: "ready", label: "GET /health/ready responde 200 (migraciones terminadas)" },
      { id: "meta", label: `GET /api/meta: clientId, schemaVersion ≥ ${minSchema} y appName` },
      { id: "frontend", label: "GET / sirve el frontend (HTML)" }
    ]);

    // El primer arranque espera a MongoDB y ejecuta las migraciones antes de responder 200 (contrato §6).
    await ctx.step("ready", "running", "El primer arranque ejecuta las migraciones; puede tardar unos minutos…");
    await ctx.report(`Esperando ${names.baseUrl}/health/ready…`);
    const ready = await pollUntil(
      async () => ((await probe.status(`${names.baseUrl}/health/ready`)) === 200 ? true : undefined),
      { timeoutMs: timing.healthTimeoutMs, intervalMs: timing.pollIntervalMs, maxIntervalMs: timing.pollIntervalMs * 6, sleep }
    );
    if (!ready) {
      throw new FatalError(
        "not_ready",
        `${names.host} no respondió 200 en /health/ready. Revisa el proxy, el DNS, el contenedor y que las migraciones terminen.`
      );
    }
    await ctx.step("ready", "done", "/health/ready 200: migraciones aplicadas.");

    await ctx.step("meta", "running");
    const meta = await probe.json(`${names.baseUrl}/api/meta`);
    const body = (meta.body ?? null) as AppMeta | null;
    if (meta.status !== 200 || !body) {
      throw new FatalError("meta_mismatch", `/api/meta no respondió un objeto (HTTP ${meta.status}).`);
    }
    if (body.clientId !== client._id) {
      throw new FatalError(
        "meta_mismatch",
        body.clientId === null
          ? "/api/meta devuelve clientId null: falta el documento de bootstrap."
          : "/api/meta no devolvió el clientId esperado."
      );
    }
    if (typeof body.schemaVersion !== "number" || body.schemaVersion < minSchema) {
      throw new FatalError(
        "schema_version_too_old",
        `/api/meta devuelve schemaVersion ${String(body.schemaVersion)} y se exige al menos ${minSchema} (MIN_SCHEMA_VERSION).`
      );
    }
    if (body.appName !== client.name) {
      throw new FatalError(
        "app_name_mismatch",
        `/api/meta devuelve appName "${String(body.appName)}" y se esperaba "${client.name}": revisa la variable APP_DISPLAY_NAME.`
      );
    }
    const schemaVersion = body.schemaVersion;
    await ctx.step("meta", "done", `Esquema verificado: schemaVersion ${schemaVersion} · appName "${client.name}" · clientId ${client._id}.`);

    await ctx.step("frontend", "running");
    const page = await probe.page(`${names.baseUrl}/`);
    if (page.status !== 200 || !page.contentType?.includes("text/html")) {
      throw new FatalError(
        "frontend_unavailable",
        `GET / respondió HTTP ${page.status} (${page.contentType ?? "sin Content-Type"}); se esperaba 200 con HTML.`
      );
    }
    await ctx.step("frontend", "done", "Frontend servido (200, text/html).");

    // Solo con las tres comprobaciones el cliente queda listo.
    const checkedAt = new Date();
    await store.setClientFields(client._id, {
      readiness: { ready: true, checkedAt, detail: `/health/ready 200 · /api/meta OK (schema ${schemaVersion}) · frontend OK` },
      "template.schemaVersion": schemaVersion,
      "template.schemaCheckedAt": checkedAt
    });
    await ctx.report(`${names.host} listo: migraciones aplicadas, /api/meta correcto y frontend servido.`);
  }
};
