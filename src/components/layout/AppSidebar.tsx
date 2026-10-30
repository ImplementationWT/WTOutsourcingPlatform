import { NavLink } from "react-router-dom";
import { Activity, BriefcaseBusiness, Building2, FolderKanban, Inbox, Landmark, Layers3, Megaphone, Plug, type LucideIcon } from "lucide-react";
import { useSession, type UserRole } from "@/features/auth/auth";

interface Item {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Áreas que aún no existen: se muestran, pero sin enlace. */
  soon?: boolean;
  /** Solo activo en la ruta exacta (no en sus subrutas). */
  end?: boolean;
}

interface Group {
  title: string;
  roles: UserRole[];
  items: Item[];
}

// Costos está dentro del Dashboard y Usuarios en el menú del usuario.
const groups: Group[] = [
  {
    title: "Comercial",
    roles: ["boss", "commercial"],
    items: [
      { to: "/comercial", label: "Leads y propuestas", icon: Megaphone, end: true },
      { to: "/comercial/clientes", label: "Clientes", icon: Building2 },
      { to: "/comercial/sources", label: "Sources de leads", icon: Inbox },
    ],
  },
  {
    title: "Operativa",
    roles: ["boss", "commercial", "finance", "lead", "developer"],
    items: [{ to: "/operativa", label: "Proyectos del cliente", icon: BriefcaseBusiness }],
  },
  {
    title: "Financiera",
    roles: ["boss", "finance"],
    items: [{ to: "/financiera", label: "Cobros y comisiones", icon: Landmark, soon: true }],
  },
  {
    title: "Infraestructura",
    roles: ["boss", "lead", "developer"],
    items: [
      { to: "/dashboard", label: "Dashboard", icon: Activity },
      { to: "/projects", label: "Apps y repositorios", icon: FolderKanban },
      { to: "/integrations", label: "Integraciones", icon: Plug },
    ],
  },
];

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `relative flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors ${
    isActive
      ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-sidebar-primary"
      : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
  }`;

export default function AppSidebar() {
  const role = useSession().data?.role;
  const visible = groups.filter((g) => role && g.roles.includes(role));

  return (
    <aside className="sticky top-0 z-20 flex h-svh w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground backdrop-blur-xl">
      <div className="flex h-16 items-center gap-3 border-b border-sidebar-border px-5">
        <div className="flex size-9 items-center justify-center rounded-lg border border-foreground/20 bg-foreground/10">
          <Layers3 className="size-5" />
        </div>
        <div>
          <p className="font-semibold">Forge</p>
          <p className="text-xs text-muted-foreground">Plataforma de la empresa</p>
        </div>
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto p-3 pt-5" aria-label="Áreas">
        {visible.map((group) => (
          <div key={group.title} className="space-y-1">
            <p className="px-3 pb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">{group.title}</p>
            {group.items.map(({ to, label, icon: Icon, soon, end }) =>
              soon ? (
                <span key={to} aria-disabled="true" className="flex cursor-not-allowed items-center gap-3 rounded-md px-3 py-2.5 text-sm text-muted-foreground/60">
                  <Icon className="size-4" />
                  {label}
                  <span className="ml-auto rounded-full border border-foreground/15 px-1.5 text-[10px] uppercase">Pronto</span>
                </span>
              ) : (
                <NavLink key={to} to={to} end={end} className={linkClass}>
                  <Icon className="size-4" />
                  {label}
                </NavLink>
              ),
            )}
          </div>
        ))}
      </nav>
    </aside>
  );
}
