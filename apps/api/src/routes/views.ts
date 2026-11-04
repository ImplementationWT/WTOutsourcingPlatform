import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import type { AdminStore } from "../store/admin-store.js";

/** Pantallas con vistas guardadas. */
export const VIEW_SCREENS = ["projects"] as const;

/** Vista guardada de una tabla: el estado de la URL (filtros, orden, agrupación) con un nombre. */
export interface SavedViewDoc {
  _id: string;
  userId: string;
  screen: (typeof VIEW_SCREENS)[number];
  name: string;
  /** Query string de la tabla, sin la página. */
  query: string;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

const name = z.string().trim().min(1).max(40);
const query = z.string().max(1000);
const idParams = z.object({ id: z.string().uuid() });

/** Vistas guardadas por usuario: cada persona ve y edita solo las suyas. */
export async function registerViewRoutes(app: FastifyInstance, { store }: { store: AdminStore }) {
  const views = store.db.collection<SavedViewDoc>("ui_views");
  await views.createIndex({ userId: 1, screen: 1, position: 1 });
  const view = (v: SavedViewDoc) => ({ id: v._id, name: v.name, query: v.query });

  app.get("/api/views", { preHandler: requireAuth }, async (request, reply) => {
    const q = z.object({ screen: z.enum(VIEW_SCREENS) }).safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: "Pantalla inválida." });
    const rows = await views.find({ userId: request.user!.id, screen: q.data.screen }).sort({ position: 1, createdAt: 1 }).toArray();
    return { views: rows.map(view) };
  });

  app.post("/api/views", { preHandler: requireAuth }, async (request, reply) => {
    const body = z.object({ screen: z.enum(VIEW_SCREENS), name, query }).strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Datos inválidos." });
    const userId = request.user!.id;
    const count = await views.countDocuments({ userId, screen: body.data.screen });
    if (count >= 20) return reply.code(400).send({ error: "Máximo 20 vistas por pantalla." });
    const at = new Date();
    const doc: SavedViewDoc = { _id: randomUUID(), userId, screen: body.data.screen, name: body.data.name, query: body.data.query, position: count, createdAt: at, updatedAt: at };
    await views.insertOne(doc);
    return reply.code(201).send({ view: view(doc) });
  });

  app.patch("/api/views/:id", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = z.object({ name, query }).partial().strict().refine((p) => Object.keys(p).length > 0).safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Datos inválidos." });
    const updated = await views.findOneAndUpdate({ _id: params.data.id, userId: request.user!.id }, { $set: { ...body.data, updatedAt: new Date() } }, { returnDocument: "after" });
    if (!updated) return reply.code(404).send({ error: "Vista no encontrada." });
    return { view: view(updated) };
  });

  app.delete("/api/views/:id", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const result = await views.deleteOne({ _id: params.data.id, userId: request.user!.id });
    if (!result.deletedCount) return reply.code(404).send({ error: "Vista no encontrada." });
    return reply.code(204).send();
  });
}
