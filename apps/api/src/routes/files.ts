import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Binary } from "mongodb";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import type { SessionUser } from "../auth/users.js";
import { canEditDeal, canReadDeal } from "../core/access.js";
import { canManageProject, forbidden, readableProject } from "../ops/access.js";
import type { AdminStore } from "../store/admin-store.js";

/** Archivo subido desde la computadora: el documento de la propuesta de un deal o el SOW de un proyecto. */
export interface FileDoc {
  _id: string;
  /** «deal:<id>:proposal» o «project:<id>:sow»: un archivo vigente por dueño. */
  owner: string;
  name: string;
  type: string;
  size: number;
  data: Binary;
  createdBy: string;
  createdAt: Date;
}

/** Lo que se guarda en el deal o el proyecto para mostrar el archivo. */
export interface FileRef {
  fileId: string;
  name: string;
  size: number;
  uploadedAt: Date;
}

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
const params = z.object({ id: z.string().uuid() });

/**
 * Documento de la propuesta (deal) y SOW (proyecto) subidos como archivo. El cuerpo es el archivo
 * tal cual (hasta 15 MB) con su tipo en Content-Type y el nombre en X-File-Name; se guarda en
 * MongoDB y se descarga desde la misma ruta. Sube y borra quien edita el deal o gestiona el proyecto.
 */
export async function registerFileRoutes(app: FastifyInstance, { store }: { store: AdminStore }) {
  // Índice único por dueño: en AdminStore.init.
  const files = store.db.collection<FileDoc>("core_files");

  const fileName = (request: FastifyRequest) => {
    const raw = String(request.headers["x-file-name"] ?? "archivo");
    let name = raw;
    try {
      name = decodeURIComponent(raw);
    } catch {
      // Sin codificar: se usa tal cual.
    }
    return name.replace(/[\\/\0\r\n"]/g, "_").slice(0, 200) || "archivo";
  };

  async function save(request: FastifyRequest, reply: FastifyReply, owner: string) {
    const body = request.body;
    if (!Buffer.isBuffer(body) || !body.length) return reply.code(400).send({ error: "Elige un archivo." });
    const user = request.user!;
    const doc: FileDoc = { _id: randomUUID(), owner, name: fileName(request), type: String(request.headers["content-type"] ?? "application/octet-stream").split(";")[0].slice(0, 100), size: body.length, data: new Binary(body), createdBy: user.username, createdAt: new Date() };
    await files.replaceOne({ owner }, doc, { upsert: true });
    return { fileId: doc._id, name: doc.name, size: doc.size, uploadedAt: doc.createdAt } satisfies FileRef;
  }

  async function send(reply: FastifyReply, owner: string) {
    const file = await files.findOne({ owner });
    if (!file) return reply.code(404).send({ error: "No hay archivo." });
    reply.header("content-type", file.type || "application/octet-stream");
    reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    reply.header("cache-control", "private, no-store");
    return reply.send(Buffer.from(file.data.buffer));
  }

  const deal = async (user: SessionUser, id: string, write: boolean) => {
    const found = await store.deals.findOne({ _id: id });
    if (!found || !canReadDeal(user, found)) return { status: 404 as const };
    if (write && !canEditDeal(user, found)) return { status: 403 as const };
    return { deal: found };
  };

  // Las subidas leen el cuerpo como bytes, sea cual sea su tipo (PDF, Word, imagen…).
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: MAX_FILE_BYTES }, (_request, body, done) => done(null, body));

    scope.put("/api/deals/:id/proposal-doc", { preHandler: requireAuth, bodyLimit: MAX_FILE_BYTES }, async (request, reply) => {
      const p = params.safeParse(request.params);
      if (!p.success) return reply.code(400).send({ error: "Id inválido." });
      const found = await deal(request.user!, p.data.id, true);
      if (found.status === 404) return reply.code(404).send({ error: "Deal no encontrado." });
      if (found.status === 403) return forbidden(reply);
      const ref = await save(request, reply, `deal:${p.data.id}:proposal`);
      if (!("fileId" in ref)) return ref;
      await store.deals.updateOne({ _id: p.data.id }, { $set: { proposalDoc: ref, updatedAt: new Date() } });
      await store.audit({ actor: request.user!.username, action: "core.deal_proposal_uploaded", clientId: `core:deal:${p.data.id}`, target: ref.name });
      return { file: ref };
    });

    scope.put("/api/ops/projects/:id/sow", { preHandler: requireAuth, bodyLimit: MAX_FILE_BYTES }, async (request, reply) => {
      const p = params.safeParse(request.params);
      if (!p.success) return reply.code(400).send({ error: "Id inválido." });
      const project = await readableProject(store, request, reply, p.data.id);
      if (!project) return reply;
      if (!canManageProject(request.user!, project)) return forbidden(reply);
      const ref = await save(request, reply, `project:${p.data.id}:sow`);
      if (!("fileId" in ref)) return ref;
      await store.opsProjects.updateOne({ _id: project._id }, { $set: { sowDoc: ref, updatedAt: new Date() } });
      await store.audit({ actor: request.user!.username, action: "ops.sow_uploaded", clientId: `ops:${project._id}`, target: ref.name });
      return { file: ref };
    });
  });

  app.get("/api/deals/:id/proposal-doc", { preHandler: requireAuth }, async (request, reply) => {
    const p = params.safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: "Id inválido." });
    if ((await deal(request.user!, p.data.id, false)).status === 404) return reply.code(404).send({ error: "Deal no encontrado." });
    return send(reply, `deal:${p.data.id}:proposal`);
  });

  app.delete("/api/deals/:id/proposal-doc", { preHandler: requireAuth }, async (request, reply) => {
    const p = params.safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: "Id inválido." });
    const found = await deal(request.user!, p.data.id, true);
    if (found.status === 404) return reply.code(404).send({ error: "Deal no encontrado." });
    if (found.status === 403) return forbidden(reply);
    await files.deleteOne({ owner: `deal:${p.data.id}:proposal` });
    await store.deals.updateOne({ _id: p.data.id }, { $unset: { proposalDoc: "" }, $set: { updatedAt: new Date() } });
    return { ok: true };
  });

  app.get("/api/ops/projects/:id/sow", { preHandler: requireAuth }, async (request, reply) => {
    const p = params.safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: "Id inválido." });
    if (!(await readableProject(store, request, reply, p.data.id))) return reply;
    return send(reply, `project:${p.data.id}:sow`);
  });

  app.delete("/api/ops/projects/:id/sow", { preHandler: requireAuth }, async (request, reply) => {
    const p = params.safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: "Id inválido." });
    const project = await readableProject(store, request, reply, p.data.id);
    if (!project) return reply;
    if (!canManageProject(request.user!, project)) return forbidden(reply);
    await files.deleteOne({ owner: `project:${p.data.id}:sow` });
    await store.opsProjects.updateOne({ _id: project._id }, { $unset: { sowDoc: "" }, $set: { updatedAt: new Date() } });
    return { ok: true };
  });
}
