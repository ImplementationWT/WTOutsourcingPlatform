
import { NavLink } from "react-router-dom";
import {
  Activity,
  FolderKanban,
  Layers3,
  Plug,
} from "lucide-react";

const links = [
  { to: "/dashboard", label: "Dashboard", icon: Activity },
  { to: "/projects", label: "Proyectos", icon: FolderKanban },
  { to: "/integrations", label: "Integraciones", icon: Plug },
];

export default function AppSidebar() {
  return (
    <aside className="sticky top-0 z-20 flex h-svh w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground backdrop-blur-xl">
      <div className="flex h-16 items-center gap-3 border-b border-sidebar-border px-5">
        <div className="flex size-9 items-center justify-center rounded-lg border border-foreground/20 bg-foreground/10">
          <Layers3 className="size-5" />
        </div>
        <div>
          <p className="font-semibold">Forge</p>
          <p className="text-xs text-muted-foreground">Infrastructure Console</p>
        </div>
      </div>

      <div className="px-4 pt-6 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Workspace
      </div>

      <nav className="flex-1 space-y-1 p-3">
        {links.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `relative flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors ${
                isActive
                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-sidebar-primary"
                  : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              }`
            }
          >
            <Icon className="size-4" />
            {label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
