import type { MarkdownAttachment } from "@/types/ai";
import { LOCALE } from "@/lib/format";

/** Título de la sesión a partir del primer mensaje (o del primer adjunto): no hay que escribirlo aparte. */
export function sessionTitle(message: string, attachments: MarkdownAttachment[]) {
  const line =
    message
      .split("\n")
      .map((l) => l.replace(/[#*_`>]/g, "").trim())
      .find(Boolean) ?? "";
  const title = line || attachments[0]?.name.replace(/\.(md|markdown)$/i, "") || "";
  if (title.length >= 3) return title.length > 80 ? `${title.slice(0, 77).trimEnd()}…` : title;
  return `Cambio del ${new Date().toLocaleDateString(LOCALE, { day: "2-digit", month: "short" })}`;
}
