import { Fragment, useEffect, useMemo, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { Menu, Search } from "lucide-react";
import { BrandLockup, BrandMark } from "@/components/brand/Brand";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useSession, type UserRole } from "@/features/auth/auth";
import { applyTheme, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import AppSidebar, { SearchTrigger, SidebarNav } from "./AppSidebar";
import { CommandPalette } from "./CommandPalette";
import { CrumbsContext, type Crumb, type CrumbsApi } from "./crumbs";
import { isActive, isPaletteShortcut, locate, type NavItem } from "./nav";
import UserMenu from "./UserMenu";

const iconButton =
  "inline-flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-card text-foreground transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none";

/** Accesos de la barra inferior del celular (los tres que más usa cada rol + «Más»). */
function bottomItems(role: UserRole | undefined): Pick<NavItem, "to" | "label" | "end" | "also">[] {
  const projects = { to: "/operativa", label: "Proyectos", end: true, also: /^\/operativa\/[^/]+$/ };
  const deals = { to: "/deals", label: "Deals", also: /^\/deals\// };
  if (role === "boss" || role === "commercial" || role === "finance") return [{ to: "/comercial", label: "Leads", end: true, also: /^\/comercial\/leads\// }, deals, projects];
  return [deals, { to: "/meetings", label: "Meetings" }, projects];
}

function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  if (!crumbs.length) return null;
  return (
    <nav aria-label="Migas de pan" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <Fragment key={`${c.label}-${i}`}>
              {i > 0 && (
                <li aria-hidden className="text-foreground/25">
                  /
                </li>
              )}
              <li className={cn("min-w-0", last ? "truncate font-semibold text-foreground" : "shrink-0")} aria-current={last ? "page" : undefined}>
                {c.to && !last ? (
                  <Link to={c.to} className="transition-colors hover:text-foreground">
                    {c.label}
                  </Link>
                ) : (
                  c.label
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}

export default function AppLayout() {
  // El login fuerza el oscuro: al entrar al panel se aplica el tema elegido.
  const { theme } = useTheme();
  useEffect(() => applyTheme(theme), [theme]);
  const role = useSession().data?.role;
  const { pathname } = useLocation();
  // Panel de navegación del celular: cada enlace lo cierra al navegar.
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [pageCrumbs, setPageCrumbs] = useState<{ extra?: Crumb[]; replace?: Crumb[] } | null>(null);
  const crumbsApi = useMemo<CrumbsApi>(() => ({ set: setPageCrumbs }), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPaletteShortcut(e)) return;
      e.preventDefault();
      setPaletteOpen((open) => !open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const here = locate(role, pathname);
  const crumbs: Crumb[] =
    pageCrumbs?.replace ??
    (here ? [{ label: here.group.title }, { label: here.item.label, to: here.item.to }, ...(pageCrumbs?.extra ?? [])] : (pageCrumbs?.extra ?? []));

  return (
    <CrumbsContext.Provider value={crumbsApi}>
      <div className="flex min-h-screen bg-background text-foreground">
        <AppSidebar onSearch={() => setPaletteOpen(true)} />
        <main className="relative min-w-0 flex-1">
          {/* Escritorio: migas de pan y usuario. Celular: menú, marca y buscador. */}
          <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur-xl sm:px-6 lg:px-8">
            <button type="button" className={cn(iconButton, "lg:hidden")} aria-label="Abrir menú" onClick={() => setMenuOpen(true)}>
              <Menu className="size-5" />
            </button>
            <Link to="/" className="flex min-w-0 items-center gap-2.5 lg:hidden">
              <BrandMark className="size-8" />
              <span className="truncate text-base font-bold tracking-tight">Whatever Tech</span>
            </Link>
            <div className="hidden min-w-0 flex-1 lg:block">
              <Breadcrumbs crumbs={crumbs} />
            </div>
            <div className="ml-auto flex items-center gap-2">
              <button type="button" className={cn(iconButton, "lg:hidden")} aria-label="Buscar" onClick={() => setPaletteOpen(true)}>
                <Search className="size-5" />
              </button>
              <UserMenu />
            </div>
          </header>

          <div className="px-4 pt-6 pb-28 sm:px-6 lg:px-8 lg:pt-8 lg:pb-10">
            <Outlet />
          </div>
        </main>

        {/* Barra inferior del celular. */}
        <nav aria-label="Accesos" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden">
          {bottomItems(role).map((item) => {
            const active = isActive(item, pathname);
            return (
              <NavLink key={item.to} to={item.to} end={item.end} className={cn("relative flex h-16 items-center justify-center text-sm font-semibold transition-colors", active ? "text-foreground" : "text-muted-foreground")}>
                {active && <span aria-hidden className="absolute top-2 h-1 w-8 rounded-full bg-primary" />}
                {item.label}
              </NavLink>
            );
          })}
          <button type="button" onClick={() => setMenuOpen(true)} className="flex h-16 items-center justify-center text-sm font-semibold text-muted-foreground">
            Más
          </button>
        </nav>

        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetContent side="left" className="w-72 gap-0 bg-sidebar p-0 text-sidebar-foreground">
            <SheetTitle className="sr-only">Navegación</SheetTitle>
            <div className="px-5 pt-5 pb-4">
              <BrandLockup subtitle="Plataforma de la empresa" />
            </div>
            <div className="px-3">
              <SearchTrigger
                onClick={() => {
                  setMenuOpen(false);
                  setPaletteOpen(true);
                }}
              />
            </div>
            <SidebarNav onNavigate={() => setMenuOpen(false)} />
          </SheetContent>
        </Sheet>

        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      </div>
    </CrumbsContext.Provider>
  );
}
