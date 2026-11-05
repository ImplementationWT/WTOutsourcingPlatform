import { Popover } from "@base-ui/react/popover";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AtSign, Bell, Briefcase, CalendarCheck, FileText, Handshake, Mail, MessageSquare, UserPlus, type LucideIcon } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";

type Kind = "assignment" | "communication" | "deal" | "activity" | "update" | "mention" | "project";
interface Notification {
  id: string;
  kind: Kind;
  title: string;
  body: string;
  link: string;
  actorName: string;
  read: boolean;
  createdAt: string;
}

const ICON: Record<Kind, LucideIcon> = { assignment: UserPlus, communication: Mail, deal: Handshake, activity: CalendarCheck, update: MessageSquare, mention: AtSign, project: Briefcase };
const KEY = ["notifications"] as const;

const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (m < 1) return "ahora";
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? "ayer" : `hace ${d} días`;
};

/**
 * Campana del header: avisos de lo que pasa en tus proyectos y leads (asignaciones, comunicaciones,
 * deals, actividades, updates y menciones). Se actualiza cada 30 s; al abrir uno va a su pantalla.
 */
export function NotificationsBell() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: KEY, queryFn: () => apiFetch<{ items: Notification[]; unread: number }>("/api/notifications"), refetchInterval: 30_000, refetchOnWindowFocus: true });
  const unread = data?.unread ?? 0;
  const refresh = () => queryClient.invalidateQueries({ queryKey: KEY });
  const open = async (n: Notification) => {
    if (!n.read) await apiFetch(`/api/notifications/${n.id}/read`, { method: "POST" }).catch(() => undefined);
    void refresh();
    navigate(n.link);
  };
  const readAll = async () => {
    await apiFetch("/api/notifications/read-all", { method: "POST" }).catch(() => undefined);
    void refresh();
  };
  return (
    <Popover.Root>
      <Popover.Trigger aria-label={unread ? `Notificaciones: ${unread} sin leer` : "Notificaciones"} className="relative inline-flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-card text-foreground transition-colors hover:bg-muted data-[popup-open]:bg-muted">
        <Bell className="size-[18px]" />
        {unread > 0 && <span className="absolute -top-1 -right-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-bold text-primary-foreground ring-2 ring-background tabular-nums">{unread > 9 ? "9+" : unread}</span>}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="end" sideOffset={8} className="z-50">
          <Popover.Popup className="flex max-h-[min(32rem,var(--available-height))] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-[14px] border border-border bg-popover text-popover-foreground shadow-popover outline-none">
            <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
              <Popover.Title className="font-bold">Notificaciones</Popover.Title>
              {unread > 0 && (
                <button type="button" onClick={() => void readAll()} className="text-xs font-semibold text-accent-text hover:underline">
                  Marcar todas como leídas
                </button>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {!data?.items.length ? (
                <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
                  <FileText className="size-5 text-muted-foreground" aria-hidden />
                  <b className="text-sm">No tienes notificaciones</b>
                  <p className="text-xs text-muted-foreground">Aquí llegan las asignaciones, comunicaciones, deals, actividades, updates y menciones de tus proyectos y leads.</p>
                </div>
              ) : (
                <ul>
                  {data.items.map((n) => {
                    const Icon = ICON[n.kind] ?? Bell;
                    return (
                      <li key={n.id}>
                        <Popover.Close
                          render={<button type="button" />}
                          onClick={() => void open(n)}
                          className={cn("flex w-full items-start gap-3 border-b border-border px-4 py-3 text-left transition-colors last:border-0 hover:bg-muted", !n.read && "bg-accent-soft/50")}
                        >
                          <span aria-hidden className={cn("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[10px]", n.read ? "bg-muted text-muted-foreground" : "bg-accent-soft text-accent-text")}>
                            <Icon className="size-4" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className={cn("block text-sm", !n.read && "font-semibold")}>{n.title}</span>
                            {n.body && <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{n.body}</span>}
                            <span className="mt-1 block text-[11px] text-muted-foreground">
                              {n.actorName} · {ago(n.createdAt)}
                            </span>
                          </span>
                          {!n.read && <span aria-label="Sin leer" className="mt-2 size-2 shrink-0 rounded-full bg-primary" />}
                        </Popover.Close>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
