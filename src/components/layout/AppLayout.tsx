import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { Menu } from "lucide-react";
import { BrandLockup, BrandMark } from "@/components/brand/Brand";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { applyTheme, useTheme } from "@/lib/theme";
import AppSidebar, { SidebarNav } from "./AppSidebar";
import UserMenu from "./UserMenu";

export default function AppLayout() {
  // El login fuerza el oscuro: al entrar al panel se aplica el tema elegido.
  const { theme } = useTheme();
  useEffect(() => applyTheme(theme), [theme]);
  // Panel de navegación del celular: cada enlace lo cierra al navegar.
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="relative flex min-h-screen bg-background text-foreground">
      {/* Halo rojo de la marca arriba, como en whatever.tech; muy tenue para no competir con el contenido. */}
      <div className="pointer-events-none fixed inset-x-0 top-0 h-[28rem] bg-[radial-gradient(ellipse_at_top,rgb(255_48_84/0.07),transparent_65%)] dark:bg-[radial-gradient(ellipse_at_top,rgb(255_48_84/0.10),transparent_65%)]" />

      <AppSidebar />
      <main className="relative min-w-0 flex-1">
        <header className="sticky top-0 z-10 flex h-16 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur-xl sm:px-6 lg:justify-end lg:px-8">
          <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Abrir menú" onClick={() => setMenuOpen(true)}>
            <Menu className="size-5" />
          </Button>
          <BrandMark className="size-7 lg:hidden" />
          <div className="ml-auto">
            <UserMenu />
          </div>
        </header>

        <div className="px-4 py-6 sm:px-6 lg:p-8">
          <Outlet />
        </div>
      </main>

      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" className="w-72 gap-0 bg-sidebar p-0 text-sidebar-foreground">
          <SheetTitle className="sr-only">Navegación</SheetTitle>
          <div className="flex h-16 items-center border-b border-sidebar-border px-5">
            <BrandLockup subtitle="Plataforma de la empresa" />
          </div>
          <SidebarNav onNavigate={() => setMenuOpen(false)} />
        </SheetContent>
      </Sheet>
    </div>
  );
}
