import type { Collection } from "mongodb";
import { registerSecret } from "../lib/redact.js";
import { open, seal } from "../lib/server-cipher.js";

export interface ProvisioningSecretDoc {
  _id: string; // `${clientId}:${provider}`
  clientId: string;
  provider: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  createdAt: Date;
  expiresAt: Date;
}

export class SecretsKeyMissingError extends Error {}

/**
 * Credenciales de integraciones mientras se aprovisiona: solo cifradas (AES-256-GCM
 * con la clave del servidor y AAD = clientId + provider, así un texto cifrado no
 * sirve para otro cliente ni otro proveedor), con TTL, y se borran en cuanto
 * github_secrets las escribe en GitHub. El texto plano solo existe en memoria.
 */
export class ProvisioningSecrets {
  constructor(
    private readonly collection: Collection<ProvisioningSecretDoc>,
    private readonly key: Buffer | undefined,
    private readonly ttlMs: number,
    private readonly now: () => Date = () => new Date()
  ) {}

  get available() {
    return !!this.key;
  }

  async init() {
    await this.collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "ttl" });
    await this.collection.createIndex({ clientId: 1 });
  }

  private requireKey() {
    if (!this.key) throw new SecretsKeyMissingError("INTEGRATION_ENCRYPTION_KEY_SECRET_REF no está configurada.");
    return this.key;
  }

  private static aad(clientId: string, provider: string) {
    return `${clientId}:${provider}`;
  }

  async put(clientId: string, provider: string, credentials: Record<string, string>) {
    Object.values(credentials).forEach(registerSecret);
    const createdAt = this.now();
    const sealed = seal(this.requireKey(), JSON.stringify(credentials), ProvisioningSecrets.aad(clientId, provider));
    await this.collection.replaceOne(
      { _id: ProvisioningSecrets.aad(clientId, provider) },
      {
        clientId,
        provider,
        ciphertext: sealed.ciphertext,
        iv: sealed.iv,
        authTag: sealed.tag,
        createdAt,
        expiresAt: new Date(createdAt.getTime() + this.ttlMs)
      },
      { upsert: true }
    );
  }

  /** Credenciales descifradas, o null si no hay o ya vencieron (el TTL de MongoDB tarda hasta ~60 s). */
  async get(clientId: string, provider: string): Promise<Record<string, string> | null> {
    const doc = await this.collection.findOne({ _id: ProvisioningSecrets.aad(clientId, provider), expiresAt: { $gt: this.now() } });
    if (!doc) return null;
    // El AAD se recalcula desde los argumentos: un documento movido a otro _id no se descifra.
    const plain = open(this.requireKey(), { iv: doc.iv, ciphertext: doc.ciphertext, tag: doc.authTag }, ProvisioningSecrets.aad(clientId, provider));
    const credentials = JSON.parse(plain) as Record<string, string>;
    Object.values(credentials).forEach(registerSecret);
    return credentials;
  }

  async delete(clientId: string, provider: string) {
    await this.collection.deleteOne({ _id: ProvisioningSecrets.aad(clientId, provider) });
  }

  async deleteAll(clientId: string) {
    await this.collection.deleteMany({ clientId });
  }
}
