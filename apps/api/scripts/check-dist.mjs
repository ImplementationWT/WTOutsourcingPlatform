// Carga con Node (no con vitest) cada módulo compilado de dist/, salvo el punto de
// entrada (que necesita configuración) y los scripts de línea de comandos. Detecta errores que los tests no ven, como
// imports con nombre de paquetes CommonJS que Node no expone en ESM.
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("../dist/", import.meta.url).pathname;
const files = readdirSync(root, { recursive: true })
  .map(String)
  .filter((file) => file.endsWith(".js") && file !== "index.js" && !file.startsWith("scripts/"));

let failed = 0;
for (const file of files) {
  try {
    await import(pathToFileURL(join(root, file)).href);
  } catch (error) {
    failed++;
    console.error(`✗ dist/${relative(root, join(root, file))}: ${error.message}`);
  }
}
if (failed) process.exit(1);
console.log(`dist/: ${files.length} módulos cargan en Node`);
