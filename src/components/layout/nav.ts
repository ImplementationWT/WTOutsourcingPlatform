import {
  Activity,
  BriefcaseBusiness,
  Contact,
  FileText,
  FolderKanban,
  Handshake,
  Landmark,
  ListTodo,
  Megaphone,
  MessagesSquare,
  MonitorPlay,
  Plug,
  type LucideIcon,
} from "lucide-react";
import type { UserRole } from "@/features/auth/auth";

export interface NavItem {
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

export interface NavGroup {
  title: string;
  roles: UserRole[];
  items: NavItem[];
}

// Costos está dentro del Dashboard y Usuarios en el menú del usuario.
export const NAV_GROUPS: NavGroup[] = [
  {
    // Tableros generales: los usan Comercial y Operativa por igual.
    title: "General",
    roles: ["boss", "commercial", "finance", "lead", "developer"],
    items: [
      { to: "/deals", label: "Deals", icon: Handshake, also: /^\/deals\// },
      { to: "/meetings", label: "Meetings", icon: MessagesSquare },
    ],
  },
  {
    title: "Comercial",
    roles: ["boss", "commercial", "finance"],
    items: [
      { to: "/comercial", label: "Leads", icon: Megaphone, end: true, also: /^\/comercial\/leads\// },
      { to: "/comercial/actividades", label: "Actividades", icon: ListTodo },
      { to: "/comercial/demos", label: "Demos", icon: MonitorPlay },
      { to: "/comercial/propuestas", label: "Propuestas", icon: FileText },
      { to: "/comercial/contactos", label: "Contactos", icon: Contact },
    ],
  },
  {
    title: "Operativa",
    roles: ["boss", "commercial", "finance", "lead", "developer"],
    items: [
      { to: "/operativa", label: "Proyectos", icon: BriefcaseBusiness, end: true, also: /^\/operativa\/[^/]+$/ },
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

/** Grupos e ítems que ve un rol (sin rol, ninguno). */
export function navFor(role: UserRole | undefined): NavGroup[] {
  if (!role) return [];
  return NAV_GROUPS.filter((g) => g.roles.includes(role)).map((g) => ({ ...g, items: g.items.filter((i) => !i.roles || i.roles.includes(role)) }));
}

/** ¿El ítem corresponde a la ruta? Igual que NavLink: exacta con `end`, o la ruta y sus subrutas. */
export function isActive(item: Pick<NavItem, "to" | "end" | "also">, pathname: string) {
  if (item.also?.test(pathname)) return true;
  if (pathname === item.to) return true;
  return !item.end && pathname.startsWith(`${item.to}/`);
}

/** El grupo y el ítem del menú donde está la ruta (para las migas de pan). */
export function locate(role: UserRole | undefined, pathname: string): { group: NavGroup; item: NavItem } | null {
  for (const group of navFor(role)) {
    const item = group.items.find((i) => !i.soon && isActive(i, pathname));
    if (item) return { group, item };
  }
  return null;
}

/** Atajo de teclado del buscador: Ctrl K (⌘K en Mac). */
export const isPaletteShortcut = (e: KeyboardEvent) => (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k";
