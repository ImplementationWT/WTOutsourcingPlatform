import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BriefcaseBusiness, Check, Code2, Copy, Crown, Info, Key, Landmark, Plus, Power, Search, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, type ChipColor } from "@/components/ui/chip";
import { useConfirm } from "@/components/ui/confirm-context";
import { Modal } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PersonAvatar } from "@/components/ui/person-avatar";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ROLE_LABELS, TEAMLESS_ROLES, useSession, type UserRole } from "@/features/auth/auth";
import { PageHeader } from "@/components/layout/PageHeader";
import { useCrumbs } from "@/components/layout/crumbs";
import { errorText, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { ADMIN_TEAMS_KEY, ADMIN_USERS_KEY, type AdminTeam, type AdminUser, createTeam, createUser, resetPassword, updateTeam, updateUser, useAdminTeams, useAdminUsers } from "./api";

/** Orden de los roles en el alta, los filtros y los selects. */
const ROLES: UserRole[] = ["boss", "lead", "developer", "commercial", "finance"];

const ROLE_META: Record<UserRole, { icon: typeof Crown; chip: ChipColor; filter: string; description: string; teamless: string }> = {
  boss: { icon: Crown, chip: "purple", filter: "CEO/CCO", description: "Ve y opera todos los proyectos.", teamless: "Sin equipo · ve todos los proyectos" },
  lead: { icon: Users, chip: "blue", filter: "Team leaders", description: "Lidera y opera los proyectos de su equipo.", teamless: "" },
  developer: { icon: Code2, chip: "gray", filter: "Developers", description: "Trabaja en los proyectos de su equipo.", teamless: "" },
  commercial: { icon: BriefcaseBusiness, chip: "amber", filter: "Comerciales", description: "Gestiona leads, propuestas y comunicaciones.", teamless: "Sin equipo · trabaja en Comercial" },
  finance: { icon: Landmark, chip: "brown", filter: "Financiera", description: "Gestiona invoices, pagos y comisiones.", teamless: "Sin equipo · trabaja en Financiera" },
};

/** Fondo y texto del select de rol: el mismo tono que su chip (developer queda neutro). */
const ROLE_SELECT: Record<UserRole, string> = {
  boss: "border-transparent! bg-[var(--chip-purple-bg)]! font-semibold text-[var(--chip-purple-fg)]",
  lead: "border-transparent! bg-[var(--chip-blue-bg)]! font-semibold text-[var(--chip-blue-fg)]",
  developer: "border-transparent! bg-muted! font-semibold",
  commercial: "border-transparent! bg-[var(--chip-amber-bg)]! font-semibold text-[var(--chip-amber-fg)]",
  finance: "border-transparent! bg-[var(--chip-brown-bg)]! font-semibold text-[var(--chip-brown-fg)]",
};

const plain = "border-transparent! bg-muted!";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,38}[a-z0-9]$/;

type Filter = "all" | UserRole | "inactive";

/** Pestaña subrayada con contador (mismo estilo que el detalle del lead). */
function UnderlineTab({ active, count, onClick, children }: { active: boolean; count: number; onClick: () => void; children: ReactNode }) {
  return (
    <button
      role="tab"
      type="button"
      aria-selected={active}
      onClick={onClick}
      className={cn("-mb-px mr-6 inline-flex h-[52px] shrink-0 items-center gap-2 border-b-2 px-1.5 text-[15px] whitespace-nowrap transition-colors", active ? "border-primary font-semibold text-foreground" : "border-transparent font-medium text-muted-foreground hover:text-foreground")}
    >
      {children}
      <span className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11.5px] tabular-nums", active ? "bg-accent-soft text-accent-text" : "bg-muted text-muted-foreground")}>{count}</span>
    </button>
  );
}

/** Filtro en forma de píldora con contador (mismo estilo que Propuestas). */
function FilterPill({ active, count, onClick, children }: { active: boolean; count: number; onClick: () => void; children: ReactNode }) {
  return (
    <button
      role="tab"
      type="button"
      aria-selected={active}
      onClick={onClick}
      className={cn("inline-flex h-10 items-center gap-2 rounded-full border px-3.5 text-sm", active ? "border-primary bg-accent-soft font-semibold text-accent-text" : "border-border bg-card font-medium hover:bg-muted")}
    >
      {children}
      <span className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs tabular-nums", active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>{count}</span>
    </button>
  );
}

/** Contraseña temporal: se muestra una sola vez para entregarla en persona. */
function TemporaryPasswordDialog({ value, onClose }: { value: { username: string; password: string }; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Contraseña temporal de ${value.username}`} description="Solo se muestra ahora. Entrégala por un canal seguro; deberá cambiarla en su primer ingreso." footer={<Button onClick={onClose}>Listo</Button>}>
      <div className="flex flex-wrap items-center gap-3">
        <code className="rounded-lg bg-muted px-3 py-2 font-mono text-base">{value.password}</code>
        <Button
          variant="outline"
          onClick={async () => {
            await navigator.clipboard?.writeText(value.password).catch(() => undefined);
            setCopied(true);
          }}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? "Copiada" : "Copiar"}
        </Button>
      </div>
    </Modal>
  );
}

/** Correo de la fila: «+ Agregar correo» si no tiene; clic para editar. */
function EmailCell({ user, disabled, onSave }: { user: AdminUser; disabled: boolean; onSave: (email: string | null) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(user.email ?? "");
  const bad = Boolean(value.trim()) && !EMAIL_RE.test(value.trim());
  const commit = async () => {
    const next = value.trim().toLowerCase() || null;
    if (bad) return;
    setEditing(false);
    if (next !== user.email) await onSave(next);
  };
  if (editing) {
    return (
      <Input
        autoFocus
        type="email"
        aria-label={`Correo de ${user.username}`}
        aria-invalid={bad || undefined}
        value={value}
        placeholder="nombre@whatever.tech"
        className="h-9 max-w-64"
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commit();
          if (e.key === "Escape") {
            setValue(user.email ?? "");
            setEditing(false);
          }
        }}
      />
    );
  }
  if (!user.email) {
    return (
      <button type="button" disabled={disabled} onClick={() => setEditing(true)} className="inline-flex h-8 items-center gap-1 rounded-lg border border-dashed border-line-strong px-2.5 text-sm font-medium text-accent-text hover:bg-accent-soft disabled:opacity-50">
        <Plus className="size-3.5" /> Agregar correo
      </button>
    );
  }
  return (
    <button type="button" disabled={disabled} title="Editar correo" onClick={() => setEditing(true)} className="max-w-full truncate rounded-md text-left hover:underline disabled:no-underline">
      {user.email}
    </button>
  );
}

function StatusChip({ user }: { user: AdminUser }) {
  if (!user.active) return <Chip color="gray">Inactivo</Chip>;
  if (user.locked) return <Chip color="red">Bloqueado</Chip>;
  if (user.mustChangeCredentials) return <Chip color="amber">Contraseña temporal</Chip>;
  return <Chip color="green">Activo</Chip>;
}

const COLS = "md:grid md:grid-cols-[minmax(9.5rem,1.5fr)_minmax(9.5rem,1.3fr)_minmax(8.5rem,0.85fr)_minmax(7rem,0.75fr)_minmax(10.75rem,0.9fr)_5.25rem] md:items-center md:gap-x-4";

function UserRow({ user, teams, self, onPassword }: { user: AdminUser; teams: AdminTeam[]; self: boolean; onPassword: (username: string, password: string) => void }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const teamless = TEAMLESS_ROLES.includes(user.role);
  const team = teams.find((t) => t.id === user.teamId);

  async function run(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    try {
      await fn();
      await Promise.all([queryClient.invalidateQueries({ queryKey: ADMIN_USERS_KEY }), queryClient.invalidateQueries({ queryKey: ADMIN_TEAMS_KEY }), queryClient.invalidateQueries({ queryKey: ["teams"] })]);
      if (done) toast.success(done);
    } catch (err) {
      toast.error("No se pudo guardar.", { description: errorText(err, "Inténtalo de nuevo.") });
    } finally {
      setBusy(false);
    }
  }

  const reset = async () => {
    const ok = await confirm({ title: `¿Restablecer la contraseña de ${user.name}?`, description: "Su contraseña actual deja de funcionar y se genera una temporal que deberá cambiar al entrar.", confirmLabel: "Restablecer", tone: "danger" });
    if (ok) await run(async () => onPassword(user.username, (await resetPassword(user.id)).temporaryPassword));
  };
  const toggle = async () => {
    if (user.active) {
      const ok = await confirm({ title: `¿Desactivar a ${user.name}?`, description: "Su sesión se corta al momento y no podrá entrar hasta que se active de nuevo.", confirmLabel: "Desactivar", tone: "danger" });
      if (!ok) return;
    }
    await run(() => updateUser(user.id, { active: !user.active }), user.active ? `${user.name} desactivado` : `${user.name} activado`);
  };

  const iconButton = "inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40";
  return (
    <li className={cn("grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2.5 border-t border-border px-4 py-3.5 sm:px-6", COLS)}>
      <div className="flex min-w-0 items-center gap-3">
        <PersonAvatar person={user} size={38} />
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-semibold">
            <span className="truncate">{user.name}</span>
            {self && <span className="inline-flex h-5 items-center rounded-full bg-muted px-2 text-[11px] font-semibold text-muted-foreground">Tú</span>}
          </p>
          <p className="truncate font-mono text-[13px] text-muted-foreground">{user.username}</p>
        </div>
      </div>
      <div className="flex items-center justify-end gap-1 md:order-last">
        <button type="button" className={iconButton} aria-label={`Restablecer la contraseña de ${user.username}`} title="Restablecer contraseña" disabled={busy || self} onClick={() => void reset()}>
          <Key className="size-[18px]" />
        </button>
        <button type="button" className={iconButton} aria-label={`${user.active ? "Desactivar" : "Activar"} a ${user.username}`} title={user.active ? "Desactivar" : "Activar"} disabled={busy || self} onClick={() => void toggle()}>
          <Power className="size-[18px]" />
        </button>
      </div>
      <div className="col-span-2 min-w-0 text-[15px] md:col-span-1">
        <EmailCell user={user} disabled={busy} onSave={(email) => run(() => updateUser(user.id, { email }), "Correo guardado")} />
      </div>
      {self ? (
        <span className={cn("flex h-control-sm items-center rounded-lg px-3 text-sm", ROLE_SELECT[user.role])}>{ROLE_LABELS[user.role]}</span>
      ) : (
        <Select
          label={`Rol de ${user.username}`}
          size="sm"
          className={ROLE_SELECT[user.role]}
          value={user.role}
          options={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
          disabled={busy}
          onValueChange={(v) => {
            const role = (v ?? user.role) as UserRole;
            // Pasar a team leader o developer exige equipo: se mantiene el actual o el primero.
            const teamId = TEAMLESS_ROLES.includes(role) ? null : (user.teamId ?? teams[0]?.id ?? null);
            void run(() => updateUser(user.id, { role, teamId }), "Rol actualizado");
          }}
        />
      )}
      {teamless || self ? (
        <span className={cn("flex h-control-sm items-center rounded-lg px-3 text-sm", plain)}>{teamless ? "—" : (team?.name ?? "—")}</span>
      ) : (
        <Select label={`Equipo de ${user.username}`} size="sm" className={plain} value={user.teamId ?? null} options={teams.map((t) => ({ value: t.id, label: t.name }))} disabled={busy} onValueChange={(v) => v && void run(() => updateUser(user.id, { teamId: v }), "Equipo actualizado")} />
      )}
      <div>
        <StatusChip user={user} />
      </div>
    </li>
  );
}

function PeopleTab({ users, teams, meId, onPassword }: { users: AdminUser[]; teams: AdminTeam[]; meId: string | undefined; onPassword: (username: string, password: string) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const counts = (f: Filter) => users.filter((u) => (f === "all" ? true : f === "inactive" ? !u.active : u.role === f)).length;
  const needle = q.trim().toLowerCase();
  const shown = users
    .filter((u) => (filter === "all" ? true : filter === "inactive" ? !u.active : u.role === filter))
    .filter((u) => !needle || [u.name, u.username, u.email ?? ""].some((v) => v.toLowerCase().includes(needle)))
    // Tú primero; luego por rol (CEO/CCO, team leaders, developers…) y nombre.
    .sort((a, b) => Number(b.id === meId) - Number(a.id === meId) || ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || a.name.localeCompare(b.name));
  const filters: Filter[] = ["all", ...ROLES.filter((r) => r === "boss" || r === "lead" || r === "developer" || counts(r) > 0), "inactive"];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3 xl:flex-nowrap">
        <div role="tablist" aria-label="Filtrar por rol" className="flex flex-wrap gap-2">
          {filters.map((f) => (
            <FilterPill key={f} active={filter === f} count={counts(f)} onClick={() => setFilter(f)}>
              {f === "all" ? "Todos" : f === "inactive" ? "Inactivos" : ROLE_META[f].filter}
            </FilterPill>
          ))}
        </div>
        <div className="relative w-full sm:ml-auto sm:w-80 xl:w-auto xl:max-w-sm xl:min-w-60 xl:flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input aria-label="Buscar personas" placeholder="Buscar por nombre, usuario o correo" value={q} onChange={(e) => setQ(e.target.value)} className="h-10 rounded-xl pl-10" />
        </div>
      </div>
      <p className="flex items-start gap-2.5 text-sm text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          <b className="font-semibold text-foreground">CEO/CCO</b> ve y opera todos los proyectos, sin equipo. <b className="font-semibold text-foreground">Team leader</b> y <b className="font-semibold text-foreground">developer</b> ven los de su equipo. Desactivar corta la sesión al momento.
        </span>
      </p>
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className={cn("hidden px-6 py-3.5", COLS)} aria-hidden>
          {["Persona", "Correo", "Rol", "Equipo", "Estado"].map((h) => (
            <span key={h} className="text-caps-label">{h}</span>
          ))}
          <span className="text-caps-label text-right">Acciones</span>
        </div>
        <ul aria-label="Personas" className="max-md:[&>li:first-child]:border-t-0">
          {shown.map((u) => (
            <UserRow key={u.id} user={u} teams={teams} self={u.id === meId} onPassword={onPassword} />
          ))}
        </ul>
        {!shown.length && <p className="border-t border-border px-6 py-10 text-center text-sm text-muted-foreground">{needle ? "Nadie coincide con la búsqueda." : "No hay personas aquí."}</p>}
      </div>
    </div>
  );
}

function TeamCard({ team, users }: { team: AdminTeam; users: AdminUser[] }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const members = users.filter((u) => u.teamId === team.id && u.active).sort((a, b) => Number(b.role === "lead") - Number(a.role === "lead") || a.name.localeCompare(b.name));
  const leads = members.filter((u) => u.role === "lead");
  const save = async (leadUserId: string | null) => {
    setBusy(true);
    try {
      await updateTeam(team.id, { leadUserId });
      await Promise.all([queryClient.invalidateQueries({ queryKey: ADMIN_TEAMS_KEY }), queryClient.invalidateQueries({ queryKey: ["teams"] })]);
      toast.success("Team leader actualizado");
    } catch (err) {
      toast.error("No se pudo guardar.", { description: errorText(err, "Inténtalo de nuevo.") });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label={team.name} className="rounded-2xl border border-border bg-card p-6">
      <div className="flex items-start gap-3.5">
        <span aria-hidden className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-lg font-bold text-accent-text">{team.name.replace(/^team\s+/i, "").charAt(0).toUpperCase()}</span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg leading-tight font-bold">{team.name}</h2>
          <p className="text-sm text-muted-foreground">
            {members.length} {members.length === 1 ? "persona" : "personas"}
          </p>
        </div>
        <span className="inline-flex h-7 shrink-0 items-center rounded-full bg-muted px-3 text-xs font-semibold text-muted-foreground tabular-nums">
          {team.projects} {team.projects === 1 ? "proyecto" : "proyectos"}
        </span>
      </div>
      <p className="text-caps-label mt-6 mb-2">Team leader</p>
      <Select label={`Team leader de ${team.name}`} className={cn("h-11", plain)} value={team.leadUserId ?? null} emptyLabel="Sin team leader" options={leads.map((u) => ({ value: u.id, label: u.name }))} disabled={busy} onValueChange={(v) => void save(v)} />
      <p className="text-caps-label mt-6 mb-2.5">Miembros</p>
      {members.length ? (
        <ul className="space-y-2.5">
          {members.map((u) => (
            <li key={u.id} className="flex items-center gap-3">
              <PersonAvatar person={u} size={30} />
              <span className="min-w-0 flex-1 truncate">{u.name}</span>
              <Chip color={u.role === "lead" ? "blue" : "gray"}>{ROLE_LABELS[u.role]}</Chip>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">Aún no tiene miembros. Asígnalos desde Personas.</p>
      )}
    </section>
  );
}

function NewUserDialog({ teams, onClose, onCreated }: { teams: AdminTeam[]; onClose: () => void; onCreated: (username: string, password: string) => void }) {
  const queryClient = useQueryClient();
  const [role, setRole] = useState<UserRole>("boss");
  const [teamId, setTeamId] = useState("");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const needsTeam = !TEAMLESS_ROLES.includes(role);
  const emailOk = !email.trim() || EMAIL_RE.test(email.trim());
  const valid = USERNAME_RE.test(username) && name.trim().length >= 2 && emailOk && (!needsTeam || Boolean(teamId));

  async function submit() {
    if (!valid) return;
    setBusy(true);
    try {
      const result = await createUser({ username, name: name.trim(), email: email.trim().toLowerCase() || null, role, teamId: needsTeam ? teamId : null });
      await Promise.all([queryClient.invalidateQueries({ queryKey: ADMIN_USERS_KEY }), queryClient.invalidateQueries({ queryKey: ADMIN_TEAMS_KEY })]);
      onCreated(result.user.username, result.temporaryPassword);
    } catch (err) {
      toast.error("No se pudo crear el usuario.", { description: errorText(err, "Inténtalo de nuevo.") });
    } finally {
      setBusy(false);
    }
  }

  const label = "text-caps-label mb-2 block";
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={<span className="text-xl font-bold">Nuevo usuario</span>}
      description="Crea una cuenta individual con su rol y equipo."
      dirty={Boolean(name || username || email)}
      className="max-w-3xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!valid} loading={busy} onClick={() => void submit()}>
            Crear usuario
          </Button>
        </>
      }
    >
      <div className="proto-form space-y-5">
        <div>
          <p id="new-role" className={label}>1. Rol</p>
          <div role="radiogroup" aria-labelledby="new-role" className="grid gap-3 sm:grid-cols-3">
            {ROLES.map((r) => {
              const Icon = ROLE_META[r].icon;
              const on = role === r;
              return (
                <button
                  key={r}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setRole(r)}
                  className={cn("flex flex-col items-start rounded-xl border p-4 text-left transition-colors", on ? "border-primary bg-accent-soft ring-3 ring-primary/15" : "border-border bg-card hover:bg-muted/60")}
                >
                  <span aria-hidden className={cn("flex size-9 items-center justify-center rounded-lg", on ? "bg-primary text-primary-foreground" : "bg-accent-soft text-accent-text")}>
                    <Icon className="size-[18px]" />
                  </span>
                  <span className={cn("mt-3 font-semibold", on && "text-accent-text")}>{ROLE_LABELS[r]}</span>
                  <span className="mt-1 text-sm text-muted-foreground">{ROLE_META[r].description}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="grid gap-x-4 gap-y-5 sm:grid-cols-2">
          <div>
            <label htmlFor="new-team" className={label}>2. Equipo</label>
            {needsTeam ? (
              <Select id="new-team" label="Equipo" className="h-11" value={teamId || null} emptyLabel={teams.length ? "Elige un equipo" : "Primero crea un equipo"} options={teams.map((t) => ({ value: t.id, label: t.name }))} disabled={!teams.length} onValueChange={(v) => setTeamId(v ?? "")} />
            ) : (
              <p id="new-team" className="flex h-11 items-center rounded-[10px] bg-muted px-3 text-sm text-muted-foreground">{ROLE_META[role].teamless}</p>
            )}
          </div>
          <div>
            <label htmlFor="new-name" className={label}>Nombre</label>
            <Input id="new-name" placeholder="Ana López" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </div>
          <div>
            <label htmlFor="new-username" className={label}>3. Usuario</label>
            <Input id="new-username" placeholder="ana.lopez" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/\s/g, ""))} autoComplete="off" aria-describedby="new-username-help" />
            <p id="new-username-help" className="mt-2 text-sm text-muted-foreground">Con este usuario entra a la plataforma.</p>
          </div>
          <div>
            <label htmlFor="new-email" className={label}>Correo (opcional)</label>
            <Input id="new-email" type="email" placeholder="ana@whatever.tech" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" aria-invalid={!emailOk || undefined} />
            {!emailOk && <p role="alert" className="mt-2 text-sm text-destructive">Revisa el correo.</p>}
          </div>
        </div>
        <p className="flex items-center gap-3 rounded-xl bg-muted px-4 py-3.5 text-sm text-muted-foreground">
          <Info className="size-4 shrink-0" aria-hidden />
          Al crearlo se genera una contraseña temporal. Deberá cambiarla en su primer ingreso.
        </p>
      </div>
    </Modal>
  );
}

function NewTeamDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = name.trim().length >= 2;
  async function submit() {
    if (!valid) return;
    setBusy(true);
    try {
      await createTeam({ name: name.trim() });
      await Promise.all([queryClient.invalidateQueries({ queryKey: ADMIN_TEAMS_KEY }), queryClient.invalidateQueries({ queryKey: ["teams"] })]);
      toast.success("Equipo creado");
      onClose();
    } catch (err) {
      toast.error("No se pudo crear el equipo.", { description: errorText(err, "Inténtalo de nuevo.") });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Nuevo equipo"
      description="Después asigna sus miembros desde Personas y elige su team leader."
      dirty={Boolean(name)}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!valid} loading={busy} onClick={() => void submit()}>
            Crear equipo
          </Button>
        </>
      }
    >
      <form
        className="proto-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="team-name" className="text-caps-label mb-2 block">Nombre</label>
        <Input id="team-name" autoFocus placeholder="Team A" value={name} onChange={(e) => setName(e.target.value)} />
      </form>
    </Modal>
  );
}

/** Administración de usuarios y equipos (solo CEO/CCO). */
export default function UsersPage() {
  useCrumbs([{ label: "Cuenta" }, { label: "Usuarios y equipos" }], { replace: true });
  const me = useSession().data;
  const users = useAdminUsers();
  const teams = useAdminTeams();
  const [tab, setTab] = useState<"people" | "teams">("people");
  const [dialog, setDialog] = useState<"user" | "team" | null>(null);
  const [password, setPassword] = useState<{ username: string; password: string } | null>(null);
  const showPassword = (username: string, value: string) => setPassword({ username, password: value });

  if (me && me.role !== "boss") {
    return <p className="text-sm text-muted-foreground">Solo los CEO/CCO administran usuarios y equipos.</p>;
  }

  return (
    <section className="space-y-6">
      <PageHeader
        title="Usuarios y equipos"
        description="Cuentas individuales, roles y equipos. Cada persona entra con su usuario y contraseña."
        actions={
          <Button size="lg" onClick={() => setDialog(tab === "people" ? "user" : "team")}>
            <Plus /> {tab === "people" ? "Nuevo usuario" : "Nuevo equipo"}
          </Button>
        }
      />
      <div role="tablist" aria-label="Secciones" className="flex border-b border-border">
        <UnderlineTab active={tab === "people"} count={users.data?.length ?? 0} onClick={() => setTab("people")}>
          Personas
        </UnderlineTab>
        <UnderlineTab active={tab === "teams"} count={teams.data?.length ?? 0} onClick={() => setTab("teams")}>
          Equipos
        </UnderlineTab>
      </div>

      {users.isLoading || teams.isLoading ? (
        <Skeleton className="h-64 rounded-2xl" />
      ) : users.isError || teams.isError ? (
        <p className="text-sm text-danger-fg">{(users.error ?? teams.error)?.message}</p>
      ) : tab === "people" ? (
        <PeopleTab users={users.data ?? []} teams={teams.data ?? []} meId={me?.id} onPassword={showPassword} />
      ) : (
        <div className="space-y-5">
          <p className="text-[15px] text-muted-foreground">Cada proyecto pertenece a un equipo. El líder debe ser un team leader de ese equipo.</p>
          {teams.data?.length ? (
            <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
              {teams.data.map((t) => (
                <TeamCard key={t.id} team={t} users={users.data ?? []} />
              ))}
            </div>
          ) : (
            <p className="rounded-2xl border border-dashed border-line-strong px-6 py-10 text-center text-sm text-muted-foreground">Aún no hay equipos. Crea el primero con «Nuevo equipo».</p>
          )}
        </div>
      )}

      {dialog === "user" && (
        <NewUserDialog
          teams={teams.data ?? []}
          onClose={() => setDialog(null)}
          onCreated={(username, value) => {
            setDialog(null);
            showPassword(username, value);
          }}
        />
      )}
      {dialog === "team" && <NewTeamDialog onClose={() => setDialog(null)} />}
      {password && <TemporaryPasswordDialog value={password} onClose={() => setPassword(null)} />}
    </section>
  );
}
