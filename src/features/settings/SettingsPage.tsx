import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ROLE_LABELS, useSession } from "@/features/auth/auth";
import { ChangePasswordForm } from "@/features/auth/ChangePasswordPage";
import { useTeams } from "@/features/admin/api";

export default function SettingsPage() {
  const user = useSession().data;
  const teams = useTeams();
  const team = teams.data?.find((t) => t.id === user?.teamId);

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Configuración</h1>
        <p className="mt-1 text-sm text-muted-foreground sm:text-base">Tu cuenta en la plataforma.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Cuenta</CardTitle>
            <CardDescription>Los datos los gestiona un CEO/CCO desde Usuarios y equipos.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
              <dt className="text-muted-foreground">Nombre</dt>
              <dd>{user?.name}</dd>
              <dt className="text-muted-foreground">Usuario</dt>
              <dd className="font-mono">{user?.username}</dd>
              <dt className="text-muted-foreground">Rol</dt>
              <dd>{user ? ROLE_LABELS[user.role] : ""}</dd>
              {user?.role !== "boss" && (
                <>
                  <dt className="text-muted-foreground">Equipo</dt>
                  <dd>{team?.name ?? (user?.teamId ? "…" : "Sin equipo")}</dd>
                </>
              )}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Contraseña</CardTitle>
            <CardDescription>Tras 5 intentos fallidos la cuenta se bloquea 15 minutos.</CardDescription>
          </CardHeader>
          <CardContent>
            <ChangePasswordForm />
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
