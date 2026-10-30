import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyPassword } from "../src/auth/password.js";
import { applyRoster, rosterSchema } from "../src/auth/roster.js";
import { freshStore, startDb, stopDb } from "./helpers/db.js";

beforeAll(startDb);
afterAll(stopDb);

const roster = {
  teams: [
    { name: "Team M", lead: "manuel" },
    { name: "Team A", lead: "ariana" }
  ],
  users: [
    { username: "alejandro", name: "Alejandro", role: "boss" },
    { username: "manuel", name: "Manuel", role: "lead", team: "Team M" },
    { username: "ariana", name: "Ariana", role: "lead", team: "Team A" },
    { username: "caleb", name: "Caleb", role: "developer", team: "Team M" },
    { username: "romina", name: "Romina", role: "developer", team: "Team A" }
  ]
};

describe("alta de equipos y personas", () => {
  it("valida antes de tocar la base: equipo que falta, rol sin equipo, líder que no es del equipo, repetidos", () => {
    expect(rosterSchema.safeParse(roster).success).toBe(true);
    const bad = (patch: Partial<typeof roster>) => rosterSchema.safeParse({ ...roster, ...patch }).success;
    expect(bad({ users: [...roster.users, { username: "x1x", name: "Sin equipo", role: "developer" }] })).toBe(false);
    expect(bad({ users: [...roster.users, { username: "x2x", name: "Jefe con equipo", role: "boss", team: "Team M" }] })).toBe(false);
    expect(bad({ users: [...roster.users, { username: "x3x", name: "Equipo raro", role: "developer", team: "Team Z" }] })).toBe(false);
    expect(bad({ users: [...roster.users, { username: "Caleb", name: "Otro Caleb", role: "developer", team: "Team A" }] })).toBe(false);
    expect(bad({ teams: [{ name: "Team M", lead: "caleb" }, roster.teams[1]] })).toBe(false);
  });

  it("crea equipos, usuarios con contraseña temporal y líderes; repetirlo no cambia nada", async () => {
    const store = await freshStore();
    const parsed = rosterSchema.parse(roster);
    const first = await applyRoster(store, parsed, "importación");
    expect(first.teams.map((t) => t.status)).toEqual(["created", "created"]);
    expect(first.users.every((u) => u.status === "created" && u.temporaryPassword)).toBe(true);
    expect(first.leads.map((l) => l.status)).toEqual(["set", "set"]);

    const caleb = (await store.users.findOne({ username: "caleb" }))!;
    const teamM = (await store.teams.findOne({ name: "Team M" }))!;
    expect(caleb).toMatchObject({ role: "developer", teamId: teamM._id, mustChangePassword: true });
    expect(await verifyPassword(first.users.find((u) => u.username === "caleb")!.temporaryPassword!, caleb.passwordHash)).toBe(true);
    expect(teamM.leadUserId).toBe((await store.users.findOne({ username: "manuel" }))!._id);
    expect((await store.users.findOne({ username: "alejandro" }))?.teamId).toBeNull();
    expect(await store.auditLog.countDocuments({ action: "user.created", actor: "importación" })).toBe(5);

    const again = await applyRoster(store, parsed, "importación");
    expect(again.teams.every((t) => t.status === "exists")).toBe(true);
    expect(again.users.every((u) => u.status === "exists" && !u.temporaryPassword)).toBe(true);
    expect(again.leads.every((l) => l.status === "unchanged")).toBe(true);
    expect(await store.users.countDocuments()).toBe(5);
  });

  it("si alguien ya existe con otro rol o equipo, lo informa y no lo cambia", async () => {
    const store = await freshStore();
    await applyRoster(store, rosterSchema.parse(roster), "importación");
    const moved = rosterSchema.parse({ ...roster, users: roster.users.map((u) => (u.username === "caleb" ? { ...u, team: "Team A" } : u)) });
    const result = await applyRoster(store, moved, "importación");
    expect(result.users.find((u) => u.username === "caleb")).toMatchObject({ status: "conflict" });
    expect((await store.users.findOne({ username: "caleb" }))?.teamId).toBe((await store.teams.findOne({ name: "Team M" }))!._id);
  });
});
