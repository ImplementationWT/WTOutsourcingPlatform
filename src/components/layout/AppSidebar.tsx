import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { ChevronDown, Search } from "lucide-react";
import { BrandLockup } from "@/components/brand/Brand";
import { useSession } from "@/features/auth/auth";
import { cn } from "@/lib/utils";
import { isActive, navFor } from "./nav";

const COLLAPSED_KEY = "sidebar.collapsed";

function readCollapsed(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function writeCollapsed(titles: string[]) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(titles));
  } catch {
    // Sin almacenamiento: los grupos plegados duran hasta recargar.
  }
}

const itemClass = (active: boolean) =>
  cn(
    "group/item flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
    active ? "bg-sidebar-accent font-semibold text-sidebar-accent-foreground" : "text-sidebar-foreground/80 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground",
  );

/** Punto a la izquierda de cada opción: rojo en la activa. */
function Dot({ active }: { active: boolean }) {
  return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full transition-colors", active ? "bg-sidebar-primary" : "bg-foreground/25 group-hover/item:bg-foreground/45")} />;
}

/** Botón «Buscar o ir a…» (abre el buscador; también con Ctrl K). */
export function SearchTrigger({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-control w-full items-center gap-2 rounded-lg border border-sidebar-border bg-background/60 px-3 text-sm text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground"
    >
      <Search className="size-4 shrink-0" aria-hidden />
      <span className="flex-1 truncate text-left">Buscar o ir a…</span>
      <kbd className="rounded-md border border-sidebar-border px-1.5 py-px font-sans text-[11px]">Ctrl K</kbd>
    </button>
  );
}

/**
 * Navegación por áreas según el rol: cada área se pliega (se recuerda en este navegador) y las
 * que aún no existen quedan al pie con «Pronto». `onNavigate` cierra el panel en el celular.
 */
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const role = useSession().data?.role;
  const { pathname } = useLocation();
  const groups = navFor(role);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const live = groups.filter((g) => g.items.some((i) => !i.soon));
  const soon = groups.flatMap((g) => (g.items.every((i) => i.soon) ? [g] : []));

  const toggle = (title: string) => {
    const next = collapsed.includes(title) ? collapsed.filter((t) => t !== title) : [...collapsed, title];
    setCollapsed(next);
    writeCollapsed(next);
  };

  return (
    <nav className="flex min-h-0 flex-1 flex-col" aria-label="Áreas">
      <div className="flex-1 space-y-4 overflow-y-auto px-3 py-4">
        {live.map((group) => {
          // El área de la pantalla abierta nunca queda plegada.
          const here = group.items.some((i) => !i.soon && isActive(i, pathname));
          const open = here || !collapsed.includes(group.title);
          const id = `nav-${group.title.toLowerCase()}`;
          return (
            <div key={group.title}>
              <button
                type="button"
                aria-expanded={open}
                aria-controls={id}
                disabled={here}
                onClick={() => toggle(group.title)}
                className="flex w-full items-center justify-between rounded-md px-3 py-1.5 text-[11px] font-bold tracking-[0.12em] text-muted-foreground uppercase transition-colors hover:text-foreground disabled:cursor-default disabled:hover:text-muted-foreground"
              >
                {group.title}
                <ChevronDown aria-hidden className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />
              </button>
              {open && (
                <div id={id} className="mt-1 space-y-0.5">
                  {group.items
                    .filter((i) => !i.soon)
                    .map((item) => (
                      <NavLink key={item.to} to={item.to} end={item.end} onClick={onNavigate} className={({ isActive: exact }) => itemClass(exact || Boolean(item.also?.test(pathname)))}>
                        {({ isActive: exact }) => (
                          <>
                            <Dot active={exact || Boolean(item.also?.test(pathname))} />
                            <span className="truncate">{item.label}</span>
                          </>
                        )}
                      </NavLink>
                    ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {soon.length > 0 && (
        <div className="space-y-0.5 border-t border-sidebar-border px-3 py-3">
          {soon.map((g) => (
            <span key={g.title} aria-disabled="true" title={g.items.map((i) => i.label).join(", ")} className="flex cursor-not-allowed items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground">
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-foreground/20" />
              <span className="flex-1 truncate">{g.title}</span>
              <span className="rounded-full border border-sidebar-border px-2 py-px text-[11px]">Pronto</span>
            </span>
          ))}
        </div>
      )}
    </nav>
  );
}

/** Barra lateral fija en pantallas grandes; en el celular la navegación vive en un panel (AppLayout). */
export default function AppSidebar({ onSearch }: { onSearch?: () => void }) {
  return (
    <aside className="sticky top-0 z-20 hidden h-svh w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:flex">
      <div className="px-5 pt-5 pb-4">
        <BrandLockup subtitle="Plataforma de la empresa" />
      </div>
      {onSearch && (
        <div className="px-3">
          <SearchTrigger onClick={onSearch} />
        </div>
      )}
      <SidebarNav />
    </aside>
  );
}
