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

describe("leads (Paso 3)", () => {
  it("funnel, temperatura, Setter y Closer, fechas y días de respuesta calculados", async () => {
    const { as, users } = await world();
    const marta = await as("marta");
    const created = await marta("POST", "/api/sales/leads", {
      company: "Manpersa",
      email: "francisco@manpersa.pe",
      funnel: "upwork",
      temperature: "hot",
      closerUserId: users.marta._id,
      submittedAt: "2026-10-20",
      meetingAt: "2026-10-23"
    });
    expect(created.status).toBe(201);
    expect(created.body.lead).toMatchObject({ funnel: "upwork", temperature: "hot", setter: { id: users.marta._id }, closer: { id: users.marta._id }, responseDays: 3 });
    // El Setter y el Closer son de Comercial.
    expect((await marta("PATCH", `/api/sales/leads/${created.body.lead.id}`, { closerUserId: users.ana._id })).status).toBe(400);
    // La tabla filtra, ordena y cuenta por estado en el servidor.
    await marta("POST", "/api/sales/leads", { company: "Otra", funnel: "outreach", temperature: "warm" });
    const table = (await marta("GET", "/api/sales/leads?funnel=upwork&sort=temperature&dir=asc")).body;
    expect(table).toMatchObject({ total: 1, facets: { new: 1 } });
    expect(table.rows[0]).not.toHaveProperty("rawJson");
  });

  it("un lead se enlaza a un Contacto existente; un nurturing vuelve al embudo con una demo", async () => {
    const { as } = await world();
    const marta = await as("marta");
    const contact = (await marta("POST", "/api/contacts", { name: "Lucía Pérez", company: "Acme SAC" })).body.contact;
    const lead = (await marta("POST", "/api/sales/leads", { company: "Acme", contactId: contact.id })).body.lead;
    expect(lead).toMatchObject({ contactRef: { id: contact.id, name: "Lucía Pérez" } });
    expect((await marta("PATCH", `/api/sales/leads/${lead.id}`, { contactId: "99999999-9999-4999-8999-999999999999" })).status).toBe(400);
    // El contacto muestra su lead.
    expect((await marta("GET", `/api/contacts/${contact.id}`)).body.leads.map((l: { id: string }) => l.id)).toEqual([lead.id]);

    await marta("PATCH", `/api/sales/leads/${lead.id}`, { status: "nurturing" });
    await marta("POST", `/api/sales/leads/${lead.id}/updates`, { body: "Le escribí, sin respuesta." });
    expect((await marta("GET", `/api/sales/leads/${lead.id}`)).body.lead.status).toBe("nurturing");
    await marta("POST", `/api/sales/leads/${lead.id}/demos`, { title: "Demo", scheduledAt: "2026-11-03T15:00:00-05:00" });
    expect((await marta("GET", `/api/sales/leads/${lead.id}`)).body.lead.status).toBe("demo");
  });
});

describe("demos y aprendizajes", () => {
  it("tabla de demos con su lead y aprendizajes ligados a la demo", async () => {
    const { as } = await world();
    const marta = await as("marta");
    const lead = (await marta("POST", "/api/sales/leads", { company: "Manpersa" })).body.lead;
    const demo = (await marta("POST", `/api/sales/leads/${lead.id}/demos`, { title: "Demo del portal", scheduledAt: "2026-11-03T15:00:00-05:00" })).body.demo;
    const learned = await marta("POST", `/api/sales/leads/${lead.id}/demos/${demo.id}/learnings`, { text: "Preguntaron por el costo de mantenimiento." });
    expect(learned.status).toBe(201);
    expect(learned.body.demo.learnings).toMatchObject([{ text: "Preguntaron por el costo de mantenimiento.", authorName: "Marta Marketing" }]);
    const table = (await marta("GET", "/api/sales/demos")).body;
    expect(table.rows[0]).toMatchObject({ title: "Demo del portal", lead: { id: lead.id, title: "Manpersa" } });
    expect((await (await as("fede"))("GET", "/api/sales/demos")).status).toBe(200);
    expect((await (await as("fede"))("POST", `/api/sales/leads/${lead.id}/demos/${demo.id}/learnings`, { text: "Algo más." })).status).toBe(403);
  });
});

describe("actividades comerciales", () => {
  it("se ligan a un lead o a un deal, quedan vencidas si pasa la fecha y su cambio deja novedad", async () => {
    const { as, users } = await world();
    const marta = await as("marta");
    const lead = (await marta("POST", "/api/sales/leads", { company: "Manpersa" })).body.lead;
    expect((await marta("POST", "/api/activities", { title: "Llamar" })).status).toBe(400);
    const overdue = (await marta("POST", "/api/activities", { title: "Llamar a Francisco", kind: "call", leadId: lead.id, dueDate: "2020-01-01" })).body.activity;
    expect(overdue).toMatchObject({ owner: { id: users.marta._id }, overdue: true, lead: { id: lead.id, title: "Manpersa" } });
    const deal = (await marta("POST", "/api/deals", { title: "Portal", leadId: lead.id })).body.deal;
    await marta("POST", "/api/activities", { title: "Enviar contrato", dealId: deal.id, dueDate: "2099-01-01" });
    expect((await marta("GET", `/api/activities?dealId=${deal.id}`)).body.rows.map((a: { title: string }) => a.title)).toEqual(["Enviar contrato"]);
    expect((await marta("GET", "/api/activities?mine=1")).body.total).toBe(2);
    const done = (await marta("PATCH", `/api/activities/${overdue.id}`, { status: "done" })).body.activity;
    expect(done).toMatchObject({ status: "done", overdue: false });
    expect((await marta("GET", `/api/sales/leads/${lead.id}/updates`)).body.updates.some((u: { body: string }) => u.body.includes("Pendiente → Hecha"))).toBe(true);
    expect((await (await as("fede"))("PATCH", `/api/activities/${overdue.id}`, { status: "pending" })).status).toBe(403);
  });
});

describe("cotizaciones con líneas", () => {
  it("el monto es la suma de las líneas (calc); enviar adelanta el lead; un deal muestra su propuesta y su bitácora", async () => {
    const { as } = await world();
    const marta = await as("marta");
    const lead = (await marta("POST", "/api/sales/leads", { company: "Manpersa" })).body.lead;
    expect((await marta("POST", "/api/proposals", { title: "Propuesta", url: "https://p.example.com/" })).status).toBe(400);
    expect((await marta("POST", "/api/proposals", { title: "Propuesta", url: "https://p.example.com/", leadId: lead.id, lines: [{ description: "x", hours: 1, rateCents: 1 }], amountCents: 5 })).status).toBe(400);
    const created = await marta("POST", "/api/proposals", {
      title: "Propuesta Manpersa",
      url: "https://p.example.com/",
      leadId: lead.id,
      lines: [
        { description: "Portal web", hours: 40, rateCents: 2500 },
        { description: "Capacitación", hours: 4, rateCents: 2000 }
      ]
    });
    expect(created.status).toBe(201);
    const proposal = created.body.proposal;
    expect(proposal).toMatchObject({ amountCents: 108_000 });
    expect(proposal.lines).toMatchObject([{ description: "Portal web", subtotalCents: 100_000 }, { subtotalCents: 8_000 }]);

    const sent = await marta("PATCH", `/api/proposals/${proposal.id}`, { status: "sent", lines: [{ description: "Todo", hours: 10, rateCents: 1000 }] });
    expect(sent.body.proposal).toMatchObject({ status: "sent", amountCents: 10_000 });
    expect(sent.body.proposal.sentAt).not.toBeNull();
    expect((await marta("GET", `/api/sales/leads/${lead.id}`)).body.lead.status).toBe("proposal_sent");
    expect((await marta("PATCH", `/api/proposals/${proposal.id}`, { amountCents: 1 })).status).toBe(400);

    // La tabla suma los montos del filtro (totales al pie).
    const deal = (await marta("POST", "/api/deals", { title: "Portal", leadId: lead.id })).body.deal;
    await marta("POST", "/api/proposals", { title: "Propuesta del deal", url: "https://d.example.com/", dealId: deal.id, amountCents: 5000 });
    const table = (await marta("GET", "/api/proposals")).body;
    expect(table).toMatchObject({ total: 2, totals: { amountCents: 15_000 } });
    expect((await marta("GET", `/api/proposals?dealId=${deal.id}`)).body.rows[0]).toMatchObject({ title: "Propuesta del deal", lead: { id: lead.id } });
    const dealUpdates = (await marta("GET", `/api/deals/${deal.id}/updates`)).body.updates.map((u: { body: string }) => u.body);
    expect(dealUpdates.some((b: string) => b.includes("Propuesta del deal"))).toBe(true);
    await marta("POST", `/api/deals/${deal.id}/updates`, { body: "El cliente pidió una llamada." });
    expect((await marta("GET", `/api/deals/${deal.id}/updates`)).body.updates[0]).toMatchObject({ kind: "manual", authorName: "Marta Marketing" });
  });

  it("Operativa edita las cotizaciones de su proyecto, no las de otros; Financiera solo lee", async () => {
    const { as } = await world();
    const ana = await as("ana");
    const project = (await ana("POST", "/api/ops/projects", { name: "Proyecto Acme", customerName: "Acme" })).body.project;
    const own = (await ana("POST", `/api/ops/projects/${project.id}/proposals`, { title: "Módulo de pagos", url: "https://pagos.example.com/" })).body.proposal;
    const edited = await ana("PATCH", `/api/proposals/${own.id}`, { lines: [{ description: "Pagos", hours: 20, rateCents: 3000 }] });
    expect(edited.body.proposal).toMatchObject({ amountCents: 60_000, project: { id: project.id } });
    expect((await (await as("otto"))("GET", `/api/proposals/${own.id}`)).status).toBe(404);
    expect((await (await as("otto"))("PATCH", `/api/proposals/${own.id}`, { title: "Ajena" })).status).toBe(403);
    const fede = await as("fede");
    expect((await fede("GET", "/api/proposals")).status).toBe(200);
    expect((await fede("PATCH", `/api/proposals/${own.id}`, { title: "Cambio" })).status).toBe(403);
    expect((await ana("GET", "/api/proposals")).status).toBe(403);
  });
});
