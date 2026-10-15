import { afterEach, describe, expect, it } from "vitest";
import ssh2 from "ssh2";
import { createServerAdapter, generateClientKeyPair } from "../src/adapters/server.js";
import { parseSlug } from "../src/domain/naming.js";
import { FatalError } from "../src/lib/errors.js";
import { redactString } from "../src/lib/redact.js";

const { Server, utils } = ssh2;
const hostKey = utils.generateKeyPairSync("ed25519");
const otherHostKey = utils.generateKeyPairSync("ed25519");
const provisioner = utils.generateKeyPairSync("ed25519");
const keyBlob = (publicKey: string) => Buffer.from(publicKey.split(" ")[1], "base64");

interface Received {
  user: string;
  command: string;
  stdin: string;
}

let servers: Server[] = [];
afterEach(() => {
  for (const server of servers) server.close();
  servers = [];
});

/** sshd en proceso: acepta solo la clave del provisioner y responde según el comando. */
function startServer(reply: (command: string, stdin: string) => { code: number; stdout?: string; stderr?: string }) {
  const received: Received[] = [];
  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    let user = "";
    client.on("authentication", (ctx) => {
      user = ctx.username;
      const ok = ctx.method === "publickey" && ctx.key.data.equals(keyBlob(provisioner.public));
      return ok ? ctx.accept() : ctx.reject(["publickey"]);
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        accept().on("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          let stdin = "";
          stream.on("data", (chunk: Buffer) => (stdin += chunk.toString()));
          stream.on("end", () => {
            received.push({ user, command: info.command, stdin });
            const result = reply(info.command, stdin);
            if (result.stdout) stream.write(result.stdout);
            if (result.stderr) stream.stderr.write(result.stderr);
            stream.exit(result.code);
            stream.end();
          });
        });
      });
    });
    client.on("error", () => {});
  });
  servers.push(server);
  return new Promise<{ port: number; received: Received[] }>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as { port: number }).port, received }))
  );
}

const adapter = (port: number, opts: { hostKey?: string; key?: string } = {}) =>
  createServerAdapter({
    host: "127.0.0.1",
    port,
    hostKeys: [{ type: "ssh-ed25519", key: keyBlob(opts.hostKey ?? hostKey.public) }],
    provisionerKey: opts.key ?? provisioner.private
  });

describe("adaptador SSH del orquestador", () => {
  it("install-client: usuario provisioner, comando fijo con el slug y clave pública por stdin", async () => {
    const { port, received } = await startServer(() => ({
      code: 0,
      stdout: 'progreso\n{"status":"ok","slug":"acme-crm","host":"acme-crm.apps.test","port":20001,"certificate":"issued","key":"installed"}\n'
    }));
    const pair = generateClientKeyPair("acme-org/acme-crm-app");
    const result = await adapter(port).installClient(parseSlug("acme-crm"), pair.publicKey);
    expect(result).toEqual({ status: "ok", slug: "acme-crm", host: "acme-crm.apps.test", port: 20001, certificate: "issued", key: "installed" });
    expect(received).toEqual([{ user: "provisioner", command: "install-client acme-crm", stdin: `${pair.publicKey}\n` }]);
    // La privada nunca viaja al servidor y queda registrada para redactarse.
    expect(received[0].stdin).not.toContain("PRIVATE KEY");
    expect(redactString(pair.privateKey)).toBe("[REDACTED]");
  });

  it("install-client sin clave: stdin vacío para conservar la instalada", async () => {
    const { port, received } = await startServer(() => ({
      code: 0,
      stdout: '{"status":"ok","slug":"acme-crm","host":"acme-crm.apps.test","port":20001,"certificate":"existing","key":"kept"}'
    }));
    expect((await adapter(port).installClient(parseSlug("acme-crm"))).key).toBe("kept");
    expect(received[0]).toMatchObject({ command: "install-client acme-crm", stdin: "" });
  });

  it("client-status: consulta predefinida sin stdin", async () => {
    const { port, received } = await startServer(() => ({
      code: 0,
      stdout: JSON.stringify({
        slug: "acme-crm",
        host: "acme-crm.apps.test",
        port: 20001,
        nginx: true,
        certificate: { notAfter: "2027-01-13T15:01:54Z" },
        deployment: null,
        container: null
      })
    }));
    const status = await adapter(port).clientStatus(parseSlug("acme-crm"));
    expect(status.port).toBe(20001);
    expect(received[0]).toMatchObject({ command: "client-status acme-crm", stdin: "" });
  });

  it("rechaza un servidor cuya clave no coincide con la fijada (StrictHostKeyChecking)", async () => {
    const { port, received } = await startServer(() => ({ code: 0 }));
    const error = await adapter(port, { hostKey: otherHostKey.public }).clientStatus(parseSlug("acme-crm")).catch((e) => e);
    expect(error).toBeInstanceOf(FatalError);
    expect(error.code).toBe("server_host_key_mismatch");
    expect(received).toHaveLength(0);
  });

  it("clave del provisioner rechazada: error accionable", async () => {
    const { port } = await startServer(() => ({ code: 0 }));
    const intruder = utils.generateKeyPairSync("ed25519");
    const error = await adapter(port, { key: intruder.private }).clientStatus(parseSlug("acme-crm")).catch((e) => e);
    expect(error.code).toBe("server_auth_failed");
    expect(error.message).toContain("--provisioner-pubkey");
  });

  it("si el script falla, el motivo es su última línea ERROR (sin el resto de stderr)", async () => {
    const { port } = await startServer(() => ({
      code: 1,
      stderr: "detalle técnico\nERROR: nginx no incluye /etc/nginx/platform-apps. Añade la línea: include /etc/nginx/platform-apps/*.conf;\n"
    }));
    const error = await adapter(port).installClient(parseSlug("acme-crm"), generateClientKeyPair("x").publicKey).catch((e) => e);
    expect(error.code).toBe("server_command_failed");
    expect(error.message).toContain("include /etc/nginx/platform-apps/*.conf;");
    expect(error.message).not.toContain("detalle técnico");
  });

  it("comando rechazado por provisioner-dispatch (126)", async () => {
    const { port } = await startServer(() => ({ code: 126, stderr: "REJECTED command not allowed\n" }));
    const error = await adapter(port).clientStatus(parseSlug("acme-crm")).catch((e) => e);
    expect(error.code).toBe("server_command_rejected");
  });

  it("respuesta con formato inesperado", async () => {
    const { port } = await startServer(() => ({ code: 0, stdout: "no json" }));
    const error = await adapter(port).clientStatus(parseSlug("acme-crm")).catch((e) => e);
    expect(error.code).toBe("server_bad_response");
  });

  it("solo acepta slugs validados: el navegador no puede inyectar comandos", () => {
    for (const bad of ["acme; id", "acme\nid", "../x", "ACME", "a b"]) expect(() => parseSlug(bad)).toThrow();
  });
});
