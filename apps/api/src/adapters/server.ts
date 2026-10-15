// ssh2 es CommonJS: en Node (ESM) solo expone el export por defecto.
import ssh2 from "ssh2";
import { z } from "zod";
import type { Slug } from "../domain/naming.js";
import { FatalError, TransientError } from "../lib/errors.js";
import { redactString, registerSecret } from "../lib/redact.js";

const { Client, utils } = ssh2;

/** Respuesta de install-client (última línea de stdout). */
const installResultSchema = z.object({
  status: z.literal("ok"),
  slug: z.string(),
  host: z.string(),
  port: z.number().int(),
  certificate: z.enum(["issued", "existing"]),
  key: z.enum(["installed", "kept"])
});

/** Respuesta de client-status: sin variables de entorno, claves ni tokens. */
const clientStatusSchema = z.object({
  slug: z.string(),
  host: z.string(),
  port: z.number().int().nullable(),
  nginx: z.boolean(),
  certificate: z.object({ notAfter: z.string() }).nullable(),
  deployment: z.object({ image: z.string(), deployedAt: z.string() }).nullable(),
  container: z.object({ state: z.string(), health: z.string().nullable() }).nullable()
});

export type InstallResult = z.infer<typeof installResultSchema>;
export type ServerClientStatus = z.infer<typeof clientStatusSchema>;

export interface ServerAdapter {
  /**
   * sudo /opt/platform/bin/install-client <slug> con la clave pública del cliente por stdin.
   * Sin clave, conserva la ya instalada (falla si no hay ninguna).
   */
  installClient(slug: Slug, publicKey?: string): Promise<InstallResult>;
  /** Consulta predefinida de solo lectura. */
  clientStatus(slug: Slug): Promise<ServerClientStatus>;
}

export interface ServerConnection {
  host: string;
  port: number;
  /** Claves aceptadas del servidor (huella fijada: equivale a StrictHostKeyChecking yes). */
  hostKeys: { type: string; key: Buffer }[];
  provisionerKey: string;
}

/** Par ed25519 por cliente en formato OpenSSH; la privada queda registrada para redactarse. */
export function generateClientKeyPair(comment: string) {
  const pair = utils.generateKeyPairSync("ed25519", { comment });
  registerSecret(pair.private);
  return { privateKey: pair.private, publicKey: pair.public.trim() };
}

/** Únicos comandos que el orquestador puede pedir (provisioner-dispatch aplica la misma lista). */
type ServerCommand = "install-client" | "client-status";

const INSTALL_TIMEOUT_MS = 10 * 60_000; // incluye la emisión del certificado
const QUERY_TIMEOUT_MS = 30_000;

function lastLine(text: string) {
  return text.trimEnd().split("\n").at(-1) ?? "";
}

/** Motivo legible de un fallo del script: su última línea "ERROR: …" (nunca contiene secretos). */
function scriptError(stderr: string) {
  const line = stderr
    .split("\n")
    .filter((l) => l.startsWith("ERROR: "))
    .at(-1);
  return redactString(line ? line.slice("ERROR: ".length) : "el servidor no indicó el motivo");
}

export function createServerAdapter(connection: ServerConnection): ServerAdapter {
  registerSecret(connection.provisionerKey);

  function run(command: ServerCommand, slug: Slug, stdin: string, timeoutMs: number) {
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const client = new Client();
      let settled = false;
      const timer = setTimeout(
        () => done(new TransientError("server_timeout", `El servidor no respondió a ${command} a tiempo.`)),
        timeoutMs
      );
      function done(error: Error | null, value?: { code: number; stdout: string; stderr: string }) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.end();
        if (error) reject(error);
        else resolve(value!);
      }

      client.on("ready", () => {
        // El comando son dos tokens fijos: verbo de la lista y slug ya validado (tipo Slug).
        client.exec(`${command} ${slug}`, (error, stream) => {
          if (error) return done(new TransientError("server_exec_failed", `No se pudo ejecutar ${command} en el servidor.`));
          let stdout = "";
          let stderr = "";
          stream.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
          stream.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
          stream.on("close", (code: number | null) => done(null, { code: code ?? 1, stdout, stderr }));
          stream.end(stdin);
        });
      });

      client.on("error", (error: Error & { level?: string }) => {
        const message = String(error.message);
        if (/verification failed|host denied/i.test(message)) {
          return done(
            new FatalError("server_host_key_mismatch", "La clave del servidor no coincide con DEPLOY_HOST_KEY. No se conecta (posible suplantación).")
          );
        }
        if (/authentication methods failed/i.test(message)) {
          return done(
            new FatalError(
              "server_auth_failed",
              "El servidor rechazó la clave del provisioner. Instálala con bootstrap-vps.sh --provisioner-pubkey."
            )
          );
        }
        done(new TransientError("server_unreachable", `No se pudo conectar por SSH con ${connection.host}.`));
      });

      client.connect({
        host: connection.host,
        port: connection.port,
        username: "provisioner",
        privateKey: connection.provisionerKey,
        readyTimeout: 20_000,
        hostVerifier: (key: Buffer) => connection.hostKeys.some((allowed) => allowed.key.equals(key))
      });
    });
  }

  function check(command: ServerCommand, result: { code: number; stderr: string }) {
    if (result.code === 126) {
      throw new FatalError("server_command_rejected", `El servidor rechazó ${command}: revisa provisioner-dispatch y sudoers.`);
    }
    if (result.code !== 0) {
      throw new FatalError("server_command_failed", `${command} falló en el servidor: ${scriptError(result.stderr)}`);
    }
  }

  function parse<T>(schema: z.ZodType<T>, command: ServerCommand, stdout: string): T {
    try {
      return schema.parse(JSON.parse(lastLine(stdout)));
    } catch {
      throw new FatalError("server_bad_response", `${command} respondió en un formato inesperado.`);
    }
  }

  return {
    async installClient(slug, publicKey) {
      const result = await run("install-client", slug, publicKey ? `${publicKey}\n` : "", INSTALL_TIMEOUT_MS);
      check("install-client", result);
      return parse(installResultSchema, "install-client", result.stdout);
    },
    async clientStatus(slug) {
      const result = await run("client-status", slug, "", QUERY_TIMEOUT_MS);
      check("client-status", result);
      return parse(clientStatusSchema, "client-status", result.stdout);
    }
  };
}
