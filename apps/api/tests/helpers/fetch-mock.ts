/** fetch simulado: cada llamada se resuelve con el handler y se registra. */
export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export type Handler = (call: RecordedCall) => Response | Promise<Response>;

export function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

export function createFetchMock(handler: Handler) {
  const calls: RecordedCall[] = [];
  const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: RecordedCall = {
      method: init?.method ?? "GET",
      url: String(input),
      headers,
      body: typeof init?.body === "string" ? init.body : undefined
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetch: fetchMock, calls };
}
