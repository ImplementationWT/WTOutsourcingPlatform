import { useState } from "react";
import { Bug, FormInput, LayoutTemplate, Palette, Type } from "lucide-react";
import type { AiSession } from "@/types/ai";
import { ClaudeAvatar } from "./ChatPanel";
import Composer from "./Composer";
import { sessionTitle } from "./session-title";
import { startAiSession } from "./api";
import { useMarkdownAttachments } from "./useMarkdownAttachments";

/** Ideas de un clic: rellenan la caja con una plantilla que solo hay que completar. */
const SUGGESTIONS = [
  { icon: Type, label: "Cambiar un texto o título", text: "En la pantalla «…», cambia el texto «…» por «…»." },
  { icon: FormInput, label: "Añadir un campo a un formulario", text: "En el formulario de «…», añade un campo «…» (obligatorio) y guárdalo en la base de datos." },
  { icon: Palette, label: "Usar los colores de la marca", text: "Usa los colores de la marca en botones y encabezados: principal #…, secundario #…." },
  { icon: LayoutTemplate, label: "Crear una pantalla nueva", text: "Crea una pantalla «…» que muestre … y añádela al menú." },
  { icon: Bug, label: "Corregir un error", text: "Cuando …, pasa …. Debería …. Corrígelo." },
];

/** Pantalla de conversación nueva: saludo, caja grande e ideas para empezar. */
export default function Welcome({
  slug,
  projectName,
  onStarted,
  onFailed,
}: {
  slug: string;
  projectName: string;
  onStarted: (session: AiSession) => void;
  /** Si falló el primer mensaje la sesión ya existe: se recarga la lista para reintentar desde el chat. */
  onFailed: () => void;
}) {
  const [text, setText] = useState("");
  const attachments = useMarkdownAttachments();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const message = text.trim();
      const { session } = await startAiSession(slug, {
        title: sessionTitle(message, attachments.files),
        message: message || undefined,
        ...(attachments.files.length ? { attachments: attachments.files } : {}),
      });
      onStarted(session);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo empezar la conversación.");
      onFailed();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center overflow-y-auto px-4 py-10">
      <div className="w-full max-w-2xl space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <ClaudeAvatar className="size-11 [&_svg]:size-5" />
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">¿Qué quieres cambiar en {projectName}?</h1>
          <p className="max-w-lg text-sm text-muted-foreground">
            Cuéntaselo a Claude con tus palabras. Trabaja en una copia aparte, te enseña el resultado en una vista previa y nada se publica sin tu
            aprobación.
          </p>
        </div>

        <Composer
          value={text}
          onChange={setText}
          onSubmit={start}
          attachments={attachments}
          busy={busy}
          autoFocus
          large
          placeholder="Por ejemplo: en la pantalla de inicio, cambia el título «Bienvenido» por «Hola de nuevo». También puedes soltar aquí archivos .md con especificaciones."
        />
        {error && (
          <p role="alert" className="text-center text-sm text-red-300">
            {error}
          </p>
        )}

        <div className="flex flex-wrap justify-center gap-2">
          {SUGGESTIONS.map(({ icon: Icon, label, text: template }) => (
            <button
              key={label}
              type="button"
              onClick={() => setText(template)}
              className="flex items-center gap-2 rounded-full border border-foreground/10 bg-foreground/[0.03] px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground"
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
