import { randomUUID } from "node:crypto";

const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Direcciones de una cabecera (From/To/Cc), en minúsculas y sin repetir. */
export function addresses(header: string | undefined) {
  return [...new Set((header ?? "").match(EMAIL)?.map((e) => e.toLowerCase()) ?? [])];
}

/** Nombre visible de la primera dirección («Juan Pérez <juan@acme.com>» → «Juan Pérez»). */
export function displayName(header: string | undefined) {
  const first = (header ?? "").split(",")[0] ?? "";
  const name = first.replace(/<[^>]*>/, "").replace(/["']/g, "").trim();
  return name && !name.includes("@") ? name : "";
}

export const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

/** Correos gratuitos: su dominio nunca identifica a un cliente. */
export const PUBLIC_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.es",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "zoho.com"
]);

/** RFC 2047: cabecera con acentos o ñ en base64 UTF-8 (las ASCII van tal cual). */
const encodeHeader = (value: string) => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`);
/** Quita saltos de línea: una cabecera nunca puede abrir otra. */
const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

/** «Asunto» → «Re: Asunto» (sin repetir el «Re:»). */
export const replySubject = (subject: string) => (/^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`);

/**
 * MIME de texto plano para enviar. From lo pone Gmail igual (el buzón de la persona); aquí va con
 * su nombre. Las direcciones ya vienen validadas.
 */
export function buildMime({ from, fromName, to, cc, subject, body, inReplyTo, references }: { from: string; fromName?: string; to: string[]; cc?: string[]; subject: string; body: string; inReplyTo?: string | null; references?: string | null }) {
  const domain = domainOf(from);
  const lines = [
    `From: ${fromName ? `${encodeHeader(oneLine(fromName.replace(/["<>]/g, "")))} <${from}>` : from}`,
    `To: ${to.join(", ")}`,
    ...(cc?.length ? [`Cc: ${cc.join(", ")}`] : []),
    `Subject: ${encodeHeader(oneLine(subject))}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    ...(inReplyTo ? [`In-Reply-To: ${oneLine(inReplyTo)}`, `References: ${oneLine([references, inReplyTo].filter(Boolean).join(" "))}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    (Buffer.from(body.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n")
  ];
  return lines.join("\r\n");
}
