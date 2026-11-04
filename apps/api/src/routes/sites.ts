import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth/session.js";
import type { SessionUser } from "../auth/users.js";
import { leadTitle, type ProposalDoc } from "../sales/models.js";
import type { RemoteSite, SitesClient } from "../sales/sites-client.js";
import type { AdminStore } from "../store/admin-store.js";
import { SALES_READ_ROLES, SALES_ROLES } from "./sales.js";

const siteId = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) });
const listQuery = z.object({ status: z.enum(["live", "archived", "deleted"]).default("live"), q: z.string().trim().max(100).optional() });
const linkQuery = z.object({ leadId: z.string().uuid().optional(), projectId: z.string().uuid().optional() });
const statsQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30), tz: z.string().max(64).default("UTC") });
const patchBody = z
  .object({
    name: z.string().trim().max(63).optional(),
    homepage: z.string().max(500).optional(),
    access: z.discriminatedUnion("mode", [z.object({ mode: z.literal("public") }), z.object({ mode: z.literal("password"), password: z.string().min(4).max(200).optional() })]).optional()
  })
  .strict();

/**
 * ¿La petición viene del panel? Los navegadores envían Sec-Fetch-Site (same-origin desde el panel);
 * si falta, se compara el Origin con el host. Sin ninguno de los dos no es un navegador (sin cookie
 * ajena que aprovechar).
 */
export function fromPanel(request: FastifyRequest) {
  const site = request.headers["sec-fetch-site"];
  if (site) return site === "same-origin" || site === "none";
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

/** El equipo no cuenta como visita: el token de la plataforma vale 30 días; se renueva cada día. */
const TEAM_TOKEN_MS = 24 * 3_600_000;

/**
 * Propuestas (sitios HTML) en WTProposalPlatform: esta API es el intermediario. Lo que se sube,
 * actualiza, personaliza o borra se reenvía a la plataforma con su llave de servidor; aquí queda la
 * propuesta (ProposalDoc) ligada al lead o al proyecto con el id del sitio. Leen quienes leen Leads
 * (boss, commercial, finance) y escriben Comercial y boss. Sin la plataforma configurada, 503.
 */
export async function registerSiteRoutes(app: FastifyInstance, { store, sites }: { store: AdminStore; sites?: SitesClient }) {
  const read = requireRole(...SALES_READ_ROLES);
  const write = requireRole(...SALES_ROLES);
  let team: { token: string; at: number } | null = null;

  const unavailable = (reply: FastifyReply) => reply.code(503).send({ error: "Propuestas no está conectada a WTProposalPlatform (PROPOSAL_SITES_URL y PROPOSAL_SITES_KEY_PATH)." });

  /** Devuelve la respuesta de la plataforma (JSON o error) con su mismo código. */
  async function relay(reply: FastifyReply, res: Response) {
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { error: "Respuesta inválida de WTProposalPlatform." };
    }
    if (res.status >= 500) {
      app.log.warn({ status: res.status }, "WTProposalPlatform failed");
      return reply.code(502).send({ error: "WTProposalPlatform no respondió bien. Inténtalo de nuevo." });
    }
    return reply.code(res.status === 204 ? 200 : res.status).send(res.status === 204 ? { ok: true } : body);
  }

  async function call(reply: FastifyReply, method: string, path: string, init?: Parameters<SitesClient["forward"]>[2]) {
    if (!sites) return { reply: unavailable(reply) };
    try {
      return { res: await sites.forward(method, path, init) };
    } catch (err) {
      app.log.warn({ err }, "WTProposalPlatform unreachable");
      return { reply: reply.code(502).send({ error: "No se pudo conectar con WTProposalPlatform." }) };
    }
  }

  const leadNote = (user: SessionUser, leadId: string, body: string) =>
    store.leadUpdates.insertOne({ _id: randomUUID(), leadId, kind: "system", body, authorUsername: user.username, authorName: user.name, createdAt: new Date() });

  /**
   * Lead y proyecto de cada sitio, para mostrarlos junto a la tarjeta: por el id del sitio o, en las
   * propuestas que se registraron antes solo con el enlace, por su URL.
   */
  async function linksOf(sitesList: Pick<RemoteSite, "id" | "url">[]) {
    const ids = sitesList.map((s) => s.id);
    const byUrl = new Map(sitesList.flatMap((s) => [[s.url, s.id], [`${s.url}/`, s.id]] as [string, string][]));
    const docs = ids.length ? await store.proposals.find({ $or: [{ siteId: { $in: ids } }, { siteId: { $exists: false }, url: { $in: [...byUrl.keys()] } }] }).toArray() : [];
    const leadIds = [...new Set(docs.map((d) => d.leadId).filter((v): v is string => Boolean(v)))];
    const projectIds = [...new Set(docs.map((d) => d.projectId).filter((v): v is string => Boolean(v)))];
    const [leads, projects] = await Promise.all([
      leadIds.length ? store.leads.find({ _id: { $in: leadIds } }).toArray() : [],
      projectIds.length ? store.opsProjects.find({ _id: { $in: projectIds } }, { projection: { name: 1 } }).toArray() : []
    ]);
    const leadName = new Map(leads.map((l) => [l._id, leadTitle(l)]));
    const projectName = new Map(projects.map((p) => [p._id, p.name]));
    return new Map(
      docs.map((d) => [
        d.siteId ?? byUrl.get(d.url)!,
        {
          proposalId: d._id,
          lead: d.leadId ? { id: d.leadId, name: leadName.get(d.leadId) ?? "—" } : null,
          project: d.projectId ? { id: d.projectId, name: projectName.get(d.projectId) ?? "—" } : null
        }
      ])
    );
  }

  const withLinks = async (items: RemoteSite[]) => {
    const links = await linksOf(items);
    return items.map((s) => ({ ...s, proposalId: null, lead: null, project: null, ...links.get(s.id) }));
  };

  app.get("/api/sites/config", { preHandler: read }, async (_request, reply) => {
    if (!sites) return { configured: false };
    const { res, reply: failed } = await call(reply, "GET", "/api/config");
    if (failed) return failed;
    if (!res!.ok) return relay(reply, res!);
    return { configured: true, ...((await res!.json()) as object) };
  });

  app.get("/api/sites", { preHandler: read }, async (request, reply) => {
    const query = listQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Filtro inválido." });
    const filter = linkQuery.safeParse(request.query);
    const qs = new URLSearchParams({ status: query.data.status, ...(query.data.q ? { q: query.data.q } : {}) });
    const { res, reply: failed } = await call(reply, "GET", `/api/projects?${qs}`);
    if (failed) return failed;
    if (!res!.ok) return relay(reply, res!);
    const data = (await res!.json()) as { items: RemoteSite[]; counts: Record<string, number> };
    let items = await withLinks(data.items);
    // Pestaña Propuestas del lead o del proyecto: solo los sitios ligados a él.
    if (filter.success && filter.data.leadId) items = items.filter((s) => s.lead?.id === filter.data.leadId);
    if (filter.success && filter.data.projectId) items = items.filter((s) => s.project?.id === filter.data.projectId);
    return { items, counts: data.counts, canWrite: (SALES_ROLES as readonly string[]).includes(request.user!.role) };
  });

  app.get("/api/sites/name-availability", { preHandler: write }, async (request, reply) => {
    const q = z.object({ name: z.string().max(100), exceptId: z.string().max(40).optional() }).safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: "Nombre inválido." });
    const { res, reply: failed } = await call(reply, "GET", `/api/projects/name-availability?${new URLSearchParams(q.data)}`);
    return failed ?? relay(reply, res!);
  });

  /** Enlace «Abrir el sitio» que marca este navegador como del equipo (no cuenta como visita). */
  // (La respuesta usa «mark»: la redacción de JSON borra cualquier campo llamado token.)
  app.get("/api/sites/team-mark", { preHandler: read }, async (_request, reply) => {
    if (team && Date.now() - team.at < TEAM_TOKEN_MS) return { mark: team.token };
    const { res, reply: failed } = await call(reply, "GET", "/api/auth/session");
    if (failed) return failed;
    if (!res!.ok) return relay(reply, res!);
    const { teamToken } = (await res!.json()) as { teamToken?: string };
    team = teamToken ? { token: teamToken, at: Date.now() } : null;
    return { mark: team?.token ?? null };
  });

  // Subidas: el cuerpo multipart pasa sin leerlo (lo valida la plataforma, con sus límites).
  await app.register(async (scope) => {
    // Un formulario HTML puede enviar multipart desde otra página sin preflight, y las propuestas
    // (*.sites.whatever.tech) son el mismo sitio que el panel: la cookie de sesión viajaría. Solo se
    // aceptan subidas hechas desde el propio panel.
    scope.addHook("onRequest", async (request, reply) => {
      if (!fromPanel(request)) return reply.code(403).send({ error: "Origen no permitido." });
    });
    scope.addContentTypeParser("multipart/form-data", (_request, _payload, done) => done(null));
    const stream = (request: FastifyRequest) => ({
      body: Readable.toWeb(request.raw) as ReadableStream,
      headers: { "content-type": String(request.headers["content-type"]), ...(request.headers["content-length"] ? { "content-length": String(request.headers["content-length"]) } : {}) }
    });

    scope.post("/api/sites", { preHandler: write }, async (request, reply) => {
      const link = linkQuery.safeParse(request.query);
      if (!link.success) return reply.code(400).send({ error: "Lead o proyecto inválido." });
      const lead = link.data.leadId ? await store.leads.findOne({ _id: link.data.leadId }) : null;
      if (link.data.leadId && !lead) return reply.code(404).send({ error: "Lead no encontrado." });
      const projectId = link.data.projectId ?? lead?.projectId ?? null;
      const { res, reply: failed } = await call(reply, "POST", "/api/projects", stream(request));
      if (failed) return failed;
      if (!res!.ok) return relay(reply, res!);
      const site = (await res!.json()) as RemoteSite;
      const user = request.user!;
      const now = new Date();
      const proposal: ProposalDoc = {
        _id: randomUUID(),
        leadId: lead?._id ?? null,
        projectId,
        dealId: null,
        title: site.name,
        url: site.url,
        amountCents: null,
        currency: "USD",
        status: "draft",
        area: "commercial",
        siteId: site.id,
        siteName: site.name,
        createdBy: user.username,
        createdAt: now,
        updatedAt: now
      };
      await store.proposals.insertOne(proposal);
      if (lead) await leadNote(user, lead._id, `Propuesta publicada: ${site.url}`);
      await store.audit({ actor: user.username, action: "sales.site_published", clientId: `sales:${lead?._id ?? site.id}`, target: site.name });
      return reply.code(201).send({ site: (await withLinks([site]))[0] });
    });

    scope.post("/api/sites/:id/files", { preHandler: write }, async (request, reply) => {
      const params = siteId.safeParse(request.params);
      if (!params.success) return reply.code(404).send({ error: "Propuesta no encontrada." });
      const { res, reply: failed } = await call(reply, "POST", `/api/projects/${params.data.id}/files`, stream(request));
      if (failed) return failed;
      if (res!.ok) await store.proposals.updateMany({ siteId: params.data.id }, { $set: { updatedAt: new Date() } });
      return relay(reply, res!);
    });
  });

  app.patch("/api/sites/:id", { preHandler: write }, async (request, reply) => {
    const params = siteId.safeParse(request.params);
    const body = patchBody.safeParse(request.body);
    if (!params.success) return reply.code(404).send({ error: "Propuesta no encontrada." });
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? "Datos inválidos." });
    const { res, reply: failed } = await call(reply, "PATCH", `/api/projects/${params.data.id}`, { body: JSON.stringify(body.data), headers: { "content-type": "application/json" } });
    if (failed) return failed;
    if (!res!.ok) return relay(reply, res!);
    const site = (await res!.json()) as RemoteSite;
    // Renombrar cambia el subdominio: el enlace de la propuesta se actualiza.
    await store.proposals.updateMany({ siteId: site.id }, { $set: { siteName: site.name, url: site.url, title: site.name, updatedAt: new Date() } });
    await store.audit({ actor: request.user!.username, action: "sales.site_updated", clientId: `sales:${site.id}`, target: site.name, details: { fields: Object.keys(body.data).join(",") } });
    return { site: (await withLinks([site]))[0] };
  });

  app.post("/api/sites/:id/status", { preHandler: write }, async (request, reply) => {
    const params = siteId.safeParse(request.params);
    const body = z.object({ status: z.enum(["live", "archived", "deleted"]) }).safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Estado inválido." });
    const { res, reply: failed } = await call(reply, "POST", `/api/projects/${params.data.id}/status`, { body: JSON.stringify(body.data), headers: { "content-type": "application/json" } });
    if (failed) return failed;
    if (!res!.ok) return relay(reply, res!);
    const site = (await res!.json()) as RemoteSite;
    await store.audit({ actor: request.user!.username, action: `sales.site_${body.data.status}`, clientId: `sales:${site.id}`, target: site.name });
    return { site: (await withLinks([site]))[0] };
  });

  // Borrado definitivo (solo desde la papelera, lo exige la plataforma): también la propuesta de aquí.
  app.delete("/api/sites/:id", { preHandler: write }, async (request, reply) => {
    const params = siteId.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: "Propuesta no encontrada." });
    const { res, reply: failed } = await call(reply, "DELETE", `/api/projects/${params.data.id}`);
    if (failed) return failed;
    if (!res!.ok) return relay(reply, res!);
    const removed = await store.proposals.find({ siteId: params.data.id }).toArray();
    await store.proposals.deleteMany({ siteId: params.data.id });
    await store.audit({ actor: request.user!.username, action: "sales.site_deleted", clientId: `sales:${params.data.id}`, target: removed[0]?.siteName ?? params.data.id });
    return { ok: true };
  });

  app.get("/api/sites/:id/stats", { preHandler: read }, async (request, reply) => {
    const params = siteId.safeParse(request.params);
    const query = statsQuery.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Consulta inválida." });
    const { res, reply: failed } = await call(reply, "GET", `/api/projects/${params.data.id}/stats?${new URLSearchParams({ days: String(query.data.days), tz: query.data.tz })}`);
    return failed ?? relay(reply, res!);
  });

  app.get("/api/sites/:id/download", { preHandler: read }, async (request, reply) => {
    const params = siteId.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: "Propuesta no encontrada." });
    const { res, reply: failed } = await call(reply, "GET", `/api/projects/${params.data.id}/download`);
    if (failed) return failed;
    if (!res!.ok || !res!.body) return relay(reply, res!);
    reply.header("content-type", "application/zip");
    reply.header("content-disposition", res!.headers.get("content-disposition") ?? "attachment");
    return reply.send(Readable.fromWeb(res!.body as import("node:stream/web").ReadableStream));
  });
}
