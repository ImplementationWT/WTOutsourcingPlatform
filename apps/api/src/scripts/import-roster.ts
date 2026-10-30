import { MongoClient } from "mongodb";
import { applyRoster, rosterSchema } from "../auth/roster.js";
import { loadEnv } from "../config/env.js";
import { registerSecret } from "../lib/redact.js";
import { AdminStore } from "../store/admin-store.js";

// Uso (en el servidor, con el mismo entorno que la API):
//   docker exec -i launchpad-api node dist/scripts/import-roster.js < equipo.json > accesos.tsv
// Da de alta equipos y personas desde un JSON por la entrada estándar (ver auth/roster.ts). Se
// puede repetir: lo que ya existe no se toca. El informe sale por stderr; las contraseñas
// temporales solo por stdout, que debe ir a un archivo (no a la pantalla ni a un log).
if (process.stdout.isTTY) {
  process.stderr.write("La salida lleva contraseñas temporales: redirígela a un archivo (… > accesos.tsv).\n");
  process.exit(1);
}

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
let input: unknown;
try {
  input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
} catch {
  process.stderr.write("La entrada no es un JSON válido.\n");
  process.exit(1);
}
const roster = rosterSchema.safeParse(input);
if (!roster.success) {
  process.stderr.write(`El JSON no es válido:\n${roster.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}\n`);
  process.exit(1);
}

const env = loadEnv();
registerSecret(env.ADMIN_MONGODB_URI);
const client = new MongoClient(env.ADMIN_MONGODB_URI, { appName: "provisioning-platform-roster" });
await client.connect();
try {
  const store = new AdminStore(client.db(env.ADMIN_MONGODB_DB));
  await store.init();
  const result = await applyRoster(store, roster.data, "importación");
  const label = { created: "creado", exists: "ya existía", conflict: "NO CAMBIADO", set: "líder asignado", unchanged: "líder ya asignado" } as const;
  for (const t of result.teams) process.stderr.write(`Equipo ${t.name}: ${label[t.status]}\n`);
  for (const u of result.users) process.stderr.write(`Usuario ${u.username} (${u.name}): ${label[u.status]}${u.message ? ` · ${u.message}` : ""}\n`);
  for (const l of result.leads) process.stderr.write(`Líder de ${l.team}: ${label[l.status]}${l.message ? ` · ${l.message}` : ""}\n`);
  const created = result.users.filter((u) => u.temporaryPassword);
  if (created.length) process.stdout.write(`usuario\tnombre\tcontraseña temporal\n${created.map((u) => `${u.username}\t${u.name}\t${u.temporaryPassword}`).join("\n")}\n`);
  process.stderr.write(`${created.length} cuentas nuevas. Cada persona cambia su contraseña en el primer ingreso.\n`);
  if (result.users.some((u) => u.status === "conflict") || result.leads.some((l) => l.status === "conflict")) process.exitCode = 2;
} finally {
  await client.close();
}
