export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** fetch a /api con la cookie de sesión. Lanza ApiError con el mensaje del servidor. */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      ...init,
      headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
    });
  } catch {
    throw new ApiError(0, "No se pudo conectar con el servidor.");
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      (body as { error?: string } | null)?.error ??
      (response.status === 401 ? "Tu sesión expiró. Vuelve a iniciar sesión." : `Error ${response.status}`);
    if (response.status === 401) window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(response.status, message, body);
  }
  return body as T;
}
