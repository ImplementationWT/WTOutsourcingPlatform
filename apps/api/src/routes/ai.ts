import Anthropic from "@anthropic-ai/sdk";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AI_MODEL } from "../ai/agent-definition.js";
import { PREVIEW_COOKIE } from "../ai/preview-pass.js";
import { AiDeveloper, AiDeveloperError } from "../ai/service.js";
import { requireAdmin } from "../auth/session.js";
import { slugSchema } from "../domain/naming.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { redact } from "../lib/redact.js";
import type { AdminStore } from "../store/admin-store.js";
import type { AiSessionDoc } from "../store/models.js";

const slugParams = z.object({ slug: slugSchema });
const idParams = z.object({ id: z.string().uuid() });
// Archivos .md adjuntos: van al agente como documentos del mensaje. Topes en bytes UTF-8:
// así la petición cabe en el límite de 1 MB de nginx y Fastify.
const attachmentsSchema = z
  .array(
    z
      .object({
        name: z
          .string()
          .trim()
          .max(120)
          .regex(/^[^/\\\0]+\.(md|markdown)$/i),
        content: z
          .string()
          .min(1)
          .refine((content) => Buffer.byteLength(content) <= 200_000)
      })
      .strict()
  )
  .max(5)
  .refine((files) => files.reduce((total, file) => total + Buffer.byteLength(file.content), 0) <= 600_000);
const ATTACHMENTS_HELP = "Hasta 5 archivos .md de 200 KB (600 KB en total).";
const startSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    message: z.string().trim().min(1).max(20_000).optional(),
    attachments: attachmentsSchema.optional()
  })
  .strict();
const messageSchema = z
  .object({ text: z.string().trim().max(20_000).default(""), attachments: attachmentsSchema.optional() })
  .strict()
  .refine((body) => body.text.length > 0 || Boolean(body.attachments?.length));
const confirmSchema = z.object({ toolUseId: z.string().min(1).max(200), allow: z.boolean() }).strict();
const mergeSchema = z.object({ confirm: z.literal(true) }).strict();

/** Motivo que da Anthropic en el cuerpo del error (describe la petición, no la cuenta). */
function anthropicDetail(error: InstanceType<typeof Anthropic.APIError>): string | null {
  const body = error.error as { error?: { message?: unknown } } | undefined;
  const message = body?.error?.message;
  return typeof message === "string" && message.trim() ? redact(message.trim()).slice(0, 500) : null;
}

/** Errores del SDK de Anthropic → respuesta para el panel (sin detalles de la cuenta). */
function anthropicError(error: unknown): { status: number; message: string } | null {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return { status: 503, message: "Anthropic rechazó la clave de la API. Revisa la clave de la cuenta empresarial." };
  }
  if (error instanceof Anthropic.RateLimitError) return { status: 429, message: "Anthropic limitó las peticiones. Espera un momento." };
  if (error instanceof Anthropic.NotFoundError) return { status: 409, message: "La sesión del agente ya no existe en Anthropic." };
  if (error instanceof Anthropic.BadRequestError) {
    const detail = anthropicDetail(error);
    return { status: 409, message: `Anthropic rechazó la petición${detail ? `: ${detail}` : "."}` };
  }
  if (error instanceof Anthropic.APIError) return { status: 502, message: "Anthropic no respondió correctamente. Reintenta en unos segundos." };
  return null;
}

/**
 * AI Developer (solo con sesión de administrador). Claude edita el repo del
 * cliente en un sandbox de Anthropic; aquí se crean rama y PR y se fusiona.
 */
export async function registerAiRoutes(
  app: FastifyInstance,
  { store, ai, secureCookies }: { store: AdminStore; ai?: AiDeveloper; secureCookies: boolean }
) {
  // Cualquier dominio de servidor: el pase va firmado y ligado al host exacto, y solo vale
  // para el host de la vista previa activa de su sesión.
  const previewHostRe = /^preview-[a-z0-9]+(-[a-z0-9]+)*\.([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/;
  const previewHost = (request: FastifyRequest) => {
    const host = request.headers["x-preview-host"];
    return typeof host === "string" && previewHostRe.test(host) ? host : null;
  };
  // Cada mensaje cuesta dinero: 20 por minuto por usuario.
  const messageLimiter = createRateLimiter({ limit: 20, windowMs: 60_000 });

  const publicSession = (session: AiSessionDoc) => ({
    id: session._id,
    clientId: session.clientId,
    title: session.title,
    status: session.status,
    branch: session.branch,
    baseBranch: session.baseBranch,
    repository: session.repository,
    createdBy: session.createdBy,
    createdAt: session.createdAt,
    lastMessageAt: session.lastMessageAt ?? null,
    pullRequest: session.pullRequest ?? null,
    merge: session.merge ?? null,
    closedAt: session.closedAt ?? null,
    consoleUrl: ai?.consoleUrl(session) ?? null
  });

  /** Ejecuta una acción del AI Developer traduciendo sus errores a respuestas. */
  async function run<T>(request: FastifyRequest, reply: FastifyReply, fn: (ai: AiDeveloper) => Promise<T>) {
    if (!ai) return reply.code(503).send({ error: "El AI Developer no está configurado: falta la clave de la API de Anthropic." });
    try {
      return await fn(ai);
    } catch (error) {
      if (error instanceof AiDeveloperError) return reply.code(error.status).send({ error: error.message });
      const mapped = anthropicError(error);
      if (mapped) {
        const apiError = error as InstanceType<typeof Anthropic.APIError>;
        request.log.warn({ status: apiError.status, requestId: apiError.requestID, detail: anthropicDetail(apiError) }, "Anthropic request failed");
        return reply.code(mapped.status).send({ error: mapped.message });
      }
      throw error;
    }
  }

  async function loadSession(request: FastifyRequest, reply: FastifyReply) {
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      void reply.code(400).send({ error: "Id inválido." });
      return null;
    }
    const session = await store.aiSessions.findOne({ _id: params.data.id });
    if (!session) void reply.code(404).send({ error: "Sesión no encontrada." });
    return session;
  }

  app.get("/api/ai/status", { preHandler: requireAdmin }, async () => ({
    enabled: Boolean(ai),
    model: AI_MODEL,
    // null si no se pudo consultar (la sesión lo volverá a intentar al empezar).
    missingPermissions: ai ? await ai.missingGithubPermissions().catch(() => null) : null
  }));

  app.get("/api/clients/:slug/ai/sessions", { preHandler: requireAdmin }, async (request, reply) => {
    const params = slugParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Identificador inválido." });
    const sessions = await store.aiSessions.find({ clientId: params.data.slug }).sort({ createdAt: -1 }).limit(20).toArray();
    return { sessions: sessions.map(publicSession) };
  });

  app.post("/api/clients/:slug/ai/sessions", { preHandler: requireAdmin }, async (request, reply) => {
    const params = slugParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Identificador inválido." });
    const body = startSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: `Indica un título (3-120 caracteres) y, opcionalmente, la primera instrucción. ${ATTACHMENTS_HELP}` });
    }
    const actor = request.user!.username;
    if (!messageLimiter.take(actor)) return reply.code(429).send({ error: "Demasiados mensajes. Espera un minuto." });
    return run(request, reply, async (ai) => {
      const { title, message, attachments } = body.data;
      const session = await ai.start({ clientId: params.data.slug, title, message, attachments, actor });
      return reply.code(201).send({ session: publicSession(session) });
    });
  });

  app.get("/api/ai/sessions/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const session = await loadSession(request, reply);
    if (!session) return reply;
    return run(request, reply, async (ai) => {
      // El estado del agente es informativo: si Anthropic no responde, se muestra la sesión igualmente.
      const usage = await ai.usage(session).catch(() => null);
      return { session: publicSession(session), agent: usage };
    });
  });

  app.get("/api/ai/sessions/:id/events", { preHandler: requireAdmin }, async (request, reply) => {
    const session = await loadSession(request, reply);
    if (!session) return reply;
    if (!ai) return reply.code(503).send({ error: "El AI Developer no está configurado." });

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive"
    });
    const controller = new AbortController();
    const keepAlive = setInterval(() => !res.writableEnded && res.write("\n"), 15_000);
    const close = () => {
      controller.abort();
      clearInterval(keepAlive);
      if (!res.writableEnded) res.end();
    };
    request.raw.on("close", close);
    try {
      for await (const event of ai.events(session, controller.signal)) {
        if (res.destroyed) break;
        res.write(`${JSON.stringify(redact(event))}\n`);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        request.log.warn({ status: (error as { status?: number }).status }, "AI event stream failed");
        if (!res.writableEnded) res.write(`${JSON.stringify({ id: "stream-error", at: null, kind: "error", message: "Se perdió la conexión con el agente; recarga para reconectar." })}\n`);
      }
    } finally {
      close();
    }
  });

  app.post("/api/ai/sessions/:id/messages", { preHandler: requireAdmin }, async (request, reply) => {
    const session = await loadSession(request, reply);
    if (!session) return reply;
    const body = messageSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: `Escribe una instrucción (máximo 20.000 caracteres) o adjunta archivos. ${ATTACHMENTS_HELP}` });
    }
    const actor = request.user!.username;
    if (!messageLimiter.take(actor)) return reply.code(429).send({ error: "Demasiados mensajes. Espera un minuto." });
    return run(request, reply, async (ai) => {
      await ai.send(session, body.data.text, actor, body.data.attachments);
      return reply.code(202).send({ ok: true });
    });
  });

  app.post("/api/ai/sessions/:id/confirm", { preHandler: requireAdmin }, async (request, reply) => {
    const session = await loadSession(request, reply);
    if (!session) return reply;
    const body = confirmSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Confirmación inválida." });
    return run(request, reply, async (ai) => {
      await ai.confirm(session, body.data.toolUseId, body.data.allow, request.user!.username);
      return { ok: true };
    });
  });

  app.post("/api/ai/sessions/:id/interrupt", { preHandler: requireAdmin }, async (request, reply) => {
    const session = await loadSession(request, reply);
    if (!session) return reply;
    return run(request, reply, async (ai) => {
      await ai.interrupt(session, request.user!.username);
      return { ok: true };
    });
  });

  app.post("/api/ai/sessions/:id/budget", { preHandler: requireAdmin }, async (request, reply) => {
    const session = await loadSession(request, reply);
    if (!session) return reply;
    return run(request, reply, (ai) => ai.raiseBudget(session, request.user!.username));
  });

  app.get("/api/ai/sessions/:id/diff", { preHandler: requireAdmin }, async (request, reply) => {
    const session = await loadSession(request, reply);
    if (!session) return reply;
    return run(request, reply, (ai) => ai.diff(session));
  });

  app.post("/api/ai/sessions/:id/pull-request", { preHandler: requireAdmin }, async (request, reply) => {
    const session = await loadSession(request, reply);
    if (!session) return reply;
    return run(request, reply, async (ai) => ({ pullRequest: await ai.createPullRequest(session, request.user!.username) }));
  });

  app.get("/api/ai/sessions/:id/review", { preHandler: requireAdmin }, async (request, reply) => {
    const session = await loadSession(request, reply);
    if (!session) return reply;
    return run(request, reply, (ai) => ai.review(session));
  });

  app.post("/api/ai/sessions/:id/merge", { preHandler: requireAdmin }, async (request, reply) => {
    const session = await loadSession(request, reply);
    if (!session) return reply;
    if (!mergeSchema.safeParse(request.body).success) return reply.code(400).send({ error: "Confirma la fusión." });
    return run(request, reply, (ai) => ai.merge(session, request.user!.username));
  });

  // ---- vista previa ------------------------------------------------------------

  app.post("/api/ai/sessions/:id/preview", { preHandler: requireAdmin }, async (request, reply) => {
    const session = await loadSession(request, reply);
    if (!session) return reply;
    return run(request, reply, async (ai) => ({ preview: await ai.startPreview(session, request.user!.username) }));
  });

  app.get("/api/ai/sessions/:id/preview", { preHandler: requireAdmin }, async (request, reply) => {
    const session = await loadSession(request, reply);
    if (!session) return reply;
    return run(request, reply, async (ai) => ({ preview: await ai.previewState(session) }));
  });

  app.post("/api/ai/sessions/:id/preview/stop", { preHandler: requireAdmin }, async (request, reply) => {
    const session = await loadSession(request, reply);
    if (!session) return reply;
    return run(request, reply, async (ai) => {
      await ai.stopPreview(session, request.user!.username, "manual");
      return { ok: true };
    });
  });

  /**
   * Las dos rutas siguientes las llama nginx desde preview-<slug>.<dominio> (sin
   * sesión del panel): canjear el pase del iframe por una cookie de ese host y
   * validar esa cookie en cada petición (auth_request).
   */
  app.get("/api/ai/preview/auth", async (request, reply) => {
    const host = previewHost(request);
    const query = request.query as { t?: unknown; next?: unknown };
    const pass = typeof query.t === "string" ? query.t : undefined;
    const redeemed = host && ai ? await ai.redeemPreviewPass(host, pass) : null;
    if (!redeemed) {
      return reply.code(401).type("text/plain; charset=utf-8").send("Enlace de vista previa caducado o inválido. Ábrela de nuevo desde Launchpad.");
    }
    const next = typeof query.next === "string" && /^\/(?![/\\])[^\s\\]*$/.test(query.next) ? query.next : "/";
    const cookie = [`${PREVIEW_COOKIE}=${redeemed.cookie}`, "Path=/", `Max-Age=${redeemed.maxAgeSeconds}`, "HttpOnly", "SameSite=Lax", ...(secureCookies ? ["Secure"] : [])];
    return reply.header("set-cookie", cookie.join("; ")).header("cache-control", "no-store").redirect(next, 302);
  });

  app.get("/api/ai/preview/check", async (request, reply) => {
    const host = previewHost(request);
    const pass = request.headers["x-preview-pass"];
    const ok = Boolean(host && ai && (await ai.authorizePreview(host, typeof pass === "string" ? pass : undefined)));
    return reply.code(ok ? 204 : 401).header("cache-control", "no-store").send();
  });

  app.post("/api/ai/sessions/:id/close", { preHandler: requireAdmin }, async (request, reply) => {
    const session = await loadSession(request, reply);
    if (!session) return reply;
    return run(request, reply, async (ai) => {
      await ai.close(session, request.user!.username);
      return { ok: true };
    });
  });
}
