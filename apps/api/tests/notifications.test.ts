import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/auth/password.js";
import { startDb, stopDb } from "./helpers/db.js";
import { type App, PASSWORD, world as makeWorld } from "./helpers/world.js";

let passwordHash: string;
let apps: App[] = [];
beforeAll(async () => {
  await startDb();
  passwordHash = await hashPassword(PASSWORD);
});
afterAll(stopDb);
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});
const world = () => makeWorld(apps, passwordHash);

describe("notificaciones", () => {
  it("asignaciones, updates y menciones llegan a quien corresponde (nunca al autor); se marcan como leídas", async () => {
    const { as, users } = await world();
    const jefe = await as("jefe");
    const marta = await as("marta");
    const ana = await as("ana");
    const dev = await as("dev");

    // Lead: Marta queda como Setter → aviso de asignación.
    const lead = (await jefe("POST", "/api/sales/leads", { company: "Manpersa SAC", setterUserId: users.marta._id })).body.lead;
    // Update con mención a Ana: ella recibe «te mencionó» y Marta (Setter) el update.
    await jefe("POST", `/api/sales/leads/${lead.id}/updates`, { body: "@Ana Líder ¿puedes revisar el alcance?", mentions: [users.ana._id] });
    const martaInbox = (await marta("GET", "/api/notifications")).body;
    expect(martaInbox.items.map((n: { kind: string }) => n.kind).sort()).toEqual(["assignment", "update"]);
    const anaInbox = (await ana("GET", "/api/notifications")).body;
    expect(anaInbox.items[0]).toMatchObject({ kind: "mention", link: `/comercial/leads/${lead.id}`, actorName: expect.any(String), read: false });
    // Una mención con un id que no aparece en el texto no avisa.
    await jefe("POST", `/api/sales/leads/${lead.id}/updates`, { body: "Sin menciones", mentions: [users.dev._id] });
    expect((await dev("GET", "/api/notifications")).body.unread).toBe(0);

    // Proyecto: el developer que entra y la tarea que se le asigna.
    const project = (await ana("POST", "/api/ops/projects", { name: "Portal de pedidos", customerName: "Manpersa" })).body.project;
    await ana("PATCH", `/api/ops/projects/${project.id}`, { developerUserIds: [users.dev._id] });
    await ana("POST", "/api/tasks", { projectId: project.id, title: "Configurar n8n", assigneeUserId: users.dev._id });
    const devInbox = (await dev("GET", "/api/notifications")).body;
    expect(devInbox.unread).toBe(2);
    expect(devInbox.items.map((n: { title: string }) => n.title)).toEqual(["Te asignaron la tarea «Configurar n8n»", "Te asignaron al proyecto Portal de pedidos"]);
    // Quien hace el cambio no se avisa a sí mismo.
    expect((await ana("GET", "/api/notifications")).body.items.some((n: { kind: string }) => n.kind === "assignment")).toBe(false);

    expect((await dev("POST", "/api/notifications/read-all")).status).toBe(200);
    expect((await dev("GET", "/api/notifications")).body.unread).toBe(0);
    expect((await dev("GET", "/api/notifications/people")).body.people.some((p: { name: string }) => p.name === "Ana Líder")).toBe(true);
  });
});
