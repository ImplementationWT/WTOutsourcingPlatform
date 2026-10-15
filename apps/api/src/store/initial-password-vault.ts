import type { Collection } from "mongodb";
import { open, type Sealed, seal } from "../lib/server-cipher.js";

export interface InitialPasswordDoc extends Sealed {
  _id: string; // slug del cliente
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Guarda la contraseña inicial del admin de una app, cifrada con la clave del
 * servidor, hasta que el operador la ve una vez o vence el TTL. En la base solo
 * queda el texto cifrado; el valor en claro solo existe en memoria.
 *
 * El índice TTL de MongoDB borra los documentos vencidos (con hasta ~60 s de
 * retraso), así que las lecturas también comprueban `expiresAt`.
 */
export class InitialPasswordVault {
  constructor(
    private readonly collection: Collection<InitialPasswordDoc>,
    private readonly key: Buffer | undefined,
    /** Reloj del almacén; el panel lo usa para decidir si la contraseña venció. */
    readonly now: () => Date = () => new Date()
  ) {}

  async init() {
    await this.collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "ttl" });
  }

  private requireKey() {
    if (!this.key) throw new Error("INITIAL_PASSWORD_KEY_PATH no está configurada.");
    return this.key;
  }

  /** Guarda (o reemplaza) la contraseña del cliente. Devuelve cuándo vence. */
  async put(clientId: string, password: string, ttlMs: number) {
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + ttlMs);
    await this.collection.replaceOne(
      { _id: clientId },
      { ...seal(this.requireKey(), password, clientId), createdAt, expiresAt },
      { upsert: true }
    );
    return expiresAt;
  }

  /** Vencimiento de la contraseña pendiente de revelar, o null si no hay ninguna vigente. */
  async pendingUntil(clientId: string) {
    const doc = await this.collection.findOne({ _id: clientId, expiresAt: { $gt: this.now() } }, { projection: { expiresAt: 1 } });
    return doc?.expiresAt ?? null;
  }

  /** Entrega la contraseña y la borra en la misma operación: dos peticiones simultáneas no la obtienen dos veces. */
  async take(clientId: string) {
    const doc = await this.collection.findOneAndDelete({ _id: clientId, expiresAt: { $gt: this.now() } });
    return doc ? open(this.requireKey(), doc, clientId) : null;
  }
}
