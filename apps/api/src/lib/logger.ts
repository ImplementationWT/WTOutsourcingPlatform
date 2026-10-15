import type { FastifyServerOptions } from "fastify";
import { redact } from "./redact.js";

type LoggerOptions = Exclude<NonNullable<FastifyServerOptions["logger"]>, boolean>;

/**
 * Opciones de pino para Fastify y para el motor de trabajos: todo objeto que
 * se loguea pasa por `redact` (por clave y por valor), incluidos los errores
 * y el propio mensaje de texto.
 */
export function loggerOptions(overrides: { level?: string; stream?: NodeJS.WritableStream } = {}): LoggerOptions {
  const options = {
    level: overrides.level ?? "info",
    ...(overrides.stream ? { stream: overrides.stream } : {}),
    serializers: {
      err: (error: unknown) => redact(error),
      error: (error: unknown) => redact(error),
      req: (req: { method: string; url: string; id: string }) => ({ method: req.method, url: req.url, id: req.id })
    },
    formatters: {
      log: (object: Record<string, unknown>) => redact(object)
    },
    hooks: {
      logMethod(this: unknown, args: unknown[], method: (...args: unknown[]) => void) {
        method.apply(this, redact(args));
      }
    }
  };
  return options as unknown as LoggerOptions;
}
