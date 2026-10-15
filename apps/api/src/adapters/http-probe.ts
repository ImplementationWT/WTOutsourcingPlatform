import http from "node:http";
import https from "node:https";
import { isNetworkError, TransientError } from "../lib/errors.js";

export interface HttpProbe {
  /** Código HTTP de GET <url>, o lanza TransientError si no hay respuesta. */
  status(url: string): Promise<number>;
  /** GET <url> y parsea JSON (null si el cuerpo no es JSON). */
  json(url: string): Promise<{ status: number; body: unknown }>;
  /** GET <url>: código y Content-Type (para comprobar que se sirve el frontend). */
  page(url: string): Promise<{ status: number; contentType: string | null }>;
}

const TLS_ERRORS = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|HOSTNAME|ALTNAME/;
const MAX_BODY = 256 * 1024;

/**
 * Peticiones GET con certificado verificado: HTTPS debe ser válido para el host.
 * `allowUntrustedCertificates` solo para pruebas con la CA de staging (ACME_CA).
 */
export function createHttpProbe(options: { allowUntrustedCertificates?: boolean } = {}): HttpProbe {
  function get(url: string, readBody: boolean) {
    const target = new URL(url);
    const client = target.protocol === "https:" ? https : http;
    return new Promise<{ status: number; contentType: string | null; body: string }>((resolve, reject) => {
      const request = client.get(
        target,
        { timeout: 10_000, rejectUnauthorized: !options.allowUntrustedCertificates, headers: { accept: "*/*" } },
        (response) => {
          let body = "";
          if (!readBody) response.resume();
          else
            response.on("data", (chunk: Buffer) => {
              if (body.length < MAX_BODY) body += chunk.toString("utf8");
            });
          response.on("end", () =>
            resolve({ status: response.statusCode ?? 0, contentType: response.headers["content-type"] ?? null, body })
          );
          response.on("error", reject);
        }
      );
      request.on("timeout", () => request.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
      request.on("error", reject);
    }).catch((error: unknown) => {
      const code = String((error as { code?: unknown }).code ?? "");
      if (TLS_ERRORS.test(code)) {
        throw new TransientError("tls_invalid", `El certificado HTTPS de ${target.host} no es válido para ese host (${code}).`);
      }
      if (isNetworkError(error) || error instanceof Error) {
        throw new TransientError("app_unreachable", `La aplicación no responde en ${target.host}.`);
      }
      throw error;
    });
  }

  return {
    async status(url) {
      return (await get(url, false)).status;
    },
    async json(url) {
      const response = await get(url, true);
      let body: unknown;
      try {
        body = JSON.parse(response.body);
      } catch {
        body = null;
      }
      return { status: response.status, body };
    },
    async page(url) {
      const { status, contentType } = await get(url, false);
      return { status, contentType };
    }
  };
}
