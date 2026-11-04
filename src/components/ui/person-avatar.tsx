import { cn } from "@/lib/utils";

// Colores de los avatares del prototipo (texto blanco encima).
const COLORS = ["#e2445c", "#f2832b", "#5bc67d", "#a25ddc", "#579bfc", "#e0a50f", "#e468b0", "#73c9c6"];

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

/** Color estable por persona (el mismo id da siempre el mismo color). */
function colorOf(key: string) {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

/** Avatar con iniciales (prototipo `.av`): círculo de color con las dos primeras letras. */
export function PersonAvatar({ person, size = 32, className }: { person: { id: string; name: string | null }; size?: number; className?: string }) {
  const name = person.name ?? "—";
  return (
    <span
      title={name}
      aria-label={name}
      role="img"
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white", className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38), background: colorOf(person.id) }}
    >
      {initials(name)}
    </span>
  );
}

/** Avatares apilados (prototipo `.stk`): cada uno se monta un poco sobre el anterior. */
export function AvatarStack({ people, size = 32, empty = "—" }: { people: { id: string; name: string | null }[]; size?: number; empty?: string }) {
  if (!people.length) return <span className="text-sm text-muted-foreground">{empty}</span>;
  return (
    <span className="flex items-center">
      {people.map((p, i) => (
        <PersonAvatar key={p.id} person={p} size={size} className={cn("ring-2 ring-card", i > 0 && "-ml-1.5")} />
      ))}
    </span>
  );
}
