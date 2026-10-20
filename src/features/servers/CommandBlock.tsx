import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Bloque de comandos para copiar y ejecutar en el VPS. */
export default function CommandBlock({ children, label }: { children: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Sin permiso de portapapeles: el texto sigue visible para copiarlo a mano.
    }
  }

  return (
    <div className="relative">
      <pre
        aria-label={label}
        className="max-h-80 overflow-auto rounded-lg border border-foreground/10 bg-foreground/5 p-3 pr-12 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all"
      >
        {children}
      </pre>
      <Button type="button" size="icon-xs" variant="ghost" onClick={copy} className="absolute top-2 right-2" title="Copiar">
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}
