import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { MeetingParticipant } from "../ops/models.js";

/**
 * Webhook de Read.ai (support.read.ai, "Getting Started with Webhooks"): un POST con JSON cuando
 * el reporte de la reunión está listo (`trigger: "meeting_end"`). La firma va en X-Read-Signature:
 * HMAC-SHA256 en hexadecimal del cuerpo crudo, con la signing key decodificada de base64.
 */
export function readAiSignatureMatches(rawBody: Buffer, header: string | undefined, key: Buffer) {
  if (!header) return false;
  const expected = Buffer.from(createHmac("sha256", key).update(rawBody).digest("hex"));
  const received = Buffer.from(header.trim().toLowerCase());
  return expected.length === received.length && timingSafeEqual(expected, received);
}

const person = z
  .object({ name: z.string().max(200).nullish(), first_name: z.string().max(120).nullish(), last_name: z.string().max(120).nullish(), email: z.string().max(200).nullish() })
  .passthrough();
const textItem = z.object({ text: z.string().max(4000) }).passthrough();

/** Lo que se usa del payload; el resto se ignora (Read.ai puede agregar campos). */
export const readAiPayloadSchema = z
  .object({
    session_id: z.string().min(1).max(200),
    trigger: z.string().max(40),
    title: z.string().max(500).nullish(),
    start_time: z.string().max(60).nullish(),
    end_time: z.string().max(60).nullish(),
    participants: z.array(person).max(500).nullish(),
    owner: person.nullish(),
    summary: z.string().max(50_000).nullish(),
    action_items: z.array(textItem).max(200).nullish(),
    key_questions: z.array(textItem).max(200).nullish(),
    topics: z.array(textItem).max(200).nullish(),
    report_url: z.string().max(500).nullish(),
    transcript: z
      .object({
        speaker_blocks: z
          .array(z.object({ start_time: z.union([z.string(), z.number()]).nullish(), speaker: z.object({ name: z.string().max(200).nullish() }).passthrough().nullish(), words: z.string().max(100_000).nullish() }).passthrough())
          .max(20_000)
          .nullish()
      })
      .passthrough()
      .nullish(),
    request_id: z.string().max(200).nullish()
  })
  .passthrough();
export type ReadAiPayload = z.infer<typeof readAiPayloadSchema>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_TRANSCRIPT = 300_000;

const validDate = (value: string | null | undefined) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
};

/** Reunión a partir del payload: título, fecha, duración, participantes, transcripción y lo de Read.ai. */
export function meetingFromReadAi(payload: ReadAiPayload, receivedAt: Date) {
  const start = validDate(payload.start_time);
  const end = validDate(payload.end_time);
  const participants: MeetingParticipant[] = [];
  const seen = new Set<string>();
  for (const p of [...(payload.participants ?? []), ...(payload.owner ? [payload.owner] : [])]) {
    const email = p.email && EMAIL.test(p.email.trim()) ? p.email.trim().toLowerCase() : null;
    const name = (p.name || [p.first_name, p.last_name].filter(Boolean).join(" ") || email || "").trim().slice(0, 200);
    const key = email ?? name.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    participants.push({ name: name || "Participante", email });
  }
  // "Nombre: lo que dijo", un bloque por línea: así lo lee el modelo y la pantalla.
  const transcript = (payload.transcript?.speaker_blocks ?? [])
    .map((b) => `${b.speaker?.name?.trim() || "Participante"}: ${(b.words ?? "").trim()}`)
    .filter((line) => !line.endsWith(": "))
    .join("\n")
    .slice(0, MAX_TRANSCRIPT);
  const texts = (items: { text: string }[] | null | undefined) => (items ?? []).map((i) => i.text.trim()).filter(Boolean).slice(0, 100);
  return {
    title: (payload.title?.trim() || "Reunión de Read.ai").slice(0, 160),
    heldAt: start ?? receivedAt,
    durationMinutes: start && end && end > start ? Math.round((end.getTime() - start.getTime()) / 60_000) : null,
    url: payload.report_url && /^https:\/\//i.test(payload.report_url) ? payload.report_url : null,
    externalId: payload.session_id.slice(0, 120),
    participants,
    transcript,
    readAi: { summary: (payload.summary ?? "").trim().slice(0, 8000), actionItems: texts(payload.action_items), topics: texts(payload.topics), keyQuestions: texts(payload.key_questions) },
    ownerEmail: payload.owner?.email?.trim().toLowerCase() ?? null
  };
}
