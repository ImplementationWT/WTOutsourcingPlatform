import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { MongoServerError } from "mongodb";
import { z } from "zod";
import { createRateLimiter } from "../lib/rate-limit.js";
import { flatten, ingestKeyMatches, leadTitle, mapLead, rawJsonOf } from "../sales/ingest.js";
import type { LeadDoc } from "../sales/models.js";
import type { AdminStore } from "../store/admin-store.js";

const params = z.object({ sourceId: z.string().uuid() });
const BODY_LIMIT = 256 * 1024;

/** Clave de ingesta: cabecera X-Ingest-Key o Authorization: Bearer. Nunca en la URL (la URL se loguea). */
function keyOf(headers: Record<string, string | string[] | undefined>) {
  const direct = headers["x-ingest-key"];
  if (typeof direct === "string" && direct) return direct.trim();
  const auth = headers.authorization;
  const match = typeof auth === "string" ? /^Bearer\s+(.+)$/i.exec(auth) : null;
  return match ? match[1].trim() : null;
}

/**
 * Ingesta pública de leads: cada source (web, ads, formularios, Zapier…) envía su JSON o su
 * formulario tal cual. No se exige un esquema: se guarda el original, se aplanan los datos y se
 * aplica el mapeo del source. Reenviar el mismo lead (mismo id externo) no lo duplica.
 */
export async function registerIngestRoutes(app: FastifyInstance, { store, now = Date.now }: { store: AdminStore; now?: () => number }) {
  const limiter = createRateLimiter({ limit: 120, windowMs: 60_000, now });

  await app.register(async (scope) => {
    // Los formularios HTML envían application/x-www-form-urlencoded; solo se acepta en esta ruta.
    scope.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: BODY_LIMIT }, (_request, body, done) => {
      const form: Record<string, string | string[]> = {};
      for (const [key, value] of new URLSearchParams(body as string)) {
        const current = form[key];
        form[key] = current === undefined ? value : Array.isArray(current) ? [...current, value] : [current, value];
      }
      done(null, form);
    });

    scope.post("/api/ingest/leads/:sourceId", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
      const parsed = params.safeParse(request.params);
      const key = keyOf(request.headers);
      if (!parsed.success || !key) return reply.code(401).send({ error: "Clave de ingesta inválida." });
      if (!limiter.take(`${parsed.data.sourceId}:${request.ip}`)) return reply.code(429).send({ error: "Demasiados envíos. Espera un minuto." });

      const source = await store.leadSources.findOne({ _id: parsed.data.sourceId });
      // Mismo error si el source no existe o la clave no coincide: no se confirma qué sources hay.
      if (!source || !ingestKeyMatches(key, source.ingestKeyHash)) {
        request.log.warn({ sourceId: parsed.data.sourceId }, "Lead ingest with an invalid key");
        return reply.code(401).send({ error: "Clave de ingesta inválida." });
      }
      if (!source.active) return reply.code(403).send({ error: "Este source está desactivado." });
      const body = request.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) return reply.code(400).send({ error: "Envía un objeto JSON o un formulario." });

      const fields = flatten(body);
      const mapped = mapLead(fields, source.mapping);
      const at = new Date(now());
      await store.leadSources.updateOne(
        { _id: source._id },
        { $inc: { received: 1 }, $set: { lastReceivedAt: at, sampleKeys: fields.map((f) => f.key).slice(0, 100) } }
      );

      if (mapped.externalId) {
        const existing = await store.leads.findOne({ sourceId: source._id, externalId: mapped.externalId }, { projection: { _id: 1 } });
        if (existing) return reply.code(200).send({ leadId: existing._id, duplicate: true });
      }
      const lead: LeadDoc = {
        _id: randomUUID(),
        sourceId: source._id,
        sourceName: source.name,
        externalId: mapped.externalId,
        status: "new",
        company: mapped.company,
        contactName: mapped.contactName,
        email: mapped.email,
        phone: mapped.phone,
        notes: mapped.notes,
        fields,
        rawJson: rawJsonOf(body),
        ownerUserId: null,
        lostReason: null,
        customerId: null,
        projectId: null,
        createdBy: `source:${source.name}`,
        createdAt: at,
        updatedAt: at
      };
      try {
        await store.leads.insertOne(lead);
      } catch (error) {
        // Dos envíos simultáneos del mismo lead: gana el primero.
        if (error instanceof MongoServerError && error.code === 11000 && mapped.externalId) {
          const existing = await store.leads.findOne({ sourceId: source._id, externalId: mapped.externalId }, { projection: { _id: 1 } });
          if (existing) return reply.code(200).send({ leadId: existing._id, duplicate: true });
        }
        throw error;
      }
      await store.leadUpdates.insertOne({ _id: randomUUID(), leadId: lead._id, kind: "system", body: `Lead recibido desde ${source.name}.`, authorUsername: `source:${source.name}`, authorName: source.name, createdAt: at });
      await store.audit({ actor: `source:${source.name}`, action: "sales.lead_ingested", clientId: `sales:${lead._id}`, target: leadTitle(lead) });
      return reply.code(201).send({ leadId: lead._id });
    });
  });
}
