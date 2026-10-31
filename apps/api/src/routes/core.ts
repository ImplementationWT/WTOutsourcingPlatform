import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import type { SessionUser } from "../auth/users.js";
import { canReadContacts, canWriteContacts } from "../core/access.js";
import type { ContactDoc } from "../core/models.js";
import { runTableQuery, tableQuerySchema } from "../lib/table-query.js";
import type { AdminStore } from "../store/admin-store.js";

const idParams = z.object({ id: z.string().uuid() });
const text = (max: number) => z.string().trim().max(max);
const nullableText = (max: number) => text(max).nullable().transform((v) => (v ? v : null));
const url = z
  .string()
  .trim()
  .max(500)
  .refine((v) => /^https?:\/\//i.test(v), "Debe empezar por http:// o https://")
  .nullable();

const contactFields = {
  name: text(120).min(2),
  emails: z.array(z.string().trim().toLowerCase().email().max(200)).max(10),
  phone: nullableText(40),
  title: nullableText(120),
  company: nullableText(120),
  linkedinUrl: url
};
const createContactSchema = z.object(contactFields).partial().required({ name: true }).strict();
const updateContactSchema = z
  .object(contactFields)
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, "No hay nada que cambiar.");

const contactsQuery = tableQuerySchema;

const invalid = (reply: FastifyReply, error: z.ZodError) =>
  reply.code(400).send({ error: "Datos inválidos.", issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
const forbidden = (reply: FastifyReply) => reply.code(403).send({ error: "No tienes permiso para esta acción." });

export const contactView = (c: ContactDoc) => ({
  id: c._id,
  name: c.name,
  emails: c.emails,
  phone: c.phone,
  title: c.title,
  company: c.company ?? null,
  linkedinUrl: c.linkedinUrl,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt
});

/** Contactos (núcleo compartido, docs/rework-plataforma.md §4.1). */
export async function registerCoreRoutes(app: FastifyInstance, { store }: { store: AdminStore }) {
  const audit = (user: SessionUser, id: string, name: string, action: string) => store.audit({ actor: user.username, action: `core.contact_${action}`, clientId: `core:${id}`, target: name });

  /** Lectura (CEO/CCO, Comercial, Financiera) o escritura (CEO/CCO, Comercial). */
  const gate = (user: SessionUser, reply: FastifyReply, write: boolean) => {
    if (write ? canWriteContacts(user) : canReadContacts(user)) return true;
    void forbidden(reply);
    return false;
  };

  app.get("/api/contacts", { preHandler: requireAuth }, async (request, reply) => {
    if (!gate(request.user!, reply, false)) return reply;
    const query = contactsQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, query.error);
    const result = await runTableQuery(store.contacts, {
      match: {},
      query: query.data,
      sortable: { name: "name", title: "title", company: "company", updatedAt: "updatedAt" },
      defaultSort: { key: "name", dir: "asc" },
      search: ["name", "emails", "phone", "title", "company"]
    });
    return { ...result, rows: result.rows.map(contactView) };
  });

  app.post("/api/contacts", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user!;
    if (!gate(user, reply, true)) return reply;
    const body = createContactSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const at = new Date();
    const contact: ContactDoc = {
      _id: randomUUID(),
      name: body.data.name,
      emails: [...new Set(body.data.emails ?? [])],
      phone: body.data.phone ?? null,
      title: body.data.title ?? null,
      company: body.data.company ?? null,
      linkedinUrl: body.data.linkedinUrl ?? null,
      createdBy: user.username,
      createdAt: at,
      updatedAt: at
    };
    await store.contacts.insertOne(contact);
    await audit(user, contact._id, contact.name, "created");
    return reply.code(201).send({ contact: contactView(contact) });
  });

  /** Detalle con sus relaciones: leads, deals y proyectos. */
  app.get("/api/contacts/:id", { preHandler: requireAuth }, async (request, reply) => {
    if (!gate(request.user!, reply, false)) return reply;
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const contact = await store.contacts.findOne({ _id: params.data.id });
    if (!contact) return reply.code(404).send({ error: "Contacto no encontrado." });
    const [deals, projects, leads] = await Promise.all([
      store.deals.find({ contactIds: contact._id }, { projection: { dealCode: 1, title: 1, status: 1 } }).sort({ createdAt: -1 }).limit(200).toArray(),
      store.opsProjects.find({ contactIds: contact._id }, { projection: { name: 1, stage: 1 } }).sort({ updatedAt: -1 }).limit(200).toArray(),
      store.leads
        .find({ $or: [{ contactId: contact._id }, ...(contact.emails.length ? [{ email: { $in: contact.emails } }] : [])] }, { projection: { company: 1, contactName: 1, email: 1, status: 1 } })
        .sort({ updatedAt: -1 })
        .limit(200)
        .toArray()
    ]);
    return {
      contact: contactView(contact),
      deals: deals.map((d) => ({ id: d._id, dealCode: d.dealCode, title: d.title, status: d.status })),
      projects: projects.map((p) => ({ id: p._id, name: p.name, stage: p.stage })),
      leads: leads.map((l) => ({ id: l._id, title: l.company || l.contactName || l.email || "Lead", status: l.status }))
    };
  });

  app.patch("/api/contacts/:id", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user!;
    if (!gate(user, reply, true)) return reply;
    const params = idParams.safeParse(request.params);
    const body = updateContactSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const set = { ...body.data, ...(body.data.emails ? { emails: [...new Set(body.data.emails)] } : {}), updatedAt: new Date() };
    const contact = await store.contacts.findOneAndUpdate({ _id: params.data.id }, { $set: set }, { returnDocument: "after" });
    if (!contact) return reply.code(404).send({ error: "Contacto no encontrado." });
    await audit(user, contact._id, contact.name, "updated");
    return { contact: contactView(contact) };
  });
}
