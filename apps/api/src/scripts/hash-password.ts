import { createInterface } from "node:readline/promises";
import { hashPassword } from "../auth/password.js";

// Uso: pnpm hash-password  → pega el resultado en PANEL_ADMIN_PASSWORD_HASH.
const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
const password = await rl.question("Contraseña del panel: ");
rl.close();
if (password.length < 12) {
  process.stderr.write("Usa al menos 12 caracteres.\n");
  process.exit(1);
}
process.stdout.write(`${await hashPassword(password)}\n`);
