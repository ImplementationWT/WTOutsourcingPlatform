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

describe("archivos del deal y del proyecto", () => {
  it("el documento de la propuesta se sube como archivo, se descarga igual y se borra; Financiera no sube", async () => {
    const { app, as } = await world();
    const ana = await as("ana");
    const project = (await ana("POST", "/api/ops/projects", { name: "Arzuman Brothers", customerName: "Arzuman" })).body.project;
    const deal = (await ana("POST", "/api/deals", { title: "Warranty Services Apps", projectId: project.id })).body.deal;
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "ana", password: PASSWORD } });
    const cookie = `pp_session=${login.cookies.find((c) => c.name === "pp_session")!.value}`;
    const pdf = Buffer.from("%PDF-1.4 propuesta");
    const up = await app.inject({ method: "PUT", url: `/api/deals/${deal.id}/proposal-doc`, headers: { cookie, "content-type": "application/pdf", "x-file-name": encodeURIComponent("Propuesta Ñandú.pdf") }, payload: pdf });
    expect(up.statusCode).toBe(200);
    expect(up.json().file).toMatchObject({ name: "Propuesta Ñandú.pdf", size: pdf.length });
    expect((await ana("GET", `/api/deals/${deal.id}`)).body.deal.proposalDoc).toMatchObject({ name: "Propuesta Ñandú.pdf" });
    const down = await app.inject({ method: "GET", url: `/api/deals/${deal.id}/proposal-doc`, headers: { cookie } });
    expect(down.headers["content-type"]).toBe("application/pdf");
    expect(down.rawPayload.equals(pdf)).toBe(true);
    const fedeLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "fede", password: PASSWORD } });
    const fedeCookie = `pp_session=${fedeLogin.cookies.find((c) => c.name === "pp_session")!.value}`;
    expect((await app.inject({ method: "PUT", url: `/api/deals/${deal.id}/proposal-doc`, headers: { cookie: fedeCookie, "content-type": "application/pdf" }, payload: pdf })).statusCode).not.toBe(200);
    expect((await ana("DELETE", `/api/deals/${deal.id}/proposal-doc`)).status).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/deals/${deal.id}/proposal-doc`, headers: { cookie } })).statusCode).toBe(404);
    // SOW del proyecto
    const sow = await app.inject({ method: "PUT", url: `/api/ops/projects/${project.id}/sow`, headers: { cookie, "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "x-file-name": "SOW.docx" }, payload: Buffer.from("docx") });
    expect(sow.statusCode).toBe(200);
    expect((await ana("GET", `/api/ops/projects/${project.id}`)).body.project.sowDoc).toMatchObject({ name: "SOW.docx", size: 4 });
  });

  it("el CEO/CCO cambia el equipo del proyecto: pasa al Team Leader del equipo nuevo y los developers se vacían", async () => {
    const { as, store } = await world();
    const ana = await as("ana");
    const project = (await ana("POST", "/api/ops/projects", { name: "Proyecto X", customerName: "Cliente X" })).body.project;
    const otherTeam = (await store.teams.find({}).toArray()).find((t) => t._id !== project.team.id)!;
    expect((await ana("PATCH", `/api/ops/projects/${project.id}`, { teamId: otherTeam._id })).status).toBe(403);
    const jefe = await as("jefe");
    expect((await jefe("PATCH", `/api/ops/projects/${project.id}`, { teamId: otherTeam._id })).status).toBe(200);
    const fresh = (await jefe("GET", `/api/ops/projects/${project.id}`)).body.project;
    expect(fresh).toMatchObject({ team: { id: otherTeam._id }, developers: [] });
  });
});
