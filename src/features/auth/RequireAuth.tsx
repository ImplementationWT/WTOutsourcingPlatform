import { useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { SESSION_KEY, useSession } from "./auth";
import ChangePasswordPage from "./ChangePasswordPage";

export default function RequireAuth() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const session = useSession();

  // Cualquier 401 de la API cierra la sesión local y vuelve al login.
  useEffect(() => {
    const onExpired = () => queryClient.setQueryData(SESSION_KEY, null);
    window.addEventListener("session-expired", onExpired);
    return () => window.removeEventListener("session-expired", onExpired);
  }, [queryClient]);

  if (session.isPending) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background text-muted-foreground">
        <Loader2 className="size-5 animate-spin" aria-label="Cargando sesión" />
      </div>
    );
  }

  if (!session.data) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  // Primer ingreso o contraseña restablecida: nada del panel hasta cambiarla.
  if (session.data.mustChangeCredentials) return <ChangePasswordPage forced />;

  return <Outlet />;
}
