import { NavLink, useLocation } from "react-router-dom";
import {
  Activity,
  BookOpen,
  BriefcaseBusiness,
  Building2,
  Contact,
  FileText,
  FolderKanban,
  Handshake,
  Inbox,
  Landmark,
  ListTodo,
  Megaphone,
  MessagesSquare,
  MonitorPlay,
  Plug,
  Users,
  type LucideIcon,
} from "lucide-react";
import { BrandLockup } from "@/components/brand/Brand";
import { useSession, type UserRole } from "@/features/auth/auth";
import { cn } from "@/lib/utils";

interface Item {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Áreas que aún no existen: se muestran, pero sin enlace. */
  soon?: boolean;
  /** Rutas que también lo marcan como activo (p. ej. el detalle de un lead). */
  also?: RegExp;
  /** Solo activo en la ruta exacta (o en `also`), no en el resto de sus subrutas. */
  end?: boolean;
  /** Si solo algunos roles del grupo la ven. */
  roles?: UserRole[];
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
    roles: ["boss", "commercial", "finance"],
    items: [
      { to: "/comercial", label: "Leads", icon: Megaphone, end: true, also: /^\/comercial\/leads\// },
      { to: "/comercial/actividades", label: "Actividades", icon: ListTodo },
      { to: "/comercial/demos", label: "Demos", icon: MonitorPlay },
      { to: "/comercial/propuestas", label: "Propuestas", icon: FileText },
      { to: "/comercial/deals", label: "Deals", icon: Handshake },
      { to: "/comercial/contactos", label: "Contactos", icon: Contact },
      { to: "/comercial/empresas", label: "Empresas", icon: Building2 },
      { to: "/comercial/partners", label: "Partners", icon: Users },
      { to: "/comercial/catalogo", label: "Catálogo", icon: BookOpen },
      { to: "/comercial/reuniones", label: "Reuniones por asignar", icon: MessagesSquare, roles: ["boss", "commercial"] },
      { to: "/comercial/sources", label: "Sources de leads", icon: Inbox, roles: ["boss", "commercial"] },
    ],
  },
  {
    title: "Operativa",
    roles: ["boss", "commercial", "finance", "lead", "developer"],
    items: [
      { to: "/operativa", label: "Proyectos del cliente", icon: BriefcaseBusiness, end: true, also: /^\/operativa\/(?!deals$)[^/]+$/ },
      { to: "/operativa/deals", label: "Deals", icon: Handshake },
    ],
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

const itemClass = (active: boolean) =>
  cn(
    "relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
    active
      ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-sidebar-primary"
      : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
  );

/** Navegación por áreas según el rol. `onNavigate` cierra el panel en el celular. */
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const role = useSession().data?.role;
  const { pathname } = useLocation();
  const visible = groups.filter((g) => role && g.roles.includes(role));

  return (
    <nav className="flex-1 space-y-5 overflow-y-auto p-3 pt-5" aria-label="Áreas">
      {visible.map((group) => (
        <div key={group.title} className="space-y-0.5">
          <p className="flex items-center gap-2 px-3 pb-1.5 text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
            <span>{group.title}</span>
            {/* Un área que aún no existe se avisa en su título: el nombre de la opción entra completo. */}
            {group.items.every((i) => i.soon) && <span className="rounded-full border border-foreground/15 px-1.5 py-px text-[9px] tracking-wide">Pronto</span>}
          </p>
          {group.items.filter((i) => !i.roles || (role && i.roles.includes(role))).map(({ to, label, icon: Icon, soon, end, also }) =>
            soon ? (
              <span key={to} aria-disabled="true" className="flex cursor-not-allowed items-center gap-3 rounded-md px-3 py-2 text-sm whitespace-nowrap text-muted-foreground/60">
                <Icon className="size-4 shrink-0" />
                <span className="truncate">{label}</span>
              </span>
            ) : (
              <NavLink key={to} to={to} end={end} onClick={onNavigate} className={({ isActive }) => itemClass(isActive || Boolean(also?.test(pathname)))}>
                <Icon className="size-4 shrink-0" />
                <span className="truncate">{label}</span>
              </NavLink>
            ),
          )}
        </div>
      ))}
    </nav>
  );
}

/** Barra lateral fija en pantallas grandes; en el celular la navegación vive en un panel (AppLayout). */
export default function AppSidebar() {
  return (
    <aside className="sticky top-0 z-20 hidden h-svh w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:flex">
      <div className="flex h-16 items-center border-b border-sidebar-border px-5">
        <BrandLockup subtitle="Plataforma de la empresa" />
      </div>
      <SidebarNav />
    </aside>
  );
}
