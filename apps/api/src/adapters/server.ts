import { createHash } from "node:crypto";
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

/** Respuesta de uninstall-client: qué había y se retiró. */
const uninstallResultSchema = z.object({
  status: z.literal("ok"),
  slug: z.string(),
  removed: z.object({
    container: z.boolean(),
    images: z.number().int(),
    network: z.boolean(),
    nginx: z.boolean(),
    certificate: z.boolean(),
    key: z.boolean(),
    port: z.boolean(),
    files: z.boolean()
  })
});

/** Respuesta de preview-install: host y puerto de la vista previa (certificado reutilizado si existe). */
const previewInstallSchema = z.object({
  status: z.literal("ok"),
  slug: z.string(),
  host: z.string(),
  port: z.number().int(),
  certificate: z.enum(["issued", "existing"])
});

/** Respuesta de preview-stop. */
const previewStopSchema = z.object({ status: z.literal("ok"), slug: z.string(), stopped: z.boolean() });

/** Respuesta de server-info: verificación del servidor (sin secretos). */
const serverInfoSchema = z.object({
  status: z.literal("ok"),
  scriptsVersion: z.number().int(),
  appBaseDomain: z.string(),
  ghcrOrg: z.string(),
  acmeEmail: z.boolean(),
  panelOrigin: z.string().nullable(),
  panelUpstream: z.string(),
  nginx: z.object({ valid: z.boolean(), include: z.boolean() }),
  docker: z.boolean(),
  certbot: z.boolean(),
  ports: z.object({ used: z.number().int(), total: z.number().int() }),
  diskFreeMb: z.number().nullable()
});

export type ServerInfo = Omit<z.infer<typeof serverInfoSchema>, "status">;
export type InstallResult = z.infer<typeof installResultSchema>;
export type PreviewInstallResult = z.infer<typeof previewInstallSchema>;
export type UninstallResult = z.infer<typeof uninstallResultSchema>;
export type ServerClientStatus = z.infer<typeof clientStatusSchema>;

export interface ServerAdapter {
  /**
   * sudo /opt/platform/bin/install-client <slug> con la clave pública del cliente por stdin.
   * Sin clave, conserva la ya instalada (falla si no hay ninguna).
   */
  installClient(slug: Slug, publicKey?: string): Promise<InstallResult>;
  /** Consulta predefinida de solo lectura. */
  clientStatus(slug: Slug): Promise<ServerClientStatus>;
  /** sudo /opt/platform/bin/uninstall-client <slug>: retira todo lo del cliente (idempotente). */
  uninstallClient(slug: Slug): Promise<UninstallResult>;
  /** Prepara preview-<slug>.<dominio> (puerto, certificado y nginx con acceso solo desde Launchpad). */
  installPreview(slug: Slug): Promise<PreviewInstallResult>;
  /** Para la vista previa y borra su base temporal; nginx y el certificado se conservan. */
  stopPreview(slug: Slug): Promise<{ stopped: boolean }>;
  /** Verificación de solo lectura: versión de los scripts y configuración del servidor. */
  serverInfo(): Promise<ServerInfo>;
}

export interface ServerConnection {
  host: string;
  port: number;
  /** Claves aceptadas del servidor (huella fijada: equivale a StrictHostKeyChecking yes). */
  hostKeys: { type: string; key: Buffer }[];
  provisionerKey: string;
}

/** Blob de una clave pública ed25519 válida: tipo (4 + 11 bytes) y clave de exactamente 32 bytes. */
function isValidEd25519Blob(blob: Buffer) {
  return blob.length === 51 && blob.readUInt32BE(0) === 11 && blob.toString("latin1", 4, 15) === "ssh-ed25519" && blob.readUInt32BE(15) === 32;
}

/**
 * Par ed25519 por cliente en formato OpenSSH; la privada queda registrada para redactarse.
 *
 * ssh2 genera a veces (≈1 de cada 300) una clave inválida: si el primer byte de la
 * clave pública es 0x00 lo descarta y la deja en 31 bytes. Esos pares se desechan y se
 * genera otro; además se comprueba que la privada se lee y corresponde a la pública.
 */
export function generateClientKeyPair(comment: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const pair = utils.generateKeyPairSync("ed25519", { comment });
    const publicKey = pair.public.trim();
    const blob = Buffer.from(publicKey.split(" ")[1] ?? "", "base64");
    const parsed = utils.parseKey(pair.private);
    if (!isValidEd25519Blob(blob) || parsed instanceof Error || Array.isArray(parsed) || !parsed.getPublicSSH().equals(blob)) continue;
    registerSecret(pair.private);
    return { privateKey: pair.private, publicKey };
  }
  throw new Error("No se pudo generar una clave ed25519 válida.");
}

/** Únicos comandos que el orquestador puede pedir (provisioner-dispatch aplica la misma lista). */
type ServerCommand = "install-client" | "client-status" | "uninstall-client" | "preview-install" | "preview-stop" | "server-info";

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

  function run(command: ServerCommand, slug: Slug | null, stdin: string, timeoutMs: number) {
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
        // El comando son tokens fijos: verbo de la lista y, si lo lleva, slug ya validado (tipo Slug).
        client.exec(slug ? `${command} ${slug}` : command, (error, stream) => {
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
            new FatalError(
              "server_host_key_mismatch",
              `La clave de ${connection.host} no coincide con la huella fijada. No se conecta (posible suplantación).`
            )
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
    },
    async uninstallClient(slug) {
      const result = await run("uninstall-client", slug, "", INSTALL_TIMEOUT_MS);
      check("uninstall-client", result);
      return parse(uninstallResultSchema, "uninstall-client", result.stdout);
    },
    async installPreview(slug) {
      const result = await run("preview-install", slug, "", INSTALL_TIMEOUT_MS);
      check("preview-install", result);
      return parse(previewInstallSchema, "preview-install", result.stdout);
    },
    async stopPreview(slug) {
      const result = await run("preview-stop", slug, "", INSTALL_TIMEOUT_MS);
      check("preview-stop", result);
      return { stopped: parse(previewStopSchema, "preview-stop", result.stdout).stopped };
    },
    async serverInfo() {
      const result = await run("server-info", null, "", QUERY_TIMEOUT_MS);
      check("server-info", result);
      return parse(serverInfoSchema.omit({ status: true }), "server-info", result.stdout);
    }
  };
}

/** Huella como la imprime `ssh-keygen -lf`: SHA256:<base64 sin relleno>. */
export function hostKeyFingerprint(key: Buffer) {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

/**
 * Lee la clave ed25519 del servidor sin autenticarse (se corta la conexión al recibirla).
 * Solo sirve para mostrar su huella: se fija cuando una persona la confirma con la que
 * ve en la consola del VPS, nunca automáticamente.
 */
export function fetchHostKey(host: string, port: number, timeoutMs = 15_000) {
  return new Promise<{ type: "ssh-ed25519"; key: Buffer; fingerprint: string }>((resolve, reject) => {
    const client = new Client();
    let captured: Buffer | undefined;
    const timer = setTimeout(() => finish(new TransientError("server_unreachable", `${host}:${port} no respondió por SSH.`)), timeoutMs);
    function finish(error?: Error) {
      clearTimeout(timer);
      client.end();
      if (captured) resolve({ type: "ssh-ed25519", key: captured, fingerprint: hostKeyFingerprint(captured) });
      else reject(error ?? new TransientError("server_unreachable", `No se pudo leer la clave SSH de ${host}.`));
    }
    client.on("error", () => finish());
    client.connect({
      host,
      port,
      username: "provisioner",
      readyTimeout: timeoutMs,
      // La de ed25519: la misma que muestra ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub.
      algorithms: { serverHostKey: ["ssh-ed25519"] },
      hostVerifier: (key: Buffer) => {
        captured = Buffer.from(key);
        return false;
      }
    });
  });
}
