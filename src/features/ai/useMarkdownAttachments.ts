import { type DragEvent, useState } from "react";
import type { MarkdownAttachment } from "@/types/ai";

// Los mismos topes que la API (apps/api/src/routes/ai.ts): la petición cabe en 1 MB.
export const MAX_ATTACHMENTS = 5;
const MAX_FILE_BYTES = 200_000;
const MAX_TOTAL_BYTES = 600_000;
const MARKDOWN = /\.(md|markdown)$/i;

export const bytes = (text: string) => new TextEncoder().encode(text).length;
export const kb = (n: number) => `${Math.max(1, Math.round(n / 1000))} KB`;

/** Archivos .md adjuntos a un mensaje: lectura, validación y quitar. */
export function useMarkdownAttachments() {
  const [files, setFiles] = useState<MarkdownAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function add(list: FileList | File[]) {
    setError(null);
    const next = [...files];
    for (const file of Array.from(list)) {
      if (!MARKDOWN.test(file.name)) {
        setError(`${file.name}: solo se aceptan archivos .md o .markdown.`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        setError(`${file.name} pesa ${kb(file.size)}; el máximo es ${kb(MAX_FILE_BYTES)}.`);
        continue;
      }
      const content = await file.text();
      if (!content.trim()) {
        setError(`${file.name} está vacío.`);
        continue;
      }
      // Mismo nombre: se sustituye por la versión nueva.
      const at = next.findIndex((f) => f.name === file.name);
      if (at === -1 && next.length >= MAX_ATTACHMENTS) {
        setError(`Como máximo ${MAX_ATTACHMENTS} archivos por mensaje.`);
        break;
      }
      const candidate = at === -1 ? [...next, { name: file.name, content }] : next.map((f, i) => (i === at ? { name: file.name, content } : f));
      if (candidate.reduce((total, f) => total + bytes(f.content), 0) > MAX_TOTAL_BYTES) {
        setError(`Los adjuntos superan ${kb(MAX_TOTAL_BYTES)} en total.`);
        continue;
      }
      next.splice(0, next.length, ...candidate);
    }
    setFiles(next);
  }

  return {
    files,
    error,
    add,
    remove: (name: string) => setFiles((current) => current.filter((f) => f.name !== name)),
    clear: () => {
      setFiles([]);
      setError(null);
    },
    /** Props para aceptar archivos soltados sobre una zona (el cuadro de texto). */
    dropZone: {
      onDragOver: (e: DragEvent) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      },
      onDrop: (e: DragEvent) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        void add(e.dataTransfer.files);
      },
    },
  };
}

export type MarkdownAttachmentsState = ReturnType<typeof useMarkdownAttachments>;
