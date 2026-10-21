import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, LogOut, Moon, Settings, Sun } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { logout, ROLE_LABELS, useSession } from "@/features/auth/auth";
import { useTeams } from "@/features/admin/api";
import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/theme";

export default function UserMenu() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useSession().data;
  const username = user?.name ?? user?.username ?? "";
  const team = useTeams().data?.find((t) => t.id === user?.teamId);
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";

  async function handleLogout() {
    await logout();
    queryClient.clear();
    navigate("/login", { replace: true });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors outline-none hover:bg-foreground/5 focus-visible:ring-3 focus-visible:ring-ring/50 data-[popup-open]:bg-foreground/5">
        <span className="flex size-8 items-center justify-center rounded-full border border-foreground/15 bg-foreground/10 text-xs font-semibold">
          {username.slice(0, 2).toUpperCase()}
        </span>
        <span className="text-sm font-medium">{username}</span>
        <ChevronDown className="size-4 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <p className="text-sm font-medium text-foreground">{username}</p>
            <p className="text-xs font-normal text-muted-foreground">
              {user ? ROLE_LABELS[user.role] : ""}
              {team ? ` · ${team.name}` : ""}
            </p>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate("/settings")}>
          <Settings />
          Configuración
        </DropdownMenuItem>
        {/* Conmutador de tema: el menú queda abierto para ver el cambio. */}
        <DropdownMenuItem closeOnClick={false} onClick={toggle} role="menuitemcheckbox" aria-checked={dark}>
          {dark ? <Moon /> : <Sun />}
          Modo oscuro
          <span
            aria-hidden
            className={cn(
              "ml-auto flex h-5 w-9 items-center rounded-full border border-foreground/15 p-0.5 transition-colors",
              dark ? "bg-violet-500/70" : "bg-foreground/10",
            )}
          >
            <span className={cn("size-3.5 rounded-full bg-background shadow transition-transform", dark && "translate-x-4")} />
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={handleLogout}>
          <LogOut />
          Salir
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
