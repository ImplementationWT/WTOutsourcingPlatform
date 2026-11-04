import {
  Activity,
  BarChart3,
  BriefcaseBusiness,
  ClipboardList,
  Contact,
  FileText,
  FolderKanban,
  Gauge,
  KanbanSquare,
  Landmark,
  Mail,
  Megaphone,
  MessagesSquare,
  Plug,
  Receipt,
  UserCheck,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import type { UserRole } from "@/features/auth/auth";
import { canAccess, type ModuleId } from "@/lib/access";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Quién la ve: el acceso vive en MODULE_ACCESS (src/lib/access.ts). */
  module: ModuleId;
  /** Contador al lado (lo calcula `useNavBadges`). */
  badge?: "backlog" | "followUps";
  /** Pantallas que aún no existen: no se muestran como enlace. */
  soon?: boolean;
  /** Rutas que también lo marcan como activo (p. ej. el detalle de un lead). */
  also?: RegExp;
  /** Solo activo en la ruta exacta (o en `also`), no en el resto de sus subrutas. */
  end?: boolean;
}

export interface NavGroup {
  /** Sin título: las opciones van sueltas, sin encabezado (Backlog / Sprints al final). */
  title: string;
  items: NavItem[];
}

// Costos está dentro del Dashboard de Infraestructura y Usuarios en el menú del usuario.
// Deals no está en el menú: se gestiona en la pestaña Deals del proyecto (/deals sigue por ruta).
// Actividades y Demos tampoco: viven en el detalle del lead (sus rutas siguen activas).
export const NAV_GROUPS: NavGroup[] = [
  {
    title: "Dashboards",
    items: [
      { to: "/tableros/financiero", label: "Financiero", icon: Landmark, module: "dashboards" },
      { to: "/tableros/comercial", label: "Comercial", icon: BarChart3, module: "dashboards" },
      { to: "/tableros/operativo", label: "Operativo", icon: Gauge, module: "dashboards" },
    ],
  },
  {
    title: "Comercial",
    items: [
      { to: "/comercial/contactos", label: "Contactos", icon: Contact, module: "contacts" },
      { to: "/comercial", label: "Leads", icon: Megaphone, module: "leads", end: true, also: /^\/comercial\/leads\// },
      { to: "/comercial/propuestas", label: "Propuestas", icon: FileText, module: "proposals" },
      { to: "/meetings", label: "Meetings", icon: MessagesSquare, module: "meetings" },
      { to: "/comercial/comunicaciones", label: "Comunicaciones", icon: Mail, module: "communications", badge: "followUps" },
    ],
  },
  {
    title: "Operativa",
    items: [
      { to: "/operativa/mi-trabajo", label: "Mi trabajo", icon: UserCheck, module: "myWork" },
      { to: "/operativa", label: "Proyectos", icon: BriefcaseBusiness, module: "projects", end: true, also: /^\/operativa\/(?!mi-trabajo$|tasks$|backlog$)[^/]+$/ },
      { to: "/operativa/tasks", label: "Tasks", icon: ClipboardList, module: "tasks" },
    ],
  },
  {
    title: "Financiera",
    items: [
      { to: "/financiera/invoices", label: "Invoices", icon: Receipt, module: "invoices" },
      { to: "/financiera/pagos", label: "Pagos / Comisiones", icon: Wallet, module: "payouts" },
    ],
  },
  {
    title: "Infraestructura",
    items: [
      { to: "/dashboard", label: "Dashboard", icon: Activity, module: "infraDashboard" },
      { to: "/projects", label: "Apps y repositorios", icon: FolderKanban, module: "apps" },
      { to: "/integrations", label: "Integraciones", icon: Plug, module: "integrations" },
    ],
  },
  {
    title: "",
    items: [{ to: "/operativa/backlog", label: "Backlog / Sprints", icon: KanbanSquare, module: "backlog", badge: "backlog" }],
  },
];

/** Grupos e ítems que ve un rol (sin rol, ninguno). Un grupo sin ítems visibles no aparece. */
export function navFor(role: UserRole | undefined): NavGroup[] {
  if (!role) return [];
  return NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => canAccess(role, i.module)) })).filter((g) => g.items.length > 0);
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
