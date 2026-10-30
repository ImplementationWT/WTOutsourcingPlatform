import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { LeadDoc, LeadField, LeadSourceDoc } from "./models.js";

const MAX_FIELDS = 200;
const MAX_VALUE = 2000;
const MAX_DEPTH = 6;
export const MAX_RAW_JSON = 64 * 1024;

// ---- clave de ingesta ----------------------------------------------------------

export const newIngestKey = () => `lpk_${randomBytes(24).toString("base64url")}`;
export const hashIngestKey = (key: string) => createHash("sha256").update(key).digest("hex");

export function ingestKeyMatches(key: string, hash: string | null) {
  if (!hash) return false;
  const left = Buffer.from(hashIngestKey(key), "hex");
  const right = Buffer.from(hash, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

// ---- datos del origen ------------------------------------------------------------

/**
 * Aplana cualquier JSON en pares clave/valor de texto: {contact: {mail: "a@b"}} → "contact.mail".
 * Los arreglos de textos se unen con comas; los de objetos usan el índice ("answers.0.value").
 */
export function flatten(input: unknown): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  const walk = (value: unknown, path: string, depth: number) => {
    if (out.length >= MAX_FIELDS || value === null || value === undefined) return;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const text = String(value).trim();
      if (path && text) out.push({ key: path.slice(0, 200), value: text.slice(0, MAX_VALUE) });
      return;
    }
    if (depth >= MAX_DEPTH || typeof value !== "object") return;
    if (Array.isArray(value)) {
      if (value.every((v) => typeof v === "string" || typeof v === "number")) {
        walk(value.join(", "), path, depth);
        return;
      }
      value.forEach((v, i) => walk(v, path ? `${path}.${i}` : String(i), depth + 1));
      return;
    }
    for (const [key, v] of Object.entries(value)) walk(v, path ? `${path}.${key}` : key, depth + 1);
  };
  walk(input, "", 0);
  return out;
}

const normalize = (key: string) =>
  key
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** Nombres habituales de cada campo (el último tramo de la clave, sin acentos ni signos). */
const GUESSES: Record<Exclude<LeadField, "externalId">, string[]> = {
  email: ["email", "mail", "correo", "correoelectronico", "emailaddress", "workemail"],
  phone: ["phone", "phonenumber", "telefono", "tel", "celular", "movil", "mobile", "whatsapp", "cel"],
  company: ["company", "companyname", "empresa", "organization", "organizacion", "business", "razonsocial", "negocio"],
  contactName: ["name", "fullname", "nombre", "nombrecompleto", "contact", "contacto", "contactname"],
  notes: ["message", "mensaje", "comments", "comentarios", "notes", "notas", "description", "descripcion", "consulta"]
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface MappedLead {
  company: string;
  contactName: string;
  email: string | null;
  phone: string | null;
  notes: string;
  externalId: string | null;
}

/**
 * Llena los campos del lead: primero el mapeo del source; lo que falte se adivina por el nombre de
 * la clave (y el nombre con first/last name). Nada se descarta: todo queda en `fields`.
 */
export function mapLead(fields: { key: string; value: string }[], mapping: LeadSourceDoc["mapping"]): MappedLead {
  const byKey = new Map(fields.map((f) => [f.key, f.value]));
  const found: Partial<Record<LeadField, string>> = {};
  for (const { from, to } of mapping) {
    const value = byKey.get(from);
    if (value && !found[to]) found[to] = value;
  }
  for (const [field, names] of Object.entries(GUESSES) as [Exclude<LeadField, "externalId">, string[]][]) {
    if (found[field]) continue;
    const hit = fields.find((f) => names.includes(normalize(f.key.split(".").pop() ?? "")) && (field !== "email" || EMAIL.test(f.value)));
    if (hit) found[field] = hit.value;
  }
  if (!found.contactName) {
    const part = (names: string[]) => fields.find((f) => names.includes(normalize(f.key.split(".").pop() ?? "")))?.value;
    const name = [part(["firstname", "nombres", "givenname"]), part(["lastname", "apellidos", "apellido", "surname"])].filter(Boolean).join(" ");
    if (name) found.contactName = name;
  }
  if (!found.email) found.email = fields.find((f) => EMAIL.test(f.value))?.value;
  const email = found.email && EMAIL.test(found.email) ? found.email.toLowerCase().slice(0, 200) : null;
  return {
    company: (found.company ?? "").slice(0, 120),
    contactName: (found.contactName ?? "").slice(0, 120),
    email,
    phone: found.phone ? found.phone.slice(0, 40) : null,
    notes: (found.notes ?? "").slice(0, 4000),
    externalId: found.externalId ? found.externalId.slice(0, 120) : null
  };
}

/** Nombre a mostrar cuando el origen no trae empresa. */
export const leadTitle = (lead: Pick<LeadDoc, "company" | "contactName" | "email">) => lead.company || lead.contactName || lead.email || "Lead sin nombre";

/** El cuerpo original en texto, recortado si es enorme. */
export function rawJsonOf(body: unknown) {
  const text = JSON.stringify(body ?? null);
  return text.length > MAX_RAW_JSON ? `${text.slice(0, MAX_RAW_JSON)}…` : text;
}
