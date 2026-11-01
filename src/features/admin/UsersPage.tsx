import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Loader2, Lock, Plus, Power, UserPlus, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { EditableText } from "@/components/ui/editable";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ROLE_LABELS, TEAMLESS_ROLES, useSession, type UserRole } from "@/features/auth/auth";
import { cn } from "@/lib/utils";
import {
  ADMIN_TEAMS_KEY,
  ADMIN_USERS_KEY,
  type AdminTeam,
  type AdminUser,
  createTeam,
  createUser,
  resetPassword,
  updateTeam,
  updateUser,
  useAdminTeams,
  useAdminUsers,
} from "./api";
import { PageHeader } from "@/components/layout/PageHeader";
import { useCrumbs } from "@/components/layout/crumbs";

const ROLES: UserRole[] = ["developer", "lead", "commercial", "finance", "boss"];

/** Contraseña temporal: se muestra una sola vez para entregarla en persona. */
function TemporaryPassword({ username, password, onClose }: { username: string; password: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div role="status" className="rounded-lg border border-warn/30 bg-warn/10 p-4 text-sm">
      <p className="font-medium">Contraseña temporal de {username}</p>
      <p className="mt-1 text-muted-foreground">Solo se muestra ahora. Entrégala por un canal seguro; tendrá que cambiarla al entrar.</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="rounded-md border border-foreground/15 bg-foreground/5 px-2 py-1 font-mono">{password}</code>
        <Button
          size="xs"
          variant="outline"
          onClick={async () => {
            await navigator.clipboard?.writeText(password).catch(() => undefined);
            setCopied(true);
          }}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? "Copiada" : "Copiar"}
        </Button>
        <Button size="xs" variant="ghost" onClick={onClose}>
          Listo
        </Button>
      </div>
    </div>
  );
}

function TeamsCard({ teams, users }: { teams: AdminTeam[]; users: AdminUser[] }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: ADMIN_TEAMS_KEY });
      await queryClient.invalidateQueries({ queryKey: ["teams"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="size-4 text-brand-300" />
          Equipos
        </CardTitle>
        <CardDescription>Cada proyecto pertenece a un equipo. El líder debe ser un team leader de ese equipo.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="divide-y divide-foreground/10 rounded-lg border">
          {teams.map((team) => {
            const leads = users.filter((u) => u.role === "lead" && u.teamId === team.id && u.active);
            return (
              <li key={team.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1 font-medium">{team.name}</span>
                <span className="text-muted-foreground tabular-nums">
                  {team.projects} {team.projects === 1 ? "proyecto" : "proyectos"}
                </span>
                <Select
                  label={`Líder de ${team.name}`}
                  size="sm" className="w-auto min-w-40"
                  value={team.leadUserId ?? null}
                  emptyLabel="Sin líder"
                  options={leads.map((u) => ({ value: u.id, label: u.name }))}
                  disabled={busy !== null}
                  onValueChange={(v) => run(team.id, () => updateTeam(team.id, { leadUserId: v }))}
                />
                {busy === team.id && <Loader2 className="size-4 animate-spin" />}
              </li>
            );
          })}
          {!teams.length && <li className="px-3 py-2.5 text-sm text-muted-foreground">Aún no hay equipos.</li>}
        </ul>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim().length >= 2) void run("new", async () => {
              await createTeam({ name: name.trim() });
              setName("");
            });
          }}
        >
          <Input aria-label="Nombre del equipo nuevo" placeholder="Nombre del equipo" value={name} onChange={(e) => setName(e.target.value)} className="max-w-xs" />
          <Button size="sm" type="submit" disabled={busy !== null || name.trim().length < 2}>
            {busy === "new" ? <Loader2 className="animate-spin" /> : <Plus />}
            Crear equipo
          </Button>
        </form>
        {error && <p className="text-sm text-danger-fg">{error}</p>}
      </CardContent>
    </Card>
  );
}

function NewUserForm({ teams, onCreated }: { teams: AdminTeam[]; onCreated: (username: string, password: string) => void }) {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<UserRole>("developer");
  const [teamId, setTeamId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsTeam = !TEAMLESS_ROLES.includes(role);
  const emailOk = !email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const valid = /^[a-z0-9][a-z0-9._-]{1,38}[a-z0-9]$/.test(username) && name.trim().length >= 2 && emailOk && (!needsTeam || teamId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createUser({ username, name: name.trim(), email: email.trim().toLowerCase() || null, role, teamId: needsTeam ? teamId : null });
      onCreated(result.user.username, result.temporaryPassword);
      setUsername("");
      setName("");
      setEmail("");
      await queryClient.invalidateQueries({ queryKey: ADMIN_USERS_KEY });
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo crear el usuario.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-foreground/10 p-4">
      <p className="text-sm font-medium">Nuevo usuario</p>
      {/* Primero el rol y el equipo (los CEO/CCO no tienen equipo); después, quién es. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5">
          <Label htmlFor="new-role">1. Rol</Label>
          <Select
            id="new-role"
            value={role}
            options={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
            onValueChange={(v) => setRole((v ?? "") as UserRole)}
          />
        </div>
        {needsTeam ? (
          <div className="space-y-1.5">
            <Label htmlFor="new-team">2. Equipo</Label>
            <Select
              id="new-team"
              value={teamId || null}
              emptyLabel={teams.length ? "Elige un equipo" : "Primero crea un equipo"}
              options={teams.map((t) => ({ value: t.id, label: t.name }))}
              disabled={!teams.length}
              onValueChange={(v) => setTeamId((v ?? ""))}
            />
          </div>
        ) : (
          <div className="space-y-1.5">
            <p className="text-sm font-medium">2. Equipo</p>
            <p className="flex h-8 items-center text-sm text-muted-foreground">{role === "boss" ? "Sin equipo: ve y opera todos." : "Sin equipo: trabaja en su área."}</p>
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="new-username">3. Usuario</Label>
          <Input id="new-username" placeholder="ana.lopez" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} autoComplete="off" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new-name">Nombre</Label>
          <Input id="new-name" placeholder="Ana López" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="new-email">Correo{role === "lead" ? "" : " (opcional)"}</Label>
          <Input id="new-email" type="email" placeholder="ana@empresa.com" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" aria-invalid={!emailOk || undefined} />
          {role === "lead" && <p className="text-xs text-muted-foreground">Con el correo del Team Leader, sus reuniones de Read.ai se asignan solas a su equipo.</p>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy || !valid}>
          {busy ? <Loader2 className="animate-spin" /> : <UserPlus />}
          Crear usuario
        </Button>
        {needsTeam && !teamId && <span className="text-xs text-muted-foreground">Asigna un equipo antes de crear el usuario.</span>}
      </div>
      {error && <p className="text-sm text-danger-fg">{error}</p>}
    </form>
  );
}

function UserRow({ user, teams, self, onPassword }: { user: AdminUser; teams: AdminTeam[]; self: boolean; onPassword: (username: string, password: string) => void }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: ADMIN_USERS_KEY });
      await queryClient.invalidateQueries({ queryKey: ADMIN_TEAMS_KEY });
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className={cn("space-y-1 px-3 py-3 text-sm", !user.active && "opacity-60")}>
      {/* En pantallas grandes, columnas fijas: rol, equipo y acciones quedan alineados entre filas. */}
      <div className="flex flex-wrap items-center gap-3 lg:grid lg:grid-cols-[minmax(0,1fr)_11rem_9.5rem_9.5rem_12.5rem_7rem]">
        <div className="min-w-40 flex-1 lg:min-w-0">
          <p className="font-medium">
            {user.name} {self && <span className="text-xs font-normal text-muted-foreground">(tú)</span>}
          </p>
          <p className="font-mono text-xs text-muted-foreground">{user.username}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 lg:justify-end">
          {!user.active && <Badge variant="outline">Desactivado</Badge>}
          {user.locked && (
            <Badge variant="outline">
              <Lock />
              Bloqueado
            </Badge>
          )}
          {user.mustChangeCredentials && user.active && <Badge variant="outline">Contraseña temporal</Badge>}
        </div>
        <Select
          label={`Rol de ${user.username}`}
          value={user.role}
          options={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
          disabled={busy !== null || self}
          onValueChange={(v) => {
            const role = (v ?? "") as UserRole;
            // Pasar a lead/developer exige equipo: se mantiene el actual o el primero.
            const teamId = TEAMLESS_ROLES.includes(role) ? null : (user.teamId ?? teams[0]?.id ?? null);
            void run("role", () => updateUser(user.id, { role, teamId }));
          }}
        />
        <Select
          label={`Equipo de ${user.username}`}
          value={user.teamId ?? null}
          emptyLabel={TEAMLESS_ROLES.includes(user.role) ? "Sin equipo" : undefined}
          options={teams.map((t) => ({ value: t.id, label: t.name }))}
          disabled={busy !== null || TEAMLESS_ROLES.includes(user.role)}
          onValueChange={(v) => void run("team", () => updateUser(user.id, { teamId: v }))}
        />
        <Button
          size="xs"
          variant="outline"
          className="lg:justify-self-start"
          disabled={busy !== null}
          onClick={() => run("reset", async () => onPassword(user.username, (await resetPassword(user.id)).temporaryPassword))}
        >
          {busy === "reset" ? <Loader2 className="animate-spin" /> : <KeyRound />}
          Restablecer contraseña
        </Button>
        {self ? (
          <span aria-hidden className="hidden lg:block" />
        ) : (
          <Button size="xs" variant="ghost" className="lg:justify-self-start" disabled={busy !== null} onClick={() => run("active", () => updateUser(user.id, { active: !user.active }))}>
            {busy === "active" ? <Loader2 className="animate-spin" /> : <Power />}
            {user.active ? "Desactivar" : "Activar"}
          </Button>
        )}
      </div>
      <div className="-ml-2 max-w-sm">
        <EditableText
          label={`Correo de ${user.username}`}
          type="email"
          value={user.email}
          placeholder={user.role === "lead" ? "Agregar correo (clasifica sus reuniones)" : "Agregar correo"}
          className="text-xs"
          disabled={busy !== null}
          onSave={(v) => run("email", () => updateUser(user.id, { email: v?.toLowerCase() ?? null }))}
        />
      </div>
      {error && <p className="text-xs text-danger-fg">{error}</p>}
    </li>
  );
}

/** Administración de usuarios y equipos (solo CEO/CCO). */
export default function UsersPage() {
  useCrumbs([{ label: "Usuarios y equipos" }], { replace: true });
  const me = useSession().data;
  const users = useAdminUsers();
  const teams = useAdminTeams();
  const [password, setPassword] = useState<{ username: string; password: string } | null>(null);
  const showPassword = (username: string, value: string) => setPassword({ username, password: value });

  if (me && me.role !== "boss") {
    return <p className="text-sm text-muted-foreground">Solo los CEO/CCO administran usuarios y equipos.</p>;
  }

  return (
    <section className="space-y-6">
      <PageHeader title="Usuarios y equipos" description="Cuentas individuales, roles y equipos. Cada persona entra con su usuario y contraseña." />

      {users.isLoading || teams.isLoading ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : users.isError || teams.isError ? (
        <p className="text-sm text-danger-fg">{(users.error ?? teams.error)?.message}</p>
      ) : (
        <>
          <TeamsCard teams={teams.data ?? []} users={users.data ?? []} />
          <Card>
            <CardHeader>
              <CardTitle>Personas</CardTitle>
              <CardDescription>
                CEO/CCO: ve y opera todos los proyectos, sin equipo. Team leader y developer: los de su equipo. Desactivar corta la
                sesión al momento.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <NewUserForm teams={teams.data ?? []} onCreated={showPassword} />
              {password && <TemporaryPassword {...password} onClose={() => setPassword(null)} />}
              <ul className="divide-y divide-foreground/10 rounded-lg border">
                {users.data?.map((user) => (
                  <UserRow key={user.id} user={user} teams={teams.data ?? []} self={user.id === me?.id} onPassword={showPassword} />
                ))}
              </ul>
            </CardContent>
          </Card>
        </>
      )}
    </section>
  );
}
