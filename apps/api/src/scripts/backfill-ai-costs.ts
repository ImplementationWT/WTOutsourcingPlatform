import { MongoClient } from "mongodb";
import { createAnthropicAgentAdapter } from "../ai/anthropic-adapter.js";
import { backfillAiCosts } from "../ai/backfill.js";
import { loadAnthropicKey, loadEnv } from "../config/env.js";
import { registerSecret } from "../lib/redact.js";
import { AdminStore } from "../store/admin-store.js";

// Uso (en el servidor, con el mismo entorno que la API):
//   node dist/scripts/backfill-ai-costs.js      (o en desarrollo: pnpm backfill:ai-costs)
// Rellena el costo de las sesiones antiguas del AI Developer. Se puede repetir sin riesgo.
const env = loadEnv();
const apiKey = loadAnthropicKey(env);
if (!apiKey) {
  process.stderr.write("Falta la clave de la API de Anthropic: no se pueden leer los costos.\n");
  process.exit(1);
}
registerSecret(apiKey);
registerSecret(env.ADMIN_MONGODB_URI);

const client = new MongoClient(env.ADMIN_MONGODB_URI, { appName: "provisioning-platform-backfill" });
await client.connect();
try {
  const store = new AdminStore(client.db(env.ADMIN_MONGODB_DB));
  await store.init();
  const agent = createAnthropicAgentAdapter(apiKey, store.aiAgentSettings, env.ANTHROPIC_WORKSPACE);
  const result = await backfillAiCosts({ store, agent }, (session, error) => {
    // Solo el id de la sesión y el tipo de error: nunca la clave ni la respuesta completa.
    if (error) process.stderr.write(`No se pudo leer el costo de la sesión ${session._id} (${error instanceof Error ? error.name : "error"}).\n`);
  });
  process.stdout.write(`Sesiones revisadas: ${result.scanned}. Actualizadas: ${result.updated}. Sin costo disponible: ${result.costErrors}.\n`);
} finally {
  await client.close();
}
