
import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import { applyTheme, useTheme } from "@/lib/theme";
import AppSidebar from "./AppSidebar";
import UserMenu from "./UserMenu";

export default function AppLayout() {
  // El login fuerza el oscuro: al entrar al panel se aplica el tema elegido.
  const { theme } = useTheme();
  useEffect(() => applyTheme(theme), [theme]);

  return (
    <div className="relative flex min-h-screen bg-[radial-gradient(ellipse_at_top,#ede9fe_0%,#f6f5fb_45%,#ffffff_100%)] bg-fixed text-foreground dark:bg-[radial-gradient(ellipse_at_top,#1e1b4b_0%,#0b0a1f_45%,#020617_100%)]">
      {/* Mismos halos que el login, más tenues para no competir con el contenido */}
      <div className="pointer-events-none fixed -top-40 left-1/3 size-[36rem] rounded-full bg-violet-600/10 blur-3xl" />
      <div className="pointer-events-none fixed right-0 bottom-0 size-[28rem] rounded-full bg-sky-500/5 blur-3xl" />

      <AppSidebar />
      <main className="relative min-w-0 flex-1">
        <header className="sticky top-0 z-10 flex h-16 items-center justify-end border-b border-foreground/10 bg-foreground/[0.02] px-8 backdrop-blur-xl">
          <UserMenu />
        </header>

        <div className="p-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
