import { isNetworkError, TransientError } from "../lib/errors.js";

export interface HttpProbe {
  /** Código HTTP de GET <url>, o lanza TransientError si no hay respuesta. */
  status(url: string): Promise<number>;
  /** GET <url> y parsea JSON (null si el cuerpo no es JSON). */
  json(url: string): Promise<{ status: number; body: unknown }>;
}

export function createHttpProbe(fetchImpl: typeof fetch = fetch): HttpProbe {
  async function get(url: string) {
    try {
      return await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      if (isNetworkError(error) || error instanceof TypeError) {
        throw new TransientError("app_unreachable", `La aplicación no responde en ${new URL(url).host}.`);
      }
      throw error;
    }
  }

  return {
    async status(url) {
      const response = await get(url);
      await response.body?.cancel();
      return response.status;
    },
    async json(url) {
      const response = await get(url);
      const body = await response.json().catch(() => null);
      return { status: response.status, body };
    }
  };
}
