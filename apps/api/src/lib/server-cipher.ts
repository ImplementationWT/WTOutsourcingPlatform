import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface Sealed {
  iv: string;
  ciphertext: string;
  tag: string;
}

/**
 * AES-256-GCM con una clave que solo tiene el servidor. `context` (p. ej. el
 * slug del cliente) va como dato autenticado: un texto cifrado no se puede
 * mover a otro contexto y descifrarse allí.
 */
export function seal(key: Buffer, plaintext: string, context: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

export function open(key: Buffer, sealed: Sealed, context: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64")), decipher.final()]).toString("utf8");
}
