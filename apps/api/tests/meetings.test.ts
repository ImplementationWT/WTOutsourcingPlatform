import { createHmac, randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/auth/password.js";
import { sentimentCategory } from "../src/core/migrate.js";
import { meetingFromReadAi, readAiPayloadSchema } from "../src/meetings/read-ai.js";
import { startDb, stopDb } from "./helpers/db.js";
import { type App, fakeAnalyzer, PASSWORD, world as makeWorld } from "./helpers/world.js";

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

const SIGNING_KEY = randomBytes(32);

/** El payload de ejemplo de la documentación de Read.ai, con los correos de la prueba. */
function payload({ session = "SESSION-1", request = `REQ-${randomBytes(4).toString("hex")}`, emails = ["lucia@acme.pe"], trigger = "meeting_end", withTranscript = true } = {}) {
  return {
    session_id: session,
    trigger,
    title: "Sprint review Acme",
    start_time: "2026-10-28T15:00:00Z",
    end_time: "2026-10-28T15:45:00Z",
    participants: [
      { name: "Ana Líder", first_name: "Ana", last_name: "Líder", email: "ana@whatever.tech" },
      ...emails.map((email, i) => ({ name: `Cliente ${i + 1}`, first_name: "Cliente", last_name: String(i + 1), email })),
      { name: "Sin correo", first_name: "Sin", last_name: "correo", email: null }
    ],
    owner: { name: "Ana Líder", first_name: "Ana", last_name: "Líder", email: "ana@whatever.tech" },
    summary: "Resumen de Read.ai.",
    action_items: [{ text: "Acción de Read.ai" }],
    key_questions: [{ text: "¿Cuándo sale?" }],
    topics: [{ text: "Reportes" }],
    report_url: "https://app.read.ai/analytics/meetings/SESSION-1",
    chapter_summaries: [],
    transcript: withTranscript
      ? {
          speaker_blocks: [
            { start_time: "1719514000000", end_time: "1719514001000", speaker: { name: "Lucía" }, words: "Nos gusta el tablero." },
            { start_time: "1719514002000", end_time: "1719514003000", speaker: { name: "Ana" }, words: "Armamos el reporte semanal." }
          ],
          speakers: [{ name: "Lucía" }, { name: "Ana" }]
        }
      : { speaker_blocks: [], speakers: [] },
    platform_meeting_id: "abc-defg-hij",
    platform: "meet",
    request_id: request
  };
}

/** Envía el webhook firmado como Read.ai (HMAC-SHA256 hex del cuerpo crudo). */
function send(app: App, body: unknown, { key = SIGNING_KEY, signature }: { key?: Buffer; signature?: string } = {}) {
  const raw = JSON.stringify(body);
  return app.inject({
    method: "POST",
    url: "/api/webhooks/read-ai",
    headers: { "content-type": "application/json", "x-read-signature": signature ?? createHmac("sha256", key).update(raw).digest("hex") },
    payload: raw
  });
}

async function setup({ withKey = true } = {}) {
  const { analyzer, calls } = fakeAnalyzer();
  const w = await makeWorld(apps, passwordHash, { analyzer, readAiSigningKey: withKey ? SIGNING_KEY : undefined });
  const jefe = await w.as("jefe");
  const ana = await w.as("ana");
  const company = (await jefe("POST", "/api/companies", { name: "Acme SAC" })).body.company;
  const contact = (await jefe("POST", "/api/contacts", { name: "Lucía Pérez", emails: ["lucia@acme.pe"], companyId: company.id })).body.contact;
  const project = (await ana("POST", "/api/ops/projects", { name: "Proyecto Acme", customerName: "Acme", contactIds: [contact.id] })).body.project;
  return { ...w, calls, jefe, ana, company, contact, project };
}

describe("payload de Read.ai", () => {
  it("toma título, duración, participantes únicos, transcripción por hablante y lo que propone Read.ai", () => {
    const data = meetingFromReadAi(readAiPayloadSchema.parse(payload()), new Date());
    expect(data).toMatchObject({ title: "Sprint review Acme", durationMinutes: 45, externalId: "SESSION-1", url: "https://app.read.ai/analytics/meetings/SESSION-1" });
    expect(data.participants.map((p) => p.email)).toEqual(["ana@whatever.tech", "lucia@acme.pe", null]);
    expect(data.transcript).toBe("Lucía: Nos gusta el tablero.\nAna: Armamos el reporte semanal.");
    expect(data.readAi).toEqual({ summary: "Resumen de Read.ai.", actionItems: ["Acción de Read.ai"], topics: ["Reportes"], keyQuestions: ["¿Cuándo sale?"] });
  });

  it("migración: el sentimiento numérico de la v1 pasa a su categoría", () => {
    expect([90, 70, 50, 20].map(sentimentCategory)).toEqual(["excellent", "good", "neutral", "friction"]);
  });
});

describe("webhook de Read.ai", () => {
  it("sin signing key en el servidor responde 503; con firma inválida, 401", async () => {
    const off = await setup({ withKey: false });
    expect((await send(off.app, payload())).statusCode).toBe(503);
    const on = await setup();
    expect((await send(on.app, payload(), { key: randomBytes(32) })).statusCode).toBe(401);
    expect((await send(on.app, payload(), { signature: "" })).statusCode).toBe(401);
    expect(await on.store.meetings.countDocuments()).toBe(0);
  });

  it("asigna la reunión al proyecto por el correo del contacto, la procesa Claude y no se duplica", async () => {
    const { app, store, ana, project, contact, calls } = await setup();
    const first = await send(app, payload());
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ assigned: "project" });
    await app.meetings.idle();
    const [meeting] = (await ana("GET", `/api/ops/projects/${project.id}/meetings`)).body.meetings;
    expect(meeting).toMatchObject({
      source: "read_ai",
      title: "Sprint review Acme",
      durationMinutes: 45,
      url: "https://app.read.ai/analytics/meetings/SESSION-1",
      attendees: [{ id: contact.id, name: "Lucía Pérez" }],
      status: "processed",
      reviewStatus: "new",
      clientSentiment: "excellent",
      kind: "sprint_review",
      readAi: { summary: "Resumen de Read.ai." }
    });
    expect(meeting.actionItems.map((a: { status: string }) => a.status)).toEqual(["proposed", "proposed"]);
    expect(calls[0].transcript).toContain("Lucía: Nos gusta el tablero.");
    expect(calls[0].context).toContain("Proyecto Acme");
    // Reintento de Read.ai (mismo request_id) y reenvío manual (mismo session_id): no se duplica.
    const again = payload({ request: "REQ-same" });
    await send(app, again);
    expect((await send(app, again)).json()).toMatchObject({ duplicate: true });
    expect((await send(app, payload())).json()).toMatchObject({ duplicate: true });
    expect(await store.meetings.countDocuments()).toBe(1);
    // Claude propone: el Health no cambia y no hay tareas.
    expect((await ana("GET", `/api/ops/projects/${project.id}`)).body.project.health).toBe("neutral");
    expect((await ana("GET", `/api/ops/projects/${project.id}/tasks`)).body.tasks).toHaveLength(0);
  });

  it("asigna al lead por su correo; meeting_start se ignora; sin coincidencia va a la bandeja", async () => {
    const { app, store, as } = await setup();
    const marta = await as("marta");
    const lead = (await marta("POST", "/api/sales/leads", { company: "Prospecto SA", email: "jefe@prospecto.pe" })).body.lead;
    expect((await send(app, payload({ session: "S-LEAD", emails: ["jefe@prospecto.pe"] }))).json()).toMatchObject({ assigned: "lead" });
    await app.meetings.idle();
    expect((await marta("GET", `/api/sales/leads/${lead.id}/meetings`)).body.meetings[0]).toMatchObject({ title: "Sprint review Acme", clientSentiment: "excellent" });

    expect((await send(app, payload({ session: "S-START", trigger: "meeting_start" }))).statusCode).toBe(202);
    expect((await send(app, payload({ session: "S-NONE", emails: ["nadie@desconocido.pe"] }))).json()).toMatchObject({ assigned: null });
    expect(await store.meetingInbox.countDocuments()).toBe(1);
  });

  it("sin transcripción queda con el resumen y los action items de Read.ai, sin llamar a Claude", async () => {
    const { app, ana, project, calls } = await setup();
    await send(app, payload({ withTranscript: false }));
    await app.meetings.idle();
    const [meeting] = (await ana("GET", `/api/ops/projects/${project.id}/meetings`)).body.meetings;
    expect(meeting).toMatchObject({ status: "processed", summary: "Resumen de Read.ai.", actionItems: [{ text: "Acción de Read.ai", status: "proposed" }] });
    expect(calls).toHaveLength(0);
  });
});

describe("bandeja «Por asignar»", () => {
  it("CEO/CCO y Comercial la ven; el CEO/CCO asigna a un proyecto (y se procesa), Comercial solo a leads; se puede descartar", async () => {
    const { app, as, jefe, ana, project, calls } = await setup();
    // Dos proyectos con el mismo contacto: ambiguo → bandeja con los candidatos.
    const second = (await ana("POST", "/api/ops/projects", { name: "Proyecto Acme 2", customerName: "Acme", contactIds: [project.contacts[0].id] })).body.project;
    expect((await send(app, payload({ session: "S-AMBIG" }))).json()).toMatchObject({ assigned: null });
    const inbox = (await jefe("GET", "/api/meetings/inbox")).body.meetings;
    expect(inbox).toHaveLength(1);
    expect(inbox[0].candidates.map((c: { name: string }) => c.name).sort()).toEqual(["Proyecto Acme", "Proyecto Acme 2"]);
    expect(inbox[0]).not.toHaveProperty("transcript");
    expect(inbox[0].transcriptLength).toBeGreaterThan(0);
    expect((await ana("GET", "/api/meetings/inbox")).status).toBe(403);

    const marta = await as("marta");
    expect((await marta("POST", `/api/meetings/inbox/${inbox[0].id}/assign`, { projectId: second.id })).status).toBe(403);
    expect((await jefe("POST", `/api/meetings/inbox/${inbox[0].id}/assign`, { projectId: second.id })).status).toBe(200);
    await app.meetings.idle();
    expect((await ana("GET", `/api/ops/projects/${second.id}/meetings`)).body.meetings[0]).toMatchObject({ status: "processed" });
    expect(calls).toHaveLength(1);
    expect((await jefe("GET", "/api/meetings/inbox")).body.meetings).toHaveLength(0);

    await send(app, payload({ session: "S-INTERNA", emails: [] }));
    const internal = (await marta("GET", "/api/meetings/inbox")).body.meetings[0];
    expect((await marta("DELETE", `/api/meetings/inbox/${internal.id}`)).status).toBe(200);
    expect((await marta("GET", "/api/meetings/inbox")).body.meetings).toHaveLength(0);
  });
});

describe("revisión y action items (Claude propone, una persona decide)", () => {
  it("el Team Leader revisa, convierte en Task y en Change Order; el developer no convierte", async () => {
    const { app, as, ana, jefe, project } = await setup();
    const deal = (await jefe("POST", "/api/deals", { title: "Reportes", projectId: project.id, hours: 40, rateCents: 2500, status: "approved" })).body.deal;
    await send(app, payload());
    await app.meetings.idle();
    const base = `/api/ops/projects/${project.id}/meetings`;
    const [meeting] = (await ana("GET", base)).body.meetings;
    const [report, excel] = meeting.actionItems;

    const reviewed = await ana("PATCH", `${base}/${meeting.id}`, { reviewStatus: "reviewed", dealId: deal.id, kind: "alignment" });
    expect(reviewed.body.meeting).toMatchObject({ reviewStatus: "reviewed", deal: { id: deal.id }, kind: "alignment" });
    expect((await ana("PATCH", `${base}/${meeting.id}`, { dealId: "99999999-9999-4999-8999-999999999999" })).status).toBe(400);

    const dev = await as("dev");
    expect((await dev("POST", `${base}/${meeting.id}/action-items/${report.id}/convert`, { to: "task" })).status).toBe(403);

    const toTask = await ana("POST", `${base}/${meeting.id}/action-items/${report.id}/convert`, { to: "task", hours: 8 });
    expect(toTask.status).toBe(201);
    const task = (await ana("GET", `/api/ops/projects/${project.id}/tasks`)).body.tasks[0];
    expect(task).toMatchObject({ title: "Armar el reporte semanal", estimatedHours: 8, dealId: deal.id, status: "todo" });
    expect(toTask.body.meeting).toMatchObject({ reviewStatus: "actioned" });
    expect(toTask.body.meeting.actionItems[0]).toMatchObject({ status: "task", taskId: task.id });
    expect((await ana("POST", `${base}/${meeting.id}/action-items/${report.id}/convert`, { to: "task" })).status).toBe(409);

    const toCo = await ana("POST", `${base}/${meeting.id}/action-items/${excel.id}/convert`, { to: "change_order" });
    expect(toCo.status).toBe(201);
    const fresh = (await ana("GET", `/api/deals/${deal.id}`)).body.deal;
    expect(fresh.changeOrders).toMatchObject([{ description: "Agregar exportación a Excel", hours: 10, rateCents: 2500, amountCents: 25_000, status: "draft" }]);
    expect((await ana("POST", `${base}/${meeting.id}/action-items/${excel.id}/convert`, { to: "activity" })).status).toBe(400);
    // El deal ve la reunión que habló de él.
    expect((await ana("GET", `/api/deals/${deal.id}/meetings`)).body.meetings).toMatchObject([{ id: meeting.id, owner: { kind: "project", id: project.id } }]);
    expect((await ana("GET", `/api/ops/projects/${project.id}/updates`)).body.updates.some((u: { body: string }) => u.body.includes("convertido en tarea"))).toBe(true);
  });

  it("en un lead, el action item pasa a actividad comercial; descartar no crea nada", async () => {
    const { app, as } = await setup();
    const marta = await as("marta");
    const lead = (await marta("POST", "/api/sales/leads", { company: "Prospecto SA", email: "jefe@prospecto.pe" })).body.lead;
    await send(app, payload({ session: "S-LEAD", emails: ["jefe@prospecto.pe"] }));
    await app.meetings.idle();
    const base = `/api/sales/leads/${lead.id}/meetings`;
    const list = (await marta("GET", base)).body;
    expect(list.conversions).toEqual(["activity"]);
    const [meeting] = list.meetings;
    const converted = await marta("POST", `${base}/${meeting.id}/action-items/${meeting.actionItems[0].id}/convert`, { to: "activity", dueDate: "2026-11-05" });
    expect(converted.status).toBe(201);
    expect((await marta("GET", `/api/activities?leadId=${lead.id}`)).body.rows).toMatchObject([{ title: "Armar el reporte semanal", dueDate: "2026-11-05", status: "pending" }]);
    const discarded = await marta("PATCH", `${base}/${meeting.id}/action-items/${meeting.actionItems[1].id}`, { status: "discarded" });
    expect(discarded.body.meeting.actionItems[1].status).toBe("discarded");
    expect((await marta("PATCH", `${base}/${meeting.id}/action-items/${meeting.actionItems[0].id}`, { status: "proposed" })).status).toBe(409);
    expect((await marta("GET", "/api/activities")).body.total).toBe(1);
  });
});
