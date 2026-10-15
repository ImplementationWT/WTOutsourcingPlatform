import sodium from "libsodium-wrappers";

/**
 * Cifra un valor con la clave pública (base64) de un entorno/repositorio de
 * GitHub usando un sealed box de libsodium, como exige la API de secrets.
 */
export async function sealForGithub(publicKeyBase64: string, value: string): Promise<string> {
  await sodium.ready;
  const key = sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL);
  const sealed = sodium.crypto_box_seal(sodium.from_string(value), key);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}
