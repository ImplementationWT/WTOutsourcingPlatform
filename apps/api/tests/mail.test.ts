import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createLoginGuard } from "../src/auth/login-guard.js";
import { hashPassword } from "../src/auth/password.js";
import { bodyText, createGmailProvider } from "../src/mail/google.js";
import { buildMime } from "../src/mail/message.js";
import { MailError, type Mailbox, type MailProvider, type RawMessage } from "../src/mail/provider.js";
import { freshStore, startDb, stopDb } from "./helpers/db.js";
import { createFakes } from "./helpers/fakes.js";
import { seedUser, TEST_TEAM_ID } from "./helpers/users.js";

const PASSWORD = "correct horse battery staple";
let passwordHash: string;
let apps: Awaited<ReturnType<typeof buildApp>>[] = [];
beforeAll(async () => {
  await startDb();
  passwordHash = await hashPassword(PASSWORD);
});
afterAll(stopDb);
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("delegación sin llave (IAM Credentials signJwt)", () => {
  function fakeGoogle(overrides: { sign?: Response; exchange?: Response } = {}) {
    const calls: { url: string; body: string; auth: string | null }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
      calls.push({ url, body, auth: new Headers(init?.headers).get("authorization") });
      if (url === "https://oauth2.googleapis.com/token" && body.includes("grant_type=refresh_token")) return json({ access_token: "base-access", expires_in: 3600 });
      if (url.includes(":signJwt")) return overrides.sign ?? json({ keyId: "k", signedJwt: "signed.jwt.value" });
      if (url === "https://oauth2.googleapis.com/token") return overrides.exchange ?? json({ access_token: "user-access", expires_in: 3600 });
      if (url.endsWith("/profile")) return json({ emailAddress: "Caleb@whatever.tech", historyId: "100" });
      return json({}, 404);
    }) as typeof fetch;
    const provider = createGmailProvider({ serviceAccount: "gmail-sync@wt.iam.gserviceaccount.com", base: { clientId: "cid", clientSecret: "csecret", refreshToken: "rtoken" }, fetchImpl });
    return { calls, provider };
  }

  it("firma como la SA con sub = el buzón, cambia el JWT por un token y lo reutiliza", async () => {
    const { calls, provider } = fakeGoogle();
    const box = provider.mailbox("caleb@whatever.tech");
    expect(await box.profile()).toEqual({ email: "caleb@whatever.tech", cursor: "100" });
    const sign = calls.find((c) => c.url.includes(":signJwt"))!;
    expect(sign.url).toBe("https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/gmail-sync%40wt.iam.gserviceaccount.com:signJwt");
    expect(sign.auth).toBe("Bearer base-access");
    const claims = JSON.parse(JSON.parse(sign.body).payload);
    expect(claims).toMatchObject({ iss: "gmail-sync@wt.iam.gserviceaccount.com", sub: "caleb@whatever.tech", aud: "https://oauth2.googleapis.com/token", scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send" });
    expect(claims.exp - claims.iat).toBe(3600);
    expect(calls.find((c) => c.body.includes("jwt-bearer"))!.body).toContain("assertion=signed.jwt.value");
    expect(calls.at(-1)).toMatchObject({ url: "https://gmail.googleapis.com/gmail/v1/users/me/profile", auth: "Bearer user-access" });
    await box.profile();
    expect(calls.filter((c) => c.url.includes(":signJwt"))).toHaveLength(1);
  });

  it("explica cada falla sin exponer tokens", async () => {
    const denied = fakeGoogle({ sign: json({ error: { status: "PERMISSION_DENIED" } }, 403) });
    await expect(denied.provider.mailbox("a@whatever.tech").profile()).rejects.toMatchObject({ code: "sign_denied" });
    const noDwd = fakeGoogle({ exchange: json({ error: "unauthorized_client" }, 401) });
    await expect(noDwd.provider.mailbox("a@whatever.tech").profile()).rejects.toMatchObject({ code: "delegation_denied" });
    const gone = fakeGoogle({ exchange: json({ error: "invalid_grant" }, 400) });
    const error = await gone.provider.mailbox("nadie@whatever.tech").profile().catch((e: unknown) => e as MailError);
    expect(error).toMatchObject({ code: "mailbox_unavailable" });
    expect(JSON.stringify(error) + (error as Error).message).not.toMatch(/rtoken|csecret|signed\.jwt|base-access/);
  });
});

describe("mensajes", () => {
  it("el MIME no deja abrir cabeceras y codifica acentos", () => {
    const mime = buildMime({ from: "caleb@whatever.tech", fromName: "Caleb Reátegui", to: ["juan@acme.com"], subject: "Propuesta\r\nBcc: espia@x.com", body: "Hola Juan,\nqué tal", inReplyTo: "<abc@mail.gmail.com>" });
    const headers = mime.split("\r\n\r\n")[0];
    expect(headers).not.toMatch(/^Bcc:/m);
    expect(headers).toMatch(/^From: =\?UTF-8\?B\?.+\?= <caleb@whatever\.tech>$/m);
    expect(headers).toMatch(/^In-Reply-To: <abc@mail\.gmail\.com>$/m);
    expect(Buffer.from(mime.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8")).toBe("Hola Juan,\r\nqué tal");
  });

  it("toma el texto plano y, si solo hay HTML, lo convierte (sin adjuntos)", () => {
    const b64 = (s: string) => Buffer.from(s).toString("base64url");
    expect(bodyText({ mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: b64("<p>HTML</p>") } }, { mimeType: "text/plain", body: { data: b64("Plano") } }] })).toBe("Plano");
    expect(bodyText({ mimeType: "multipart/mixed", parts: [{ mimeType: "text/plain", filename: "a.txt", body: { attachmentId: "x" } }, { mimeType: "text/html", body: { data: b64("<style>x{}</style><p>Hola&nbsp;Juan</p><br>Saludos") } }] })).toBe("Hola Juan\n\nSaludos");
  });
});

/** Gmail en memoria: un buzón por correo, con sus mensajes y lo enviado. */
function fakeProvider() {
  const boxes = new Map<string, { messages: RawMessage[]; sent: { mime: string; threadId?: string }[]; cursor: number }>();
  const asked: string[] = [];
  const box = (email: string) => {
    if (!boxes.has(email)) boxes.set(email, { messages: [], sent: [], cursor: 1 });
    return boxes.get(email)!;
  };
  const provider: MailProvider = {
    name: "gmail",
    mailbox(email): Mailbox {
      asked.push(email);
      const b = box(email);
      return {
        profile: async () => ({ email, cursor: String(b.cursor) }),
        changes: async (cursor) => ({ messageIds: b.messages.filter((m) => Number(m.id.split("-")[1]) > Number(cursor)).map((m) => m.id), cursor: String(b.cursor) }),
        recent: async () => b.messages.map((m) => m.id),
        message: async (id) => {
          const m = b.messages.find((x) => x.id === id);
          if (!m) throw new MailError("provider", "no existe", 404);
          return m;
        },
        send: async (mime, threadId) => {
          b.sent.push({ mime, threadId });
          const headers = Object.fromEntries(mime.split("\r\n\r\n")[0].split("\r\n").map((l) => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]));
          const m = deliver(email, { threadId: threadId ?? `t-${b.cursor + 1}`, labelIds: ["SENT"], headers, text: "enviado" });
          return { id: m.id, threadId: m.threadId };
        },
        watch: async () => ({ cursor: String(b.cursor), expiresAt: new Date(Date.now() + 7 * 86_400_000) }),
        stopWatch: async () => undefined
      };
    }
  };
  function deliver(email: string, m: Omit<RawMessage, "id" | "internalDate" | "threadId"> & { threadId?: string }) {
    const b = box(email);
    b.cursor++;
    const msg = { id: `m-${b.cursor}`, threadId: m.threadId ?? `t-${b.cursor}`, internalDate: Date.now(), labelIds: m.labelIds, headers: m.headers, text: m.text };
    b.messages.push(msg);
    return msg;
  }
  return { provider, deliver, boxes, asked };
}

async function world() {
  const store = await freshStore();
  const gmail = fakeProvider();
  const app = await buildApp({
    store,
    deps: createFakes(store).deps,
    logLevel: "silent",
    auth: { adminUsername: "jefe", adminPasswordHash: passwordHash, sessionSecret: "x".repeat(40), secureCookies: false, loginGuard: createLoginGuard({ maxPerIp: 1000, maxPerUser: 1000 }) },
    mail: { provider: gmail.provider, domain: "whatever.tech", pushSecret: "p".repeat(32) }
  });
  apps.push(app);
  const marta = await seedUser(store, passwordHash, { username: "marta", name: "Marta", role: "commercial", teamId: null });
  const mario = await seedUser(store, passwordHash, { username: "mario", name: "Mario", role: "commercial", teamId: null });
  await seedUser(store, passwordHash, { username: "nina", name: "Nina", role: "commercial", teamId: null });
  await seedUser(store, passwordHash, { username: "ana", name: "Ana", role: "lead", teamId: TEST_TEAM_ID });
  await store.users.updateOne({ _id: marta._id }, { $set: { email: "marta@whatever.tech" } });
  await store.users.updateOne({ _id: mario._id }, { $set: { email: "mario@whatever.tech" } });
  const as = async (username: string) => {
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: PASSWORD } });
    const cookie = `pp_session=${login.cookies.find((c) => c.name === "pp_session")!.value}`;
    return async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
      const r = await app.inject({ method, url, headers: { cookie }, payload: payload as never });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- respuestas JSON variadas en los tests
      return { status: r.statusCode, body: (r.body ? r.json() : {}) as Record<string, any> };
    };
  };
  const at = new Date();
  const leadId = "44444444-4444-4444-8444-444444444444";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- lead mínimo para los tests
  await store.leads.insertOne({ _id: leadId, company: "Acme", contactName: "Juan Pérez", email: "Juan@Acme.com", status: "contacted", projectId: null, createdAt: at, updatedAt: at } as any);
  return { app, store, gmail, as, leadId, marta, mario };
}

describe("buzón de cada persona", () => {
  it("al conectar guarda solo los correos con clientes (exacto o por dominio único), nunca los personales", async () => {
    const { app, as, gmail, leadId } = await world();
    gmail.deliver("marta@whatever.tech", { labelIds: ["INBOX"], headers: { from: "Juan Pérez <juan@acme.com>", to: "marta@whatever.tech", subject: "¿Revisamos la propuesta?", "message-id": "<p1@acme.com>" }, text: "Hola Marta" });
    gmail.deliver("marta@whatever.tech", { labelIds: ["INBOX"], headers: { from: "Compras <compras@acme.com>", to: "marta@whatever.tech", subject: "Orden" }, text: "OC" });
    gmail.deliver("marta@whatever.tech", { labelIds: ["INBOX"], headers: { from: "Mamá <mama@gmail.com>", to: "marta@whatever.tech", subject: "Almuerzo" }, text: "personal" });
    gmail.deliver("marta@whatever.tech", { labelIds: ["INBOX"], headers: { from: "Mario <mario@whatever.tech>", to: "marta@whatever.tech", subject: "Interno" }, text: "interno" });
    const marta = await as("marta");
    expect((await marta("GET", "/api/me/mail")).body).toMatchObject({ available: true, email: "marta@whatever.tech", canConnect: true, connection: null });
    expect((await marta("POST", "/api/me/mail/connect")).status).toBe(200);
    await app.mail.idle();
    const list = (await marta("GET", `/api/communications?leadId=${leadId}`)).body.communications;
    expect(list.map((c: { subject: string }) => c.subject).sort()).toEqual(["Orden", "¿Revisamos la propuesta?"]);
    expect(list.find((c: { subject: string }) => c.subject === "Orden").email.matchedBy).toBe("domain");
    expect(list.find((c: { subject: string }) => c.subject.startsWith("¿")).email).toMatchObject({ from: "juan@acme.com", matchedBy: "lead" });
    expect(await app.store.db.collection("core_communications").countDocuments({ subject: { $in: ["Almuerzo", "Interno"] } })).toBe(0);
    // Volver a sincronizar no duplica.
    await marta("POST", "/api/me/mail/sync");
    expect(await app.store.db.collection("core_communications").countDocuments({ source: "gmail" })).toBe(2);
    // Lo nuevo entra por historial.
    gmail.deliver("marta@whatever.tech", { labelIds: ["INBOX"], headers: { from: "juan@acme.com", to: "marta@whatever.tech", subject: "Confirmo reunión" }, text: "ok" });
    await marta("POST", "/api/me/mail/sync");
    expect(await app.store.db.collection("core_communications").countDocuments({ source: "gmail" })).toBe(3);
  });

  it("aislamiento: cada quien solo usa su buzón; sin correo corporativo no se conecta", async () => {
    const { app, as, gmail } = await world();
    const nina = await as("nina");
    expect((await nina("GET", "/api/me/mail")).body.canConnect).toBe(false);
    expect((await nina("POST", "/api/me/mail/connect")).status).toBe(400);
    const mario = await as("mario");
    await mario("POST", "/api/me/mail/connect");
    await app.mail.idle();
    expect([...new Set(gmail.asked)]).toEqual(["mario@whatever.tech"]);
    // Ningún parámetro cambia el buzón.
    expect((await mario("GET", "/api/me/mail?userId=otro")).body.email).toBe("mario@whatever.tech");
    expect((await mario("POST", "/api/me/mail/send", { to: ["juan@acme.com"], subject: "x", body: "y", leadId: "44444444-4444-4444-8444-444444444444", from: "marta@whatever.tech" })).status).toBe(400);
  });

  it("envía desde el buzón propio, responde en el hilo, audita y no deja responder hilos ajenos", async () => {
    const { app, as, gmail, leadId } = await world();
    gmail.deliver("marta@whatever.tech", { threadId: "t-hilo", labelIds: ["INBOX"], headers: { from: "juan@acme.com", to: "marta@whatever.tech", subject: "Propuesta", "message-id": "<orig@acme.com>" }, text: "¿La vemos?" });
    const marta = await as("marta");
    await marta("POST", "/api/me/mail/connect");
    await app.mail.idle();
    const original = (await marta("GET", `/api/communications?leadId=${leadId}`)).body.communications[0];

    const reply = await marta("POST", "/api/me/mail/send", { to: ["juan@acme.com"], body: "Claro, mañana.", replyToId: original.id });
    expect(reply.status).toBe(201);
    const sent = gmail.boxes.get("marta@whatever.tech")!.sent[0];
    expect(sent.threadId).toBe("t-hilo");
    expect(sent.mime).toMatch(/^In-Reply-To: <orig@acme\.com>$/m);
    expect(sent.mime).toMatch(/^Subject: Re: Propuesta$/m);
    const thread = (await marta("GET", `/api/communications/${original.id}/thread`)).body.communications;
    expect(thread.map((c: { direction: string }) => c.direction)).toEqual(["received", "sent"]);
    expect(thread[1].email).toMatchObject({ sentFromApp: true });
    const audit = await app.store.auditLog.findOne({ action: "email.sent" });
    expect(audit).toMatchObject({ actor: "marta", clientId: `lead:${leadId}`, details: { from: "marta@whatever.tech", to: ["juan@acme.com"], threadId: "t-hilo", viaApp: true } });

    // Mario ve el lead (Comercial) pero no puede responder desde el hilo de Marta.
    const mario = await as("mario");
    await mario("POST", "/api/me/mail/connect");
    expect((await mario("POST", "/api/me/mail/send", { to: ["juan@acme.com"], body: "Hola", replyToId: original.id })).status).toBe(404);
    // Un correo de Gmail no se edita (solo el seguimiento).
    expect((await marta("PATCH", `/api/communications/${original.id}`, { subject: "Otro" })).status).toBe(400);
    expect((await marta("PATCH", `/api/communications/${original.id}`, { followUpDate: "2026-12-01" })).status).toBe(200);
    // Ana (team leader) no escribe en leads.
    const ana = await as("ana");
    await app.store.users.updateOne({ username: "ana" }, { $set: { email: "ana@whatever.tech" } });
    await ana("POST", "/api/me/mail/connect");
    expect((await ana("POST", "/api/me/mail/send", { to: ["juan@acme.com"], subject: "x", body: "y", leadId })).status).toBe(403);
  });

  it("el aviso push exige el secreto y sincroniza ese buzón", async () => {
    const { app, as, gmail } = await world();
    const marta = await as("marta");
    await marta("POST", "/api/me/mail/connect");
    await app.mail.idle();
    gmail.deliver("marta@whatever.tech", { labelIds: ["INBOX"], headers: { from: "juan@acme.com", to: "marta@whatever.tech", subject: "Por push" }, text: "x" });
    const data = Buffer.from(JSON.stringify({ emailAddress: "marta@whatever.tech", historyId: 99 })).toString("base64");
    expect((await app.inject({ method: "POST", url: "/api/mail/gmail/push?key=malo", payload: { message: { data } } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: `/api/mail/gmail/push?key=${"p".repeat(32)}`, payload: { message: { data } } })).statusCode).toBe(204);
    await app.mail.idle();
    expect(await app.store.db.collection("core_communications").countDocuments({ subject: "Por push" })).toBe(1);
  });
});
