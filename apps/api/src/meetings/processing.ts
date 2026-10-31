import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Collection, Filter } from "mongodb";
import type { ActionItemDoc, MeetingCore } from "../ops/models.js";
import type { MeetingAnalyzer } from "./analyzer.js";

/** Un procesamiento que quedó a medias (p. ej. reinicio del servidor) se puede repetir pasado este tiempo. */
const STALE_MS = 10 * 60_000;

const FAILED_MESSAGE = "No se pudo procesar la transcripción. Vuelve a intentarlo en unos minutos.";

/**
 * Procesamiento de reuniones con Claude: resumen, feedback, action items propuestos, sentimiento
 * del cliente y tipo de reunión. Claude propone: no crea tareas ni cambia el Health (§4.2).
 * Se toma la reunión con un cambio atómico a "processing", así dos peticiones no la procesan dos
 * veces. Sin analizador (sin clave de Anthropic) las reuniones quedan pendientes.
 */
export class MeetingProcessing {
  private readonly running = new Set<Promise<unknown>>();

  constructor(
    private readonly analyzer: MeetingAnalyzer | undefined,
    private readonly log: FastifyBaseLogger,
    private readonly now: () => Date = () => new Date()
  ) {}

  get available() {
    return Boolean(this.analyzer);
  }

  async process<T extends MeetingCore>(collection: Collection<T>, id: string, context: string, onProcessed?: (meeting: T) => Promise<unknown>): Promise<T | null> {
    if (!this.analyzer) return null;
    const at = this.now();
    const claimable = {
      _id: id,
      transcript: { $ne: "" },
      $or: [{ status: { $in: ["pending", "failed"] } }, { status: "processing", updatedAt: { $lt: new Date(at.getTime() - STALE_MS) } }]
    } as Filter<T>;
    const claimed = await collection.findOneAndUpdate(claimable, { $set: { status: "processing", processingError: null, updatedAt: at } } as never, { returnDocument: "after" });
    if (!claimed) return null;

    try {
      const analysis = await this.analyzer.analyze({ title: claimed.title, transcript: claimed.transcript, context });
      const done = this.now();
      const actionItems: ActionItemDoc[] = analysis.actionItems.map((a) => ({
        _id: randomUUID(),
        text: a.text,
        kind: a.kind,
        ownerName: a.owner,
        ownerUserId: null,
        projectedHours: a.projectedHours,
        phase: a.phase,
        status: "proposed"
      }));
      const updated = await collection.findOneAndUpdate(
        { _id: id } as Filter<T>,
        {
          $set: {
            status: "processed",
            summary: analysis.summary,
            feedback: analysis.feedback,
            actionItems,
            clientSentiment: analysis.clientSentiment,
            engagement: analysis.engagement,
            // El tipo lo sugiere el modelo solo si nadie lo indicó.
            ...(claimed.kind ? {} : { kind: analysis.kind }),
            processingError: null,
            processedAt: done,
            usage: { inputTokens: analysis.inputTokens, outputTokens: analysis.outputTokens },
            updatedAt: done
          }
        } as never,
        { returnDocument: "after" }
      );
      if (updated && onProcessed) await onProcessed(updated as T);
      return updated as T | null;
    } catch (error) {
      this.log.warn({ err: error, meetingId: id }, "Meeting processing failed");
      return (await collection.findOneAndUpdate(
        { _id: id } as Filter<T>,
        { $set: { status: "failed", processingError: FAILED_MESSAGE, updatedAt: this.now() } } as never,
        { returnDocument: "after" }
      )) as T | null;
    }
  }

  /** Procesa en segundo plano (al registrar una reunión con transcripción). */
  start<T extends MeetingCore>(collection: Collection<T>, id: string, context: string, onProcessed?: (meeting: T) => Promise<unknown>) {
    if (!this.analyzer) return;
    const task = this.process(collection, id, context, onProcessed)
      .catch((error) => this.log.error({ err: error, meetingId: id }, "Meeting processing crashed"))
      .finally(() => this.running.delete(task));
    this.running.add(task);
  }

  /** Espera a los procesamientos en curso (cierre del servidor y tests). */
  async idle() {
    await Promise.all([...this.running]);
  }
}
