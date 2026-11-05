import { htmlToText } from "./message.js";
import { MailError, type Mailbox, type MailProvider, type RawMessage } from "./provider.js";

export { htmlToText };

/**
 * Gmail con delegación de dominio SIN llave de Service Account:
 *
 *   1. Credencial base del backend: una cuenta de Google (ADC "authorized_user": client_id,
 *      client_secret y refresh_token) que tiene el rol Service Account Token Creator sobre la SA.
 *   2. Con ella se llama a IAM Credentials `signJwt`: Google firma, con la llave que administra él,
 *      un JWT de la SA con `sub` = el buzón de la persona y los scopes de Gmail.
 *   3. Ese JWT se cambia en oauth2.googleapis.com/token por un access token que actúa como la
 *      persona (delegación de dominio autorizada en Workspace Admin).
 *
 * Ningún token sale de este archivo: el panel solo ve el estado de la conexión.
 */

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"];
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const IAM_URL = "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts";
const GMAIL_URL = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GoogleBaseCredential {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface GoogleDelegationConfig {
  serviceAccount: string;
  base: GoogleBaseCredential;
  scopes?: string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
}

type Cached = { value: string; expiresAt: number };

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Access tokens: el de la identidad base y uno por buzón, reutilizados hasta 1 min antes de vencer. */
export function createDelegatedTokens({ serviceAccount, base, scopes = GMAIL_SCOPES, fetchImpl = fetch, now = Date.now }: GoogleDelegationConfig) {
  let baseToken: Cached | null = null;
  const perUser = new Map<string, Cached>();
  const inflight = new Map<string, Promise<string>>();
  const fresh = (c: Cached | null | undefined) => c && c.expiresAt - 60_000 > now();

  async function getBase() {
    if (fresh(baseToken)) return baseToken!.value;
    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: base.clientId, client_secret: base.clientSecret, refresh_token: base.refreshToken }),
      signal: AbortSignal.timeout(20_000)
    });
    const body = await readJson(res);
    if (!res.ok || typeof body.access_token !== "string") {
      throw new MailError(
        "base_auth",
        "La cuenta de Google del backend no pudo autenticarse (credencial vencida o revocada). Vuelve a generar la credencial con gcloud auth application-default login.",
        res.status
      );
    }
    baseToken = { value: body.access_token, expiresAt: now() + Number(body.expires_in ?? 3600) * 1000 };
    return baseToken.value;
  }

  async function mint(email: string) {
    const iat = Math.floor(now() / 1000);
    const claims = { iss: serviceAccount, sub: email, scope: scopes.join(" "), aud: TOKEN_URL, iat, exp: iat + 3600 };
    const signed = await fetchImpl(`${IAM_URL}/${encodeURIComponent(serviceAccount)}:signJwt`, {
      method: "POST",
      headers: { authorization: `Bearer ${await getBase()}`, "content-type": "application/json" },
      body: JSON.stringify({ payload: JSON.stringify(claims) }),
      signal: AbortSignal.timeout(20_000)
    });
    const signedBody = await readJson(signed);
    if (signed.status === 401) {
      baseToken = null;
      throw new MailError("base_auth", "La cuenta de Google del backend perdió la sesión. Vuelve a generar la credencial.", 401);
    }
    if (!signed.ok || typeof signedBody.signedJwt !== "string") {
      throw new MailError(
        "sign_denied",
        "La cuenta del backend no puede firmar como la Service Account: revisa que tenga el rol Service Account Token Creator sobre ella y que la API IAM Service Account Credentials esté habilitada.",
        signed.status
      );
    }
    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signedBody.signedJwt }),
      signal: AbortSignal.timeout(20_000)
    });
    const body = await readJson(res);
    if (!res.ok || typeof body.access_token !== "string") {
      const reason = typeof body.error === "string" ? body.error : "";
      if (reason === "unauthorized_client") {
        throw new MailError("delegation_denied", "Workspace no autoriza la delegación: revisa en Admin › Seguridad › Controles de API › Delegación de todo el dominio el Client ID de la Service Account y los scopes gmail.readonly y gmail.send.", res.status);
      }
      if (reason === "invalid_grant") {
        throw new MailError("mailbox_unavailable", `No se pudo actuar como ${email}: la cuenta no existe en Workspace, está suspendida o no tiene Gmail.`, res.status);
      }
      throw new MailError("provider", "Google rechazó el token de la cuenta.", res.status);
    }
    const token = { value: body.access_token, expiresAt: now() + Number(body.expires_in ?? 3600) * 1000 };
    perUser.set(email, token);
    return token.value;
  }

  return {
    async forUser(email: string) {
      const cached = perUser.get(email);
      if (fresh(cached)) return cached!.value;
      // Varias llamadas a la vez para el mismo buzón comparten una sola emisión.
      let pending = inflight.get(email);
      if (!pending) {
        pending = mint(email).finally(() => inflight.delete(email));
        inflight.set(email, pending);
      }
      return pending;
    },
    /** Olvida el token de un buzón (p. ej. tras un 401 de Gmail). */
    forget(email: string) {
      perUser.delete(email);
    }
  };
}

const b64urlDecode = (data: string) => Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

interface GmailPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string };
  parts?: GmailPart[];
  headers?: { name: string; value: string }[];
}

/** Texto del mensaje: la primera parte text/plain que no sea adjunto; si no hay, el HTML convertido. */
export function bodyText(payload: GmailPart) {
  let plain: string | null = null;
  let html: string | null = null;
  const walk = (part: GmailPart) => {
    if (part.filename) return; // adjunto
    if (part.body?.data) {
      if (part.mimeType === "text/plain" && plain === null) plain = b64urlDecode(part.body.data);
      else if (part.mimeType === "text/html" && html === null) html = b64urlDecode(part.body.data);
    }
    for (const p of part.parts ?? []) walk(p);
  };
  walk(payload);
  return (plain ?? (html ? htmlToText(html) : "")).replace(/\r\n/g, "\n").trim();
}

function gmailMailbox(email: string, tokens: ReturnType<typeof createDelegatedTokens>, fetchImpl: typeof fetch): Mailbox {
  async function call<T>(path: string, init: { method?: string; body?: unknown } = {}, retry = true): Promise<T> {
    const res = await fetchImpl(`${GMAIL_URL}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${await tokens.forUser(email)}`, ...(init.body ? { "content-type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(30_000)
    });
    if (res.status === 401 && retry) {
      tokens.forget(email);
      return call<T>(path, init, false);
    }
    const body = await readJson(res);
    if (!res.ok) {
      if (res.status === 404 && path.startsWith("/history")) throw new MailError("cursor_expired", "El historial de Gmail venció; se recargan los correos recientes.", 404);
      if (res.status === 400 && /failedPrecondition|mail service not enabled/i.test(JSON.stringify(body))) {
        throw new MailError("mailbox_unavailable", `La cuenta ${email} no tiene Gmail habilitado.`, 400);
      }
      throw new MailError("provider", `Gmail respondió ${res.status}.`, res.status);
    }
    return body as T;
  }

  return {
    async profile() {
      const p = await call<{ emailAddress: string; historyId: string }>("/profile");
      return { email: p.emailAddress.toLowerCase(), cursor: String(p.historyId) };
    },
    async changes(cursor) {
      const ids: string[] = [];
      let page: string | undefined;
      let latest = cursor;
      do {
        const q = new URLSearchParams({ startHistoryId: cursor, historyTypes: "messageAdded", maxResults: "500" });
        if (page) q.set("pageToken", page);
        const r = await call<{ history?: { messagesAdded?: { message: { id: string } }[] }[]; historyId?: string; nextPageToken?: string }>(`/history?${q}`);
        for (const h of r.history ?? []) for (const m of h.messagesAdded ?? []) ids.push(m.message.id);
        if (r.historyId) latest = String(r.historyId);
        page = r.nextPageToken;
      } while (page && ids.length < 2000);
      return { messageIds: [...new Set(ids)], cursor: latest };
    },
    async recent(days, max) {
      const ids: string[] = [];
      let page: string | undefined;
      do {
        const q = new URLSearchParams({ q: `newer_than:${days}d -in:chats -in:spam -in:trash -in:drafts`, maxResults: String(Math.min(100, max)) });
        if (page) q.set("pageToken", page);
        const r = await call<{ messages?: { id: string }[]; nextPageToken?: string }>(`/messages?${q}`);
        ids.push(...(r.messages ?? []).map((m) => m.id));
        page = r.nextPageToken;
      } while (page && ids.length < max);
      return ids.slice(0, max);
    },
    async message(id) {
      const m = await call<{ id: string; threadId: string; labelIds?: string[]; internalDate?: string; payload?: GmailPart }>(`/messages/${encodeURIComponent(id)}?format=full`);
      const headers: Record<string, string> = {};
      for (const h of m.payload?.headers ?? []) {
        const key = h.name.toLowerCase();
        if (!(key in headers)) headers[key] = h.value;
      }
      return { id: m.id, threadId: m.threadId, labelIds: m.labelIds ?? [], internalDate: Number(m.internalDate ?? Date.now()), headers, text: m.payload ? bodyText(m.payload) : "" } satisfies RawMessage;
    },
    async send(mime, threadId) {
      const raw = Buffer.from(mime, "utf8").toString("base64url");
      const r = await call<{ id: string; threadId: string }>("/messages/send", { method: "POST", body: { raw, ...(threadId ? { threadId } : {}) } });
      return { id: r.id, threadId: r.threadId };
    },
    async watch(topic) {
      const r = await call<{ historyId: string; expiration: string }>("/watch", { method: "POST", body: { topicName: topic, labelIds: ["INBOX", "SENT"], labelFilterBehavior: "include" } });
      return { cursor: String(r.historyId), expiresAt: new Date(Number(r.expiration)) };
    },
    async stopWatch() {
      await call("/stop", { method: "POST" });
    },
    async signature() {
      // Firma de la dirección principal (Gmail › Configuración › Firma). gmail.readonly basta.
      const r = await call<{ sendAs?: { sendAsEmail: string; isPrimary?: boolean; signature?: string }[] }>("/settings/sendAs");
      const list = r.sendAs ?? [];
      const own = list.find((a) => a.sendAsEmail.toLowerCase() === email) ?? list.find((a) => a.isPrimary);
      return own?.signature?.trim() || null;
    }
  };
}

export function createGmailProvider(config: GoogleDelegationConfig): MailProvider {
  const tokens = createDelegatedTokens(config);
  const fetchImpl = config.fetchImpl ?? fetch;
  return { name: "gmail", mailbox: (email) => gmailMailbox(email.toLowerCase(), tokens, fetchImpl) };
}
