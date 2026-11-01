import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Dialog } from "@base-ui/react/dialog";
import { CornerDownLeft, Search } from "lucide-react";
import { useSession } from "@/features/auth/auth";
import { cn } from "@/lib/utils";
import { navFor } from "./nav";

const normalize = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** Buscador y resultados: se monta al abrir, así cada vez empieza vacío. */
function PaletteBody({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const role = useSession().data?.role;
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);

  const items = useMemo(
    () => navFor(role).flatMap((g) => g.items.filter((i) => !i.soon).map((i) => ({ ...i, group: g.title }))),
    [role],
  );
  const results = useMemo(() => {
    const needle = normalize(q.trim());
    return needle ? items.filter((i) => normalize(`${i.label} ${i.group}`).includes(needle)) : items;
  }, [items, q]);

  const go = (to: string) => {
    onClose();
    navigate(to);
  };

  return (
    <>
          <div className="flex items-center gap-2.5 border-b border-border px-4">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <input
              autoFocus
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((a) => Math.min(a + 1, results.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => Math.max(a - 1, 0));
                } else if (e.key === "Enter" && results[active]) {
                  go(results[active].to);
                }
              }}
              placeholder="Buscar o ir a…"
              aria-label="Buscar o ir a"
              aria-controls="palette-results"
              className="h-13 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <ul id="palette-results" role="listbox" aria-label="Pantallas" className="max-h-80 overflow-y-auto p-2">
            {results.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground">Nada coincide con «{q}».</li>}
            {results.map((item, i) => {
              const Icon = item.icon;
              return (
                <li key={item.to} role="option" aria-selected={i === active}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(item.to)}
                    className={cn("flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm", i === active ? "bg-accent text-accent-foreground" : "text-foreground")}
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>
                    <span className="text-xs text-muted-foreground">{item.group}</span>
                    {i === active && <CornerDownLeft className="size-3.5 text-muted-foreground" aria-hidden />}
                  </button>
                </li>
              );
            })}
          </ul>
    </>
  );
}

/** «Buscar o ir a…»: salta a cualquier pantalla del menú escribiendo su nombre o su área. */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup className="fixed top-[12vh] left-1/2 z-50 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-overlay outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0">
          <Dialog.Title className="sr-only">Buscar o ir a</Dialog.Title>
          <PaletteBody onClose={() => onOpenChange(false)} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
