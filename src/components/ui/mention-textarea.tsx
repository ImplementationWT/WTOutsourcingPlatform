import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PersonAvatar } from "@/components/ui/person-avatar";
import { Textarea } from "@/components/ui/input";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";

export interface Person {
  id: string;
  name: string;
}

/** Personas de la aplicación que se pueden mencionar con «@». */
export const usePeople = () => useQuery({ queryKey: ["notifications", "people"], queryFn: async () => (await apiFetch<{ people: Person[] }>("/api/notifications/people")).people, staleTime: 5 * 60_000 });

/** Ids de las personas mencionadas que siguen escritas en el texto («@Nombre»). */
export const mentionsIn = (text: string, people: Person[]) => people.filter((p) => text.includes(`@${p.name}`)).map((p) => p.id);

/**
 * Texto con menciones: al escribir «@» aparece la lista de personas (filtra mientras se escribe);
 * con clic, Enter o Tab se inserta «@Nombre ». Enter sin la lista abierta llama a `onSubmit`
 * (Shift+Enter hace un salto de línea).
 */
export function MentionTextarea({ value, onChange, onSubmit, placeholder, label, className }: { value: string; onChange: (v: string) => void; onSubmit?: () => void; placeholder?: string; label: string; className?: string }) {
  const people = usePeople().data ?? [];
  const ref = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<{ start: number; text: string } | null>(null);
  const [active, setActive] = useState(0);
  const matches = query ? people.filter((p) => p.name.toLowerCase().includes(query.text.toLowerCase())).slice(0, 6) : [];

  const detect = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const at = before.lastIndexOf("@");
    // «@» al inicio o tras un espacio, y sin saltos de línea hasta el cursor.
    if (at >= 0 && (at === 0 || /\s/.test(before[at - 1])) && !/[\n@]/.test(before.slice(at + 1)) && before.length - at <= 30) {
      setQuery({ start: at, text: before.slice(at + 1) });
      setActive(0);
    } else setQuery(null);
  };
  const pick = (p: Person) => {
    if (!query) return;
    const caret = ref.current?.selectionStart ?? value.length;
    const next = `${value.slice(0, query.start)}@${p.name} ${value.slice(caret)}`;
    onChange(next);
    setQuery(null);
    const pos = query.start + p.name.length + 2;
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(pos, pos);
    });
  };

  return (
    <div className="relative">
      <Textarea
        ref={ref}
        aria-label={label}
        rows={3}
        value={value}
        placeholder={placeholder}
        className={className}
        role="combobox"
        aria-expanded={matches.length > 0}
        aria-controls="mention-list"
        aria-autocomplete="list"
        onChange={(e) => {
          onChange(e.target.value);
          detect(e.target.value, e.target.selectionStart);
        }}
        onBlur={() => setTimeout(() => setQuery(null), 150)}
        onKeyDown={(e) => {
          if (matches.length) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => (i + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              pick(matches[active]);
              return;
            }
            if (e.key === "Escape") {
              setQuery(null);
              return;
            }
          }
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && onSubmit) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
      {matches.length > 0 && (
        <ul id="mention-list" role="listbox" aria-label="Mencionar a" className="absolute top-full left-0 z-30 mt-1 w-64 overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-popover">
          {matches.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === active}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(p)} className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm", i === active ? "bg-muted font-semibold" : "hover:bg-muted")}>
                <PersonAvatar person={p} size={22} />
                {p.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Texto de un update con las menciones «@Nombre» resaltadas. */
export function WithMentions({ text, people }: { text: string; people: Person[] }) {
  const names = people.map((p) => p.name).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!names.length) return <>{text}</>;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(@(?:${names.map(escape).join("|")}))`, "g"));
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("@") && names.includes(part.slice(1)) ? (
          <span key={i} className="rounded bg-accent-soft px-1 font-semibold text-accent-text">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}
