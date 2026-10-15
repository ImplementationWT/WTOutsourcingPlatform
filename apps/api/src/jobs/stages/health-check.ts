import { FatalError } from "../../lib/errors.js";
import { pollUntil } from "../../lib/retry.js";
import type { Stage } from "../types.js";

export const healthCheckStage: Stage = {
  name: "health_check",
  async run(ctx) {
    const { names, store, deps, client } = ctx;
    const { probe, timing, sleep } = deps;

    await ctx.report(`Esperando ${names.baseUrl}/health/ready…`);
    const ready = await pollUntil(
      async () => ((await probe.status(`${names.baseUrl}/health/ready`)) === 200 ? true : undefined),
      { timeoutMs: timing.healthTimeoutMs, intervalMs: timing.pollIntervalMs, sleep }
    );
    if (!ready) {
      throw new FatalError("not_ready", `${names.host} no respondió 200 en /health/ready. Revisa el proxy, el DNS y el contenedor.`);
    }

    const meta = await probe.json(`${names.baseUrl}/api/meta`);
    const clientId = (meta.body as { clientId?: unknown } | null)?.clientId;
    if (meta.status !== 200 || clientId !== client._id) {
      throw new FatalError(
        "meta_mismatch",
        meta.body === null && meta.status === 200
          ? "/api/meta responde null: falta el documento de bootstrap."
          : `/api/meta no devolvió el clientId esperado (HTTP ${meta.status}).`
      );
    }

    const checkedAt = new Date();
    await store.updateClient(client._id, { readiness: { ready: true, checkedAt, detail: "/health/ready 200 · /api/meta OK" } });
    await ctx.report(`${names.host} listo: /health/ready 200 y /api/meta con clientId correcto.`);
  }
};
