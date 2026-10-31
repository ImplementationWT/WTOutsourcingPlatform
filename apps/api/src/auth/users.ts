import { randomBytes, randomUUID } from "node:crypto";
import { MongoServerError } from "mongodb";
import type { AdminStore } from "../store/admin-store.js";
import { TEAMLESS_ROLES, type TeamDoc, type UserDoc, type UserRole } from "../store/models.js";
import { hashPassword, verifyPassword } from "./password.js";

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 128;
/** Intentos fallidos seguidos antes de bloquear la cuenta, y cuánto dura el bloqueo. */
export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;

export class UserDirectoryError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** Lo que se sabe del usuario de la sesión (nunca el hash). */
export interface SessionUser {
  id: string;
  username: string;
  name: string;
  role: UserRole;
  teamId: string | null;
  /**
   * Debe cambiar la contraseña antes de usar el panel. En la API se llama así (y no
   * mustChangePassword) porque la redacción global oculta cualquier clave con "password".
   */
  mustChangeCredentials: boolean;
}

export const toSessionUser = (user: UserDoc): SessionUser => ({
  id: user._id,
  username: user.username,
  name: user.name,
  role: user.role,
  teamId: user.teamId,
  mustChangeCredentials: user.mustChangePassword
});

/** Mensaje en español con la primera regla incumplida, o null. */
export function passwordPolicyError(password: string, username: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `La contraseña debe tener como máximo ${MAX_PASSWORD_LENGTH} caracteres.`;
  if (password.toLowerCase() === username.toLowerCase()) return "La contraseña no puede ser igual al usuario.";
  return null;
}

/** Contraseña temporal legible (se muestra una vez y obliga a cambiarla). */
function temporaryPassword() {
  return randomBytes(12).toString("base64url");
}

const isDuplicateKey = (error: unknown) => error instanceof MongoServerError && error.code === 11000;
const publicUser = (user: UserDoc) => {
  return {
    id: user._id,
    username: user.username,
    name: user.name,
    email: user.email ?? null,
    role: user.role,
    teamId: user.teamId,
    active: user.active,
    mustChangeCredentials: user.mustChangePassword,
    locked: Boolean(user.lockedUntil && user.lockedUntil > new Date()),
    lastLoginAt: user.lastLoginAt ?? null,
    createdAt: user.createdAt
  };
};

/**
 * Usuarios del panel y equipos. Contraseñas con scrypt (auth/password.ts); nunca se guardan ni
 * se registran en claro: las temporales se devuelven una sola vez en la respuesta.
 */
export class UserDirectory {
  constructor(
    private readonly store: AdminStore,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** ¿Hay ya usuarios? Mientras no los haya se acepta la cuenta admin de la configuración. */
  async hasUsers() {
    return (await this.store.users.countDocuments({}, { limit: 1 })) > 0;
  }

  /**
   * Migración (idempotente): en el primer arranque, la cuenta admin de la configuración pasa a ser
   * un usuario jefe con su misma contraseña. Si ya hay usuarios no hace nada.
   */
  async bootstrapFromConfig(adminUsername: string, adminPasswordHash: string) {
    if (await this.hasUsers()) return false;
    const at = this.now();
    try {
      await this.store.users.insertOne({
        _id: randomUUID(),
        username: adminUsername.trim().toLowerCase(),
        name: adminUsername.trim(),
        role: "boss",
        teamId: null,
        passwordHash: adminPasswordHash,
        mustChangePassword: false,
        active: true,
        failedLogins: 0,
        createdBy: "sistema",
        createdAt: at,
        updatedAt: at
      });
    } catch (error) {
      // Dos instancias arrancando a la vez: la otra ya lo creó.
      if (isDuplicateKey(error)) return false;
      throw error;
    }
    await this.store.audit({ actor: "sistema", action: "user.migrated_from_config", clientId: "platform", target: adminUsername.trim().toLowerCase() });
    return true;
  }

  async findById(id: string) {
    return this.store.users.findOne({ _id: id });
  }

  /**
   * Comprueba usuario y contraseña. Tras MAX_FAILED_LOGINS fallos seguidos la cuenta queda
   * bloqueada LOCK_MINUTES (aunque después acierte). Devuelve el usuario o un motivo.
   */
  async authenticate(username: string, password: string): Promise<{ user: UserDoc } | { error: "invalid" | "locked" }> {
    const user = await this.store.users.findOne({ username: username.trim().toLowerCase() });
    // Sin usuario también se calcula un hash, para no delatar por tiempos qué usuarios existen.
    const ok = await verifyPassword(password, user?.passwordHash ?? "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(86) + "==");
    if (!user || !user.active) return { error: "invalid" };
    const now = this.now();
    if (user.lockedUntil && user.lockedUntil > now) return { error: "locked" };
    if (!ok) {
      const failedLogins = (user.lockedUntil && user.lockedUntil <= now ? 0 : user.failedLogins ?? 0) + 1;
      const lock = failedLogins >= MAX_FAILED_LOGINS ? { lockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60_000) } : {};
      await this.store.users.updateOne({ _id: user._id }, { $set: { failedLogins: lock.lockedUntil ? 0 : failedLogins, ...lock } });
      if (lock.lockedUntil) {
        await this.store.audit({ actor: user.username, action: "user.locked", clientId: "platform", target: user.username });
        return { error: "locked" };
      }
      return { error: "invalid" };
    }
    await this.store.users.updateOne({ _id: user._id }, { $set: { failedLogins: 0, lastLoginAt: now }, $unset: { lockedUntil: "" } });
    return { user };
  }

  /** Cambio de contraseña propio (también el obligatorio del primer ingreso). */
  async changeOwnPassword(userId: string, current: string, next: string) {
    const user = await this.findById(userId);
    if (!user || !user.active) throw new UserDirectoryError(401, "Sesión no válida.");
    if (!(await verifyPassword(current, user.passwordHash))) throw new UserDirectoryError(400, "La contraseña actual no es correcta.");
    const policy = passwordPolicyError(next, user.username);
    if (policy) throw new UserDirectoryError(400, policy);
    if (current === next) throw new UserDirectoryError(400, "La nueva contraseña debe ser distinta de la actual.");
    await this.store.users.updateOne(
      { _id: user._id },
      { $set: { passwordHash: await hashPassword(next), mustChangePassword: false, updatedAt: this.now() } }
    );
    await this.store.audit({ actor: user.username, action: "user.password_changed", clientId: "platform", target: user.username });
  }

  // ---- administración (solo jefes) ----------------------------------------------------

  async listUsers() {
    return (await this.store.users.find().sort({ role: 1, username: 1 }).toArray()).map(publicUser);
  }

  private async requireTeam(teamId: string | null | undefined, role: UserRole) {
    if (TEAMLESS_ROLES.includes(role)) return null;
    if (!teamId) throw new UserDirectoryError(400, "Los team leaders y developers necesitan un equipo.");
    if (!(await this.store.teams.findOne({ _id: teamId }))) throw new UserDirectoryError(400, "El equipo no existe.");
    return teamId;
  }

  /**
   * Un Team Leader con correo: las reuniones sin equipo donde participó pasan a su equipo (las que
   * llegaron antes de que se cargara su correo).
   */
  private async claimMeetings(user: Pick<UserDoc, "role" | "email" | "teamId" | "active">) {
    if (user.role !== "lead" || !user.email || !user.teamId || !user.active) return;
    await this.store.meetings.updateMany({ teamId: null, "participants.email": user.email }, { $set: { teamId: user.teamId } });
  }

  /** Alta con contraseña temporal (se devuelve una vez; debe cambiarla al entrar). */
  async createUser(input: { username: string; name: string; email?: string | null; role: UserRole; teamId?: string | null }, actor: string) {
    const username = input.username.trim().toLowerCase();
    const teamId = await this.requireTeam(input.teamId, input.role);
    const password = temporaryPassword();
    const at = this.now();
    const user: UserDoc = {
      _id: randomUUID(),
      username,
      name: input.name.trim(),
      email: input.email ?? null,
      role: input.role,
      teamId,
      passwordHash: await hashPassword(password),
      mustChangePassword: true,
      active: true,
      failedLogins: 0,
      createdBy: actor,
      createdAt: at,
      updatedAt: at
    };
    try {
      await this.store.users.insertOne(user);
    } catch (error) {
      if (isDuplicateKey(error)) throw new UserDirectoryError(409, input.email && (await this.store.users.findOne({ email: input.email })) ? `El correo ${input.email} ya es de otro usuario.` : `Ya existe el usuario ${username}.`);
      throw error;
    }
    await this.claimMeetings(user);
    await this.store.audit({ actor, action: "user.created", clientId: "platform", target: username, details: { role: user.role, ...(teamId ? { teamId } : {}) } });
    return { user: publicUser(user), temporaryPassword: password };
  }

  async updateUser(id: string, patch: { name?: string; email?: string | null; role?: UserRole; teamId?: string | null; active?: boolean }, actor: { id: string; username: string }) {
    const user = await this.findById(id);
    if (!user) throw new UserDirectoryError(404, "Usuario no encontrado.");
    if (id === actor.id && (patch.active === false || (patch.role && patch.role !== "boss"))) {
      throw new UserDirectoryError(400, "No puedes desactivarte ni quitarte el rol de CEO/CCO a ti mismo.");
    }
    const role = patch.role ?? user.role;
    const teamId = await this.requireTeam(patch.teamId === undefined ? user.teamId : patch.teamId, role);
    // Siempre queda al menos un jefe activo.
    if (user.role === "boss" && (role !== "boss" || patch.active === false)) {
      const bosses = await this.store.users.countDocuments({ role: "boss", active: true, _id: { $ne: id } });
      if (!bosses) throw new UserDirectoryError(400, "Debe quedar al menos un CEO/CCO activo.");
    }
    const set = {
      role,
      teamId,
      updatedAt: this.now(),
      ...(patch.name ? { name: patch.name.trim() } : {}),
      ...(patch.email === undefined ? {} : { email: patch.email }),
      ...(patch.active === undefined ? {} : { active: patch.active })
    };
    try {
      await this.store.users.updateOne({ _id: id }, { $set: set });
    } catch (error) {
      if (isDuplicateKey(error)) throw new UserDirectoryError(409, `El correo ${patch.email} ya es de otro usuario.`);
      throw error;
    }
    await this.claimMeetings({ ...user, ...set });
    await this.store.audit({
      actor: actor.username,
      action: patch.active === false ? "user.deactivated" : patch.active === true ? "user.activated" : "user.updated",
      clientId: "platform",
      target: user.username,
      details: { role, ...(teamId ? { teamId } : {}) }
    });
    return publicUser({ ...user, ...set });
  }

  /** Nueva contraseña temporal (se devuelve una vez); desbloquea la cuenta. */
  async resetPassword(id: string, actor: string) {
    const user = await this.findById(id);
    if (!user) throw new UserDirectoryError(404, "Usuario no encontrado.");
    const password = temporaryPassword();
    await this.store.users.updateOne(
      { _id: id },
      { $set: { passwordHash: await hashPassword(password), mustChangePassword: true, failedLogins: 0, updatedAt: this.now() }, $unset: { lockedUntil: "" } }
    );
    await this.store.audit({ actor, action: "user.password_reset", clientId: "platform", target: user.username });
    return { temporaryPassword: password };
  }

  async listTeams() {
    const [teams, counts] = await Promise.all([
      this.store.teams.find().sort({ name: 1 }).toArray(),
      this.store.clients.aggregate<{ _id: string; count: number }>([{ $match: { teamId: { $type: "string" } } }, { $group: { _id: "$teamId", count: { $sum: 1 } } }]).toArray()
    ]);
    const byTeam = new Map(counts.map((c) => [c._id, c.count]));
    return teams.map((team) => ({ id: team._id, name: team.name, leadUserId: team.leadUserId, projects: byTeam.get(team._id) ?? 0, createdAt: team.createdAt }));
  }

  async createTeam(input: { name: string; leadUserId?: string | null }, actor: string) {
    const at = this.now();
    const team: TeamDoc = { _id: randomUUID(), name: input.name.trim(), leadUserId: null, createdAt: at, updatedAt: at };
    try {
      await this.store.teams.insertOne(team);
    } catch (error) {
      if (isDuplicateKey(error)) throw new UserDirectoryError(409, `Ya existe el equipo ${team.name}.`);
      throw error;
    }
    await this.store.audit({ actor, action: "team.created", clientId: "platform", target: team.name });
    if (input.leadUserId) await this.updateTeam(team._id, { leadUserId: input.leadUserId }, actor);
    return { id: team._id, name: team.name };
  }

  /** Renombrar o asignar líder (un team leader de ese mismo equipo). */
  async updateTeam(id: string, patch: { name?: string; leadUserId?: string | null }, actor: string) {
    const team = await this.store.teams.findOne({ _id: id });
    if (!team) throw new UserDirectoryError(404, "Equipo no encontrado.");
    if (patch.leadUserId) {
      const lead = await this.findById(patch.leadUserId);
      if (!lead || lead.role !== "lead" || lead.teamId !== id) {
        throw new UserDirectoryError(400, "El líder debe ser un team leader de ese equipo.");
      }
    }
    const set = { updatedAt: this.now(), ...(patch.name ? { name: patch.name.trim() } : {}), ...(patch.leadUserId === undefined ? {} : { leadUserId: patch.leadUserId }) };
    try {
      await this.store.teams.updateOne({ _id: id }, { $set: set });
    } catch (error) {
      if (isDuplicateKey(error)) throw new UserDirectoryError(409, "Ya existe un equipo con ese nombre.");
      throw error;
    }
    await this.store.audit({ actor, action: "team.updated", clientId: "platform", target: set.name ?? team.name });
  }

  /** Mueve un proyecto a otro equipo (o lo deja sin equipo). */
  async moveClient(slug: string, teamId: string | null, actor: string) {
    const client = await this.store.getClient(slug);
    if (!client) throw new UserDirectoryError(404, "Proyecto no encontrado.");
    if (teamId && !(await this.store.teams.findOne({ _id: teamId }))) throw new UserDirectoryError(400, "El equipo no existe.");
    await this.store.clients.updateOne({ _id: slug }, { $set: { teamId, updatedAt: this.now() } });
    await this.store.audit({ actor, action: "client.team_changed", clientId: slug, target: slug, details: { from: client.teamId ?? "", to: teamId ?? "" } });
  }
}
