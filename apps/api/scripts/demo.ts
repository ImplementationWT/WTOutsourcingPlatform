// pnpm dev:demo (desde la raíz): la plataforma en modo demostración para revisar el panel y el
// AI Developer sin credenciales ni coste. Todo es simulado y en memoria: GitHub, Atlas, los
// servidores y Claude (responde en varios pasos, deja un commit y abre PR como el real). Nada
// sale de este equipo. Panel: pnpm dev:web → http://localhost:5173 (admin / launchpad-local).
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";
import { JobEngine } from "../src/jobs/engine.js";
import { AdminStore } from "../src/store/admin-store.js";
import { FakeAgent } from "../tests/helpers/fake-agent.js";
import { createFakes, silent } from "../tests/helpers/fakes.js";

const PORT = Number(process.env.PORT || 3001);
const PASSWORD = process.env.LOCAL_ADMIN_PASSWORD || "launchpad-local";

const mongo = await MongoMemoryServer.create();
const client = await MongoClient.connect(mongo.getUri());
const store = new AdminStore(client.db("launchpad_demo"));
await store.init();
const fakes = createFakes(store);

// Proyectos de ejemplo ya aprovisionados (como si se hubieran creado desde el panel).
for (const project of [
  { slug: "tienda-demo", name: "Tienda Demo", description: "Tienda online de ejemplo para probar el AI Developer" },
  { slug: "crm-ventas", name: "CRM de Ventas", description: "Gestión de clientes y oportunidades del equipo comercial" }
]) {
  const job = await store.createClientWithJob({ ...project, actor: "admin" });
  await new JobEngine(store, fakes.deps, silent).run(job._id, "admin");
}

// Will Doo simulado: piensa, lee, edita, pasa las pruebas, sube un commit y resume en markdown.
const agent = new FakeAgent();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let cost = 0;
agent.onMessage = (sessionId, text) => {
  void (async () => {
    const session = agent.sessions.get(sessionId)!;
    const repo = session.input.repoUrl.split("/").pop()!;
    const emit = (event: Record<string, unknown>) => agent.emit(sessionId, event);
    const step = async (name: string, input: Record<string, unknown>, output: string) => {
      await wait(900);
      const use = emit({ type: "agent.tool_use", name, input, evaluated_permission: "allow" });
      await wait(700);
      emit({ type: "agent.tool_result", tool_use_id: use.id, is_error: false, content: [{ type: "text", text: output }] });
    };

    emit({ type: "session.status_running" });
    await wait(600);
    emit({ type: "agent.thinking" });
    await step("read", { file_path: "/workspace/app/README.md" }, "# App del cliente\n\nPlantilla node-typescript…");
    await step("grep", { pattern: "Bienvenido", path: "web/src" }, "web/src/pages/Home.tsx:12:  <h1>Bienvenido</h1>");
    await step("edit", { file_path: "/workspace/app/web/src/pages/Home.tsx" }, "Archivo actualizado.");
    await step("bash", { command: "pnpm lint && pnpm typecheck && pnpm test" }, "✓ lint\n✓ typecheck\n✓ 48 tests pasados");
    await step("bash", { command: "git commit -am 'Cambio pedido desde Launchpad' && git push origin HEAD" }, "1 file changed, 2 insertions(+), 2 deletions(-)");
    fakes.github.pushCommit(repo, session.input.branch, `Cambio pedido: ${text.slice(0, 60)}`);
    cost += 35;
    emit({ type: "session.usage", usage: { list_cost: { amount: String(cost), currency: "USD" } } });
    await wait(500);
    emit({
      type: "agent.message",
      content: [
        {
          type: "text",
          text: [
            "Listo. **Esto es una respuesta simulada** del modo demo; con la clave de Anthropic responde Will Doo de verdad.",
            "",
            "Qué hice:",
            "- Cambié el título de la pantalla de inicio en `web/src/pages/Home.tsx`.",
            "- Pasé `pnpm lint`, `typecheck` y los **48 tests**.",
            "- Subí el commit a la rama de esta sesión.",
            "",
            "Revisa el resultado en **Vista previa** y, si está bien, publícalo desde **Publicar**."
          ].join("\n")
        }
      ]
    });
    emit({ type: "session.status_idle", stop_reason: { type: "end_turn" }, stop_details: null });
  })();
};

const app = await buildApp({
  store,
  deps: fakes.deps,
  logLevel: "warn",
  auth: { adminUsername: "admin", adminPasswordHash: await hashPassword(PASSWORD), sessionSecret: "demo-".repeat(10), secureCookies: false },
  ai: { agent, config: { sessionBudgetCents: 1000, workspace: "default" } }
});
await app.listen({ port: PORT, host: "127.0.0.1" });

process.stdout.write(
  [
    "",
    "Launchpad en MODO DEMO (todo simulado, nada sale de este equipo).",
    `API: http://127.0.0.1:${PORT}`,
    "Ahora, en otra terminal: pnpm dev:web  →  http://localhost:5173",
    `Entra con admin / ${PASSWORD} → Proyectos → Tienda Demo → AI Developer.`,
    ""
  ].join("\n") + "\n"
);

const stop = async () => {
  await app.close();
  await client.close();
  await mongo.stop();
  process.exit(0);
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
