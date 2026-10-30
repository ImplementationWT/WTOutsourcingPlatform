import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import type { SessionUser } from "../auth/users.js";
import { canReadContacts, canWriteContacts } from "../core/access.js";
import { COMPANY_SIZES, type CompanyDoc, type ContactDoc } from "../core/models.js";
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

const companyFields = {
  name: text(120).min(2),
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .max(120)
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Dominio inválido (p. ej. empresa.com).")
    .nullable(),
  industry: nullableText(80),
  size: z.enum(COMPANY_SIZES).nullable(),
  location: nullableText(120)
};
const createCompanySchema = z
  .object({ name: companyFields.name, domain: companyFields.domain.optional(), industry: companyFields.industry.optional(), size: companyFields.size.optional(), location: companyFields.location.optional() })
  .strict();
const updateCompanySchema = z
  .object(companyFields)
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, "No hay nada que cambiar.");

const contactFields = {
  name: text(120).min(2),
  emails: z.array(z.string().trim().toLowerCase().email().max(200)).max(10),
  phone: nullableText(40),
  title: nullableText(120),
  linkedinUrl: url,
  companyId: z.string().uuid().nullable()
};
const createContactSchema = z
  .object({
    name: contactFields.name,
    emails: contactFields.emails.optional(),
    phone: contactFields.phone.optional(),
    title: contactFields.title.optional(),
    linkedinUrl: contactFields.linkedinUrl.optional(),
    companyId: contactFields.companyId.optional()
  })
  .strict();
const updateContactSchema = z
  .object(contactFields)
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, "No hay nada que cambiar.");

const companiesQuery = tableQuerySchema.extend({ industry: text(80).optional(), size: z.enum(COMPANY_SIZES).optional() });
const contactsQuery = tableQuerySchema.extend({ companyId: z.string().uuid().optional() });

const invalid = (reply: FastifyReply, error: z.ZodError) =>
  reply.code(400).send({ error: "Datos inválidos.", issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
const forbidden = (reply: FastifyReply) => reply.code(403).send({ error: "No tienes permiso para esta acción." });

export const companyView = (c: CompanyDoc) => ({
  id: c._id,
  name: c.name,
  domain: c.domain,
  industry: c.industry,
  size: c.size,
  location: c.location,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt
});

export const contactView = (c: ContactDoc, company?: { id: string; name: string } | null) => ({
  id: c._id,
  name: c.name,
  emails: c.emails,
  phone: c.phone,
  title: c.title,
  linkedinUrl: c.linkedinUrl,
  company: company ?? null,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt
});

/** Empresas y Contactos (núcleo compartido, docs/rework-plataforma.md §4.1). */
export async function registerCoreRoutes(app: FastifyInstance, { store }: { store: AdminStore }) {
  const audit = (user: SessionUser, kind: "company" | "contact", id: string, name: string, action: string) =>
    store.audit({ actor: user.username, action: `core.${kind}_${action}`, clientId: `core:${id}`, target: name });

  /** Lectura (CEO/CCO, Comercial, Financiera) o escritura (CEO/CCO, Comercial). */
  const gate = (user: SessionUser, reply: FastifyReply, write: boolean) => {
    if (write ? canWriteContacts(user) : canReadContacts(user)) return true;
    void forbidden(reply);
    return false;
  };

  async function companyNames(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((v): v is string => Boolean(v)))];
    const rows = unique.length ? await store.companies.find({ _id: { $in: unique } }, { projection: { name: 1 } }).toArray() : [];
    return new Map(rows.map((r) => [r._id, { id: r._id, name: r.name }]));
  }

  // ---- empresas ---------------------------------------------------------------

  app.get("/api/companies", { preHandler: requireAuth }, async (request, reply) => {
    if (!gate(request.user!, reply, false)) return reply;
    const query = companiesQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, query.error);
    const { industry, size } = query.data;
    const result = await runTableQuery(store.companies, {
      match: { ...(industry ? { industry } : {}), ...(size ? { size } : {}) },
      query: query.data,
      sortable: { name: "name", industry: "industry", size: { field: "size", order: COMPANY_SIZES }, location: "location", updatedAt: "updatedAt" },
      defaultSort: { key: "name", dir: "asc" },
      search: ["name", "domain", "industry", "location"]
    });
    const ids = result.rows.map((c) => c._id);
    const [contacts, projects] = ids.length
      ? await Promise.all([
          store.contacts.aggregate<{ _id: string; n: number }>([{ $match: { companyId: { $in: ids } } }, { $group: { _id: "$companyId", n: { $sum: 1 } } }]).toArray(),
          store.opsProjects.aggregate<{ _id: string; n: number }>([{ $match: { companyId: { $in: ids } } }, { $group: { _id: "$companyId", n: { $sum: 1 } } }]).toArray()
        ])
      : [[], []];
    const contactCount = new Map(contacts.map((c) => [c._id, c.n]));
    const projectCount = new Map(projects.map((p) => [p._id, p.n]));
    return { ...result, rows: result.rows.map((c) => ({ ...companyView(c), contacts: contactCount.get(c._id) ?? 0, projects: projectCount.get(c._id) ?? 0 })) };
  });

  app.post("/api/companies", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user!;
    if (!gate(user, reply, true)) return reply;
    const body = createCompanySchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const at = new Date();
    const company: CompanyDoc = {
      _id: randomUUID(),
      name: body.data.name,
      domain: body.data.domain ?? null,
      industry: body.data.industry ?? null,
      size: body.data.size ?? null,
      location: body.data.location ?? null,
      createdBy: user.username,
      createdAt: at,
      updatedAt: at
    };
    await store.companies.insertOne(company);
    await audit(user, "company", company._id, company.name, "created");
    return reply.code(201).send({ company: companyView(company) });
  });

  app.get("/api/companies/:id", { preHandler: requireAuth }, async (request, reply) => {
    if (!gate(request.user!, reply, false)) return reply;
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const company = await store.companies.findOne({ _id: params.data.id });
    if (!company) return reply.code(404).send({ error: "Empresa no encontrada." });
    const [contacts, projects] = await Promise.all([
      store.contacts.find({ companyId: company._id }).sort({ name: 1 }).limit(500).toArray(),
      store.opsProjects.find({ companyId: company._id }, { projection: { name: 1, stage: 1, health: 1 } }).sort({ updatedAt: -1 }).limit(200).toArray()
    ]);
    return {
      company: companyView(company),
      contacts: contacts.map((c) => contactView(c)),
      projects: projects.map((p) => ({ id: p._id, name: p.name, stage: p.stage, health: p.health }))
    };
  });

  app.patch("/api/companies/:id", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user!;
    if (!gate(user, reply, true)) return reply;
    const params = idParams.safeParse(request.params);
    const body = updateCompanySchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    if (!body.success) return invalid(reply, body.error);
    const company = await store.companies.findOneAndUpdate({ _id: params.data.id }, { $set: { ...body.data, updatedAt: new Date() } }, { returnDocument: "after" });
    if (!company) return reply.code(404).send({ error: "Empresa no encontrada." });
    // El proyecto repite el nombre del cliente para mostrarlo sin consultar la empresa.
    if (body.data.name) await store.opsProjects.updateMany({ companyId: company._id }, { $set: { customerName: company.name } });
    await audit(user, "company", company._id, company.name, "updated");
    return { company: companyView(company) };
  });

  // ---- contactos --------------------------------------------------------------

  app.get("/api/contacts", { preHandler: requireAuth }, async (request, reply) => {
    if (!gate(request.user!, reply, false)) return reply;
    const query = contactsQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, query.error);
    const result = await runTableQuery(store.contacts, {
      match: query.data.companyId ? { companyId: query.data.companyId } : {},
      query: query.data,
      sortable: { name: "name", title: "title", updatedAt: "updatedAt" },
      defaultSort: { key: "name", dir: "asc" },
      search: ["name", "emails", "phone", "title"]
    });
    const companies = await companyNames(result.rows.map((c) => c.companyId));
    return { ...result, rows: result.rows.map((c) => contactView(c, c.companyId ? companies.get(c.companyId) : null)) };
  });

  async function checkCompany(companyId: string | null | undefined, reply: FastifyReply) {
    if (!companyId || (await store.companies.findOne({ _id: companyId }, { projection: { _id: 1 } }))) return true;
    void reply.code(400).send({ error: "La empresa no existe." });
    return false;
  }

  app.post("/api/contacts", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user!;
    if (!gate(user, reply, true)) return reply;
    const body = createContactSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    if (!(await checkCompany(body.data.companyId, reply))) return reply;
    const at = new Date();
    const contact: ContactDoc = {
      _id: randomUUID(),
      name: body.data.name,
      emails: [...new Set(body.data.emails ?? [])],
      phone: body.data.phone ?? null,
      title: body.data.title ?? null,
      linkedinUrl: body.data.linkedinUrl ?? null,
      companyId: body.data.companyId ?? null,
      createdBy: user.username,
      createdAt: at,
      updatedAt: at
    };
    await store.contacts.insertOne(contact);
    await audit(user, "contact", contact._id, contact.name, "created");
    const companies = await companyNames([contact.companyId]);
    return reply.code(201).send({ contact: contactView(contact, contact.companyId ? companies.get(contact.companyId) : null) });
  });

  /** Detalle con sus relaciones en ambos sentidos: empresa, leads, deals y proyectos. */
  app.get("/api/contacts/:id", { preHandler: requireAuth }, async (request, reply) => {
    if (!gate(request.user!, reply, false)) return reply;
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const contact = await store.contacts.findOne({ _id: params.data.id });
    if (!contact) return reply.code(404).send({ error: "Contacto no encontrado." });
    const [companies, deals, projects, leads] = await Promise.all([
      companyNames([contact.companyId]),
      store.deals.find({ contactIds: contact._id }, { projection: { dealCode: 1, title: 1, status: 1 } }).sort({ createdAt: -1 }).limit(200).toArray(),
      store.opsProjects.find({ contactIds: contact._id }, { projection: { name: 1, stage: 1 } }).sort({ updatedAt: -1 }).limit(200).toArray(),
      store.leads
        .find({ $or: [{ contactId: contact._id }, ...(contact.emails.length ? [{ email: { $in: contact.emails } }] : [])] }, { projection: { company: 1, contactName: 1, email: 1, status: 1 } })
        .sort({ updatedAt: -1 })
        .limit(200)
        .toArray()
    ]);
    return {
      contact: contactView(contact, contact.companyId ? companies.get(contact.companyId) : null),
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
    if (!(await checkCompany(body.data.companyId, reply))) return reply;
    const set = { ...body.data, ...(body.data.emails ? { emails: [...new Set(body.data.emails)] } : {}), updatedAt: new Date() };
    const contact = await store.contacts.findOneAndUpdate({ _id: params.data.id }, { $set: set }, { returnDocument: "after" });
    if (!contact) return reply.code(404).send({ error: "Contacto no encontrado." });
    await audit(user, "contact", contact._id, contact.name, "updated");
    const companies = await companyNames([contact.companyId]);
    return { contact: contactView(contact, contact.companyId ? companies.get(contact.companyId) : null) };
  });
}
