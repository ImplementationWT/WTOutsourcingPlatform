import { z } from "zod";
import type { AdminStore } from "../store/admin-store.js";
import { TEAMLESS_ROLES } from "../store/models.js";
import { UserDirectory, UserDirectoryError } from "./users.js";

const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{1,38}[a-z0-9]$/, "Usuario de 3 a 40 caracteres: minúsculas, números, punto, guion o guion bajo.");

/** Equipos y personas a dar de alta (lo mismo que se haría a mano en Usuarios). */
export const rosterSchema = z
  .object({
    teams: z.array(z.object({ name: z.string().trim().min(2).max(60), lead: username.optional() }).strict()).max(50),
    users: z
      .array(
        z
          .object({
            username,
            name: z.string().trim().min(2).max(80),
            role: z.enum(["boss", "commercial", "finance", "lead", "developer"]),
            team: z.string().trim().min(2).max(60).optional()
          })
          .strict()
      )
      .max(500)
  })
  .strict()
  .superRefine((roster, ctx) => {
    const teams = new Set(roster.teams.map((t) => t.name));
    const seen = new Set<string>();
    roster.users.forEach((user, i) => {
      if (seen.has(user.username)) ctx.addIssue({ code: "custom", path: ["users", i, "username"], message: `Usuario repetido: ${user.username}.` });
      seen.add(user.username);
      const teamless = TEAMLESS_ROLES.includes(user.role);
      if (teamless && user.team) ctx.addIssue({ code: "custom", path: ["users", i, "team"], message: `${user.username}: ese rol no lleva equipo.` });
      if (!teamless && !user.team) ctx.addIssue({ code: "custom", path: ["users", i, "team"], message: `${user.username}: necesita un equipo.` });
      if (user.team && !teams.has(user.team)) ctx.addIssue({ code: "custom", path: ["users", i, "team"], message: `${user.username}: el equipo «${user.team}» no está en la lista.` });
    });
    roster.teams.forEach((team, i) => {
      const lead = team.lead ? roster.users.find((u) => u.username === team.lead) : undefined;
      if (team.lead && (!lead || lead.role !== "lead" || lead.team !== team.name)) {
        ctx.addIssue({ code: "custom", path: ["teams", i, "lead"], message: `${team.name}: el líder debe ser un team leader de ese equipo.` });
      }
    });
  });

export type Roster = z.infer<typeof rosterSchema>;

export interface RosterResult {
  teams: { name: string; status: "created" | "exists" }[];
  users: { username: string; name: string; status: "created" | "exists" | "conflict"; temporaryPassword?: string; message?: string }[];
  leads: { team: string; status: "set" | "unchanged" | "conflict"; message?: string }[];
}

/**
 * Da de alta equipos y personas con las mismas reglas que el panel (UserDirectory): contraseña
 * temporal que se cambia al entrar, auditoría y validación de equipos. Se puede repetir: lo que ya
 * existe igual se deja; lo que existe distinto se informa y no se toca.
 */
export async function applyRoster(store: AdminStore, roster: Roster, actor: string): Promise<RosterResult> {
  const directory = new UserDirectory(store);
  const result: RosterResult = { teams: [], users: [], leads: [] };
  const teamIds = new Map<string, string>();

  for (const team of roster.teams) {
    const existing = await store.teams.findOne({ name: team.name });
    if (existing) {
      teamIds.set(team.name, existing._id);
      result.teams.push({ name: team.name, status: "exists" });
    } else {
      teamIds.set(team.name, (await directory.createTeam({ name: team.name }, actor)).id);
      result.teams.push({ name: team.name, status: "created" });
    }
  }

  for (const person of roster.users) {
    const teamId = person.team ? teamIds.get(person.team)! : null;
    const existing = await store.users.findOne({ username: person.username });
    if (existing) {
      const same = existing.role === person.role && (existing.teamId ?? null) === teamId;
      result.users.push(
        same
          ? { username: person.username, name: existing.name, status: "exists" }
          : { username: person.username, name: existing.name, status: "conflict", message: "Ya existe con otro rol o equipo: no se cambió (ajústalo en Usuarios)." }
      );
      continue;
    }
    try {
      const created = await directory.createUser({ username: person.username, name: person.name, role: person.role, teamId }, actor);
      result.users.push({ username: person.username, name: person.name, status: "created", temporaryPassword: created.temporaryPassword });
    } catch (error) {
      if (!(error instanceof UserDirectoryError)) throw error;
      result.users.push({ username: person.username, name: person.name, status: "conflict", message: error.message });
    }
  }

  for (const team of roster.teams) {
    if (!team.lead) continue;
    const teamId = teamIds.get(team.name)!;
    const lead = await store.users.findOne({ username: team.lead });
    const current = await store.teams.findOne({ _id: teamId });
    if (!lead || !current) continue;
    if (current.leadUserId === lead._id) {
      result.leads.push({ team: team.name, status: "unchanged" });
    } else if (current.leadUserId) {
      result.leads.push({ team: team.name, status: "conflict", message: "El equipo ya tiene otro líder: no se cambió." });
    } else {
      try {
        await directory.updateTeam(teamId, { leadUserId: lead._id }, actor);
        result.leads.push({ team: team.name, status: "set" });
      } catch (error) {
        if (!(error instanceof UserDirectoryError)) throw error;
        result.leads.push({ team: team.name, status: "conflict", message: error.message });
      }
    }
  }
  return result;
}
