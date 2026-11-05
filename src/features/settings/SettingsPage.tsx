import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Key, Lock } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Chip, type ChipColor } from "@/components/ui/chip";
import { Modal } from "@/components/ui/dialog";
import { PersonAvatar } from "@/components/ui/person-avatar";
import { ROLE_LABELS, useSession, type UserRole } from "@/features/auth/auth";
import { ChangePasswordForm } from "@/features/auth/ChangePasswordPage";
import { useTeams } from "@/features/admin/api";
import { PageHeader } from "@/components/layout/PageHeader";
import { useCrumbs } from "@/components/layout/crumbs";
import { cn } from "@/lib/utils";
import { Panel } from "./Panel";
import { StageSlaCard } from "./StageSlaCard";

const ROLE_CHIP: Record<UserRole, ChipColor> = { boss: "purple", lead: "blue", developer: "gray", commercial: "amber", finance: "brown" };

function SecurityRow({ icon, tone, title, sub, action }: { icon: ReactNode; tone: "red" | "amber"; title: string; sub: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-4 py-5 first:pt-0 last:pb-0">
      <span aria-hidden className={cn("flex size-11 shrink-0 items-center justify-center rounded-xl", tone === "red" ? "chip-red" : "chip-amber")}>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{title}</p>
        <p className="font-subtitle text-[15px] text-muted-foreground">{sub}</p>
      </div>
      {action}
    </div>
  );
}

export default function SettingsPage() {
  useCrumbs([{ label: "Cuenta" }, { label: "Configuración" }], { replace: true });
  const user = useSession().data;
  const teams = useTeams();
  const team = teams.data?.find((t) => t.id === user?.teamId);
  const [changing, setChanging] = useState(false);
  const boss = user?.role === "boss";

  const rows: [string, ReactNode][] = user
    ? [
        ["Nombre", user.name],
        ["Usuario", <span className="font-mono font-bold">{user.username}</span>],
        ["Rol", ROLE_LABELS[user.role]],
        ...(boss ? [] : ([["Equipo", team?.name ?? (user.teamId ? "…" : "Sin equipo")]] as [string, ReactNode][])),
        ["Correo", user.email || <span className="text-muted-foreground">Sin correo</span>],
      ]
    : [];

  return (
    <section className="space-y-6">
      <PageHeader title="Configuración" description={boss ? "Tu cuenta y las reglas de la plataforma." : "Tu cuenta en la plataforma."} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel label="Tu cuenta">
          {user && (
            <>
              <div className="flex items-center gap-4 border-b border-border pb-5">
                <PersonAvatar person={user} size={52} />
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-xl leading-tight font-bold">{user.name}</h2>
                  <p className="truncate font-mono text-sm text-muted-foreground">{user.username}</p>
                </div>
                <Chip color={ROLE_CHIP[user.role]} className="h-7 px-3 text-[13px]">{ROLE_LABELS[user.role]}</Chip>
              </div>
              <dl className="divide-y divide-border border-b border-border">
                {rows.map(([dt, dd]) => (
                  <div key={dt} className="grid grid-cols-[7.5rem_1fr] items-center gap-4 py-4 text-[15px]">
                    <dt className="text-muted-foreground">{dt}</dt>
                    <dd className="min-w-0 truncate font-semibold">{dd}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-6 flex flex-wrap items-center gap-3 rounded-xl bg-muted px-5 py-4">
                <p className="min-w-0 flex-1 text-[15px] text-muted-foreground">Los datos los gestiona un CEO/CCO.</p>
                {boss && (
                  <Link to="/users" className={cn(buttonVariants({ variant: "outline" }), "bg-card")}>
                    Ir a Usuarios y equipos
                  </Link>
                )}
              </div>
            </>
          )}
        </Panel>

        <Panel label="Seguridad">
          <h2 className="text-xl leading-tight font-bold">Seguridad</h2>
          <p className="font-subtitle mt-1.5 text-[15px] text-muted-foreground">Acceso a tu cuenta.</p>
          <div className="mt-6 divide-y divide-border">
            <SecurityRow
              icon={<Key className="size-5" />}
              tone="red"
              title="Contraseña"
              sub="Mínimo 10 caracteres."
              action={
                <Button variant="outline" size="lg" onClick={() => setChanging(true)}>
                  Cambiar contraseña
                </Button>
              }
            />
            <SecurityRow icon={<Lock className="size-5" />} tone="amber" title="Bloqueo por intentos" sub="Tras 5 intentos fallidos la cuenta se bloquea 15 minutos." />
          </div>
        </Panel>

        {boss && <StageSlaCard />}
      </div>

      {changing && (
        <Modal open onOpenChange={(o) => !o && setChanging(false)} title="Cambiar contraseña" description="Mínimo 10 caracteres y distinta de tu usuario.">
          <ChangePasswordForm onDone={() => setChanging(false)} />
        </Modal>
      )}
    </section>
  );
}
