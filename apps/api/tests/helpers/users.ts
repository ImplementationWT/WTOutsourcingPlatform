import { randomUUID } from "node:crypto";
import type { AdminStore } from "../../src/store/admin-store.js";
import type { UserRole } from "../../src/store/models.js";

/** Equipo de los tests: los proyectos que crean los tests le pertenecen. */
export const TEST_TEAM_ID = "11111111-1111-4111-8111-111111111111";
export const OTHER_TEAM_ID = "22222222-2222-4222-8222-222222222222";

/**
 * Siembra un equipo y un usuario (por defecto el team leader "admin" del equipo de los tests,
 * que opera los proyectos). En los tests la cuenta de la configuración es "jefe" (jefe, solo
 * lectura), así que "admin" sigue siendo quien aparece en la auditoría.
 */
export async function seedUser(
  store: AdminStore,
  passwordHash: string,
  { username = "admin", name, role = "lead", teamId = TEST_TEAM_ID, teamName }: { username?: string; name?: string; role?: UserRole; teamId?: string | null; teamName?: string } = {}
) {
  const at = new Date();
  if (teamId && !(await store.teams.findOne({ _id: teamId }))) {
    await store.teams.insertOne({ _id: teamId, name: teamName ?? (teamId === TEST_TEAM_ID ? "Equipo A" : `Equipo ${teamId.slice(0, 4)}`), leadUserId: null, createdAt: at, updatedAt: at });
  }
  const user = {
    _id: randomUUID(),
    username,
    name: name ?? username.charAt(0).toUpperCase() + username.slice(1),
    role,
    teamId: role === "boss" ? null : teamId,
    passwordHash,
    mustChangePassword: false,
    active: true,
    failedLogins: 0,
    createdBy: "tests",
    createdAt: at,
    updatedAt: at
  };
  await store.users.insertOne(user);
  return user;
}
