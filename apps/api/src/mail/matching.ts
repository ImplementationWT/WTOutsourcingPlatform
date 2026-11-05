import type { CommunicationDoc } from "../routes/communications.js";
import { ACTIVE_LEAD_STATUSES } from "../sales/models.js";
import type { AdminStore } from "../store/admin-store.js";
import { domainOf, PUBLIC_DOMAINS } from "./message.js";

export type MatchedBy = "contact" | "lead" | "thread" | "domain" | "manual";

export interface CustomerMatch {
  projectId: string | null;
  leadId: string | null;
  contactId: string | null;
  /** Nombre de la persona del cliente (el del contacto, si se encontró). */
  contactName: string | null;
  matchedBy: MatchedBy;
}

/** Comparación sin distinguir mayúsculas (los correos de contactos y leads se escriben a mano). */
const CI = { locale: "en", strength: 2 } as const;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Candidate = { kind: "project" | "lead"; id: string; active: boolean; updatedAt: Date };

/** Elige uno: primero proyectos activos, luego leads activos, luego el resto; el más reciente gana. */
function pick(candidates: Candidate[]) {
  const rank = (c: Candidate) => (c.kind === "project" ? (c.active ? 0 : 2) : c.active ? 1 : 3);
  return [...candidates].sort((a, b) => rank(a) - rank(b) || b.updatedAt.getTime() - a.updatedAt.getTime())[0];
}

/**
 * ¿De qué cliente es este correo? Reglas (scope §11), de más a menos segura:
 *   1. Correo exacto de un contacto (o del lead) en From, To o Cc → su proyecto o su lead.
 *   2. Hilo ya asociado (otro mensaje del mismo hilo en el buzón de la misma persona).
 *   3. Dominio del contacto/lead como señal secundaria: solo si apunta a UN único cliente y no es
 *      un correo gratuito (gmail.com, outlook.com…).
 * Sin coincidencia → null: el correo no se guarda (los personales nunca entran a la app).
 */
export async function matchCustomer(store: AdminStore, comms: { findOne: (f: object) => Promise<CommunicationDoc | null> }, input: { ownerUserId: string; threadId: string; external: string[] }): Promise<CustomerMatch | null> {
  const { external } = input;
  if (!external.length) return null;

  // 1. Correo exacto.
  const contacts = await store.contacts.find({ emails: { $in: external } }, { collation: CI, projection: { name: 1 } }).toArray();
  const contactIds = contacts.map((c) => c._id);
  const [projects, leads] = await Promise.all([
    contactIds.length ? store.opsProjects.find({ contactIds: { $in: contactIds } }, { projection: { stage: 1, updatedAt: 1, contactIds: 1 } }).toArray() : [],
    store.leads
      .find({ $or: [{ email: { $in: external } }, { corporateEmail: { $in: external } }, ...(contactIds.length ? [{ contactId: { $in: contactIds } }] : [])] }, { collation: CI, projection: { status: 1, updatedAt: 1, projectId: 1, contactId: 1, contactName: 1 } })
      .toArray()
  ]);
  const exact: Candidate[] = [
    ...projects.map((p) => ({ kind: "project" as const, id: p._id, active: p.stage !== "completed", updatedAt: p.updatedAt })),
    // Un lead ganado ya tiene proyecto: cuenta como ese proyecto.
    ...leads.map((l) => (l.projectId ? { kind: "project" as const, id: l.projectId, active: true, updatedAt: l.updatedAt } : { kind: "lead" as const, id: l._id, active: (ACTIVE_LEAD_STATUSES as readonly string[]).includes(l.status), updatedAt: l.updatedAt }))
  ];
  if (exact.length) {
    // Si el hilo ya está en uno de los candidatos, se respeta (conversación coherente).
    const thread = await comms.findOne({ ownerUserId: input.ownerUserId, providerThreadId: input.threadId, deletedAt: null });
    const sameThread = thread && exact.find((c) => (c.kind === "project" ? c.id === thread.projectId : c.id === thread.leadId));
    const chosen = sameThread || pick(exact);
    const project = chosen.kind === "project" ? projects.find((p) => p._id === chosen.id) : null;
    const lead = chosen.kind === "lead" ? leads.find((l) => l._id === chosen.id) : null;
    const contact = contacts.find((c) => project?.contactIds?.includes(c._id) || lead?.contactId === c._id) ?? contacts[0] ?? null;
    return {
      projectId: chosen.kind === "project" ? chosen.id : null,
      leadId: chosen.kind === "lead" ? chosen.id : null,
      contactId: contact?._id ?? null,
      contactName: contact?.name ?? lead?.contactName ?? null,
      matchedBy: contacts.length ? "contact" : "lead"
    };
  }

  // 2. Hilo ya asociado.
  const thread = await comms.findOne({ ownerUserId: input.ownerUserId, providerThreadId: input.threadId, deletedAt: null });
  if (thread && (thread.projectId || thread.leadId)) {
    return { projectId: thread.projectId, leadId: thread.leadId, contactId: thread.contactId ?? null, contactName: thread.contactName || null, matchedBy: "thread" };
  }

  // 3. Dominio (solo si es inequívoco).
  const domains = [...new Set(external.map(domainOf))].filter((d) => !PUBLIC_DOMAINS.has(d));
  if (!domains.length) return null;
  const byDomain = new RegExp(`@(${domains.map(escape).join("|")})$`, "i");
  const [dContacts, dLeads] = await Promise.all([
    store.contacts.find({ emails: byDomain }, { projection: { _id: 1 } }).limit(50).toArray(),
    store.leads.find({ $or: [{ email: byDomain }, { corporateEmail: byDomain }] }, { projection: { status: 1, updatedAt: 1, projectId: 1 } }).limit(50).toArray()
  ]);
  const dProjects = dContacts.length ? await store.opsProjects.find({ contactIds: { $in: dContacts.map((c) => c._id) } }, { projection: { _id: 1 } }).limit(50).toArray() : [];
  const targets = new Set([...dProjects.map((p) => `project:${p._id}`), ...dLeads.map((l) => (l.projectId ? `project:${l.projectId}` : `lead:${l._id}`))]);
  if (targets.size !== 1) return null;
  const [kind, id] = [...targets][0].split(":") as ["project" | "lead", string];
  return { projectId: kind === "project" ? id : null, leadId: kind === "lead" ? id : null, contactId: null, contactName: null, matchedBy: "domain" };
}
