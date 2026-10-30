import { Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createLoginGuard } from "../src/auth/login-guard.js";
import { hashPassword } from "../src/auth/password.js";
import { clearRegisteredSecrets } from "../src/lib/redact.js";
import type { MeetingAnalyzer } from "../src/meetings/analyzer.js";
import { flatten, mapLead } from "../src/sales/ingest.js";
import type { AdminStore } from "../src/store/admin-store.js";
import { freshStore, startDb, stopDb } from "./helpers/db.js";
import { createFakes } from "./helpers/fakes.js";
import { seedUser, TEST_TEAM_ID } from "./helpers/users.js";

const PASSWORD = "correct horse battery staple";
let passwordHash: string;

beforeAll(async () => {
  await startDb();
  passwordHash = await hashPassword(PASSWORD);
});
afterAll(stopDb);
beforeEach(() => clearRegisteredSecrets());

type App = Awaited<ReturnType<typeof buildApp>>;
let apps: App[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

/** Analizador falso: responde lo mismo y cuenta las llamadas. Con `fail` lanza error. */
function fakeAnalyzer({ fail = false } = {}) {
  const calls: { title: string; transcript: string; context: string }[] = [];
  const analyzer: MeetingAnalyzer = {
    async analyze(input) {
      calls.push(input);
      if (fail) throw new Error("upstream sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX down");
      return { summary: "Se revisó el avance.", feedback: ["Quieren reportes semanales."], actionItems: ["Enviar el plan del proyecto"], sentiment: 72, inputTokens: 1200, outputTokens: 200 };
    }
  };
  return { analyzer, calls };
}

async function world({ analyzer, logs }: { analyzer?: MeetingAnalyzer; logs?: string[] } = {}) {
  const store = await freshStore();
  const fakes = createFakes(store);
  const app = await buildApp({
    store,
    deps: fakes.deps,
    logLevel: logs ? "debug" : "silent",
    logStream: new Writable({
      write(chunk, _enc, cb) {
        logs?.push(String(chunk));
        cb();
      }
    }),
    meetingAnalyzer: analyzer,
    auth: { adminUsername: "jefe", adminPasswordHash: passwordHash, sessionSecret: "x".repeat(40), secureCookies: false, loginGuard: createLoginGuard({ maxPerIp: 1000, maxPerUser: 1000 }) }
  });
  apps.push(app);
  const lead = await seedUser(store, passwordHash, { username: "ana", name: "Ana Líder", role: "lead", teamId: TEST_TEAM_ID });
  const dev = await seedUser(store, passwordHash, { username: "dev", name: "Diego Dev", role: "developer", teamId: TEST_TEAM_ID });
  const marta = await seedUser(store, passwordHash, { username: "marta", name: "Marta Marketing", role: "commercial", teamId: null });
  await seedUser(store, passwordHash, { username: "fede", name: "Fede Finanzas", role: "finance", teamId: null });
  const as = async (username: string) => {
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: PASSWORD } });
    const cookie = login.cookies.find((c) => c.name === "pp_session");
    const headers = { cookie: cookie ? `pp_session=${cookie.value}` : "" };
    return async (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => {
      const response = await app.inject({ method, url, headers, payload: payload as never });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- respuestas JSON variadas en los tests
      return { status: response.statusCode, body: response.json() as Record<string, any>, raw: response.body };
    };
  };
  return { app, store, as, lead, dev, marta };
}

const ingest = (app: App, sourceId: string, key: string | null, payload: unknown, contentType = "application/json") =>
  app.inject({
    method: "POST",
    url: `/api/ingest/leads/${sourceId}`,
    headers: { ...(key ? { "x-ingest-key": key } : {}), "content-type": contentType },
    payload: typeof payload === "string" ? payload : JSON.stringify(payload)
  });

async function newSource(api: Awaited<ReturnType<Awaited<ReturnType<typeof world>>["as"]>>, extra: Record<string, unknown> = {}) {
  const created = await api("POST", "/api/sales/sources", { name: "Formulario web", kind: "webhook", ...extra });
  expect(created.status).toBe(201);
  return { id: created.body.source.id as string, key: created.body.ingestKey as string };
}

describe("datos de los sources", () => {
  it("aplana cualquier JSON y adivina los campos habituales", () => {
    const fields = flatten({ contacto: { Nombre: "Francisco Wong", "Correo electrónico": "FRANCISCO@Manpersa.pe" }, empresa: "Manpersa", tags: ["ads", "peru"], respuestas: [{ q: "presupuesto", a: 5000 }] });
    expect(fields).toContainEqual({ key: "tags", value: "ads, peru" });
    expect(fields).toContainEqual({ key: "respuestas.0.a", value: "5000" });
    expect(mapLead(fields, [])).toMatchObject({ company: "Manpersa", contactName: "Francisco Wong", email: "francisco@manpersa.pe" });
  });

  it("el mapeo del source manda sobre lo adivinado; nombre y apellido se juntan", () => {
    const fields = flatten({ first_name: "Ana", last_name: "Pérez", org: "Acme", email: "no-es-correo", alt: "ana@acme.pe", lead_id: "fb-991" });
    expect(mapLead(fields, [{ from: "org", to: "company" }, { from: "lead_id", to: "externalId" }])).toMatchObject({ company: "Acme", contactName: "Ana Pérez", email: "ana@acme.pe", externalId: "fb-991" });
  });
});

describe("ingesta de leads", () => {
  it("con la clave crea el lead con los datos originales; sin ella o con otra responde 401", async () => {
    const { app, as, store } = await world();
    const marta = await as("marta");
    const source = await newSource(marta, { mapping: [{ from: "form.biz", to: "company" }] });
    expect(source.key).toMatch(/^lpk_/);
    // La clave no se vuelve a mostrar ni se guarda en claro.
    expect(JSON.stringify((await marta("GET", "/api/sales/sources")).body)).not.toContain(source.key);
    expect(JSON.stringify(await store.leadSources.findOne({ _id: source.id }))).not.toContain(source.key);

    expect((await ingest(app, source.id, null, { email: "a@b.pe" })).statusCode).toBe(401);
    expect((await ingest(app, source.id, "lpk_otra", { email: "a@b.pe" })).statusCode).toBe(401);
    expect((await ingest(app, "33333333-3333-4333-8333-333333333333", source.key, { email: "a@b.pe" })).statusCode).toBe(401);

    const ok = await ingest(app, source.id, source.key, { form: { biz: "Manpersa SAC", who: "Francisco" }, email: "francisco@manpersa.pe", utm: { campaign: "octubre" } });
    expect(ok.statusCode).toBe(201);
    const lead = await store.leads.findOne({ _id: ok.json().leadId });
    expect(lead).toMatchObject({ status: "new", company: "Manpersa SAC", email: "francisco@manpersa.pe", sourceName: "Formulario web" });
    expect(lead?.fields).toContainEqual({ key: "utm.campaign", value: "octubre" });
    expect(JSON.parse(lead!.rawJson!)).toMatchObject({ utm: { campaign: "octubre" } });
    expect((await store.leadSources.findOne({ _id: source.id }))?.received).toBe(1);
    expect((await marta("GET", `/api/sales/leads/${lead!._id}/updates`)).body.updates[0].body).toBe("Lead recibido desde Formulario web.");
  });

  it("acepta formularios, Authorization: Bearer, y no duplica el mismo id externo", async () => {
    const { app, as, store } = await world();
    const source = await newSource(await as("marta"), { mapping: [{ from: "id", to: "externalId" }] });
    const form = await app.inject({
      method: "POST",
      url: `/api/ingest/leads/${source.id}`,
      headers: { authorization: `Bearer ${source.key}`, "content-type": "application/x-www-form-urlencoded" },
      payload: "id=77&nombre=Luisa+Ramos&telefono=%2B51999111222&interes=web&interes=app"
    });
    expect(form.statusCode).toBe(201);
    const again = await ingest(app, source.id, source.key, { id: "77", nombre: "Luisa Ramos" });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ duplicate: true, leadId: form.json().leadId });
    expect(await store.leads.countDocuments()).toBe(1);
    expect(await store.leads.findOne()).toMatchObject({ contactName: "Luisa Ramos", phone: "+51999111222" });
  });

  it("un source desactivado o rotado deja de aceptar la clave anterior", async () => {
    const { app, as } = await world();
    const marta = await as("marta");
    const source = await newSource(marta);
    const rotated = await marta("POST", `/api/sales/sources/${source.id}/rotate-key`);
    expect(rotated.body.ingestKey).not.toBe(source.key);
    expect((await ingest(app, source.id, source.key, { email: "a@b.pe" })).statusCode).toBe(401);
    expect((await ingest(app, source.id, rotated.body.ingestKey, { email: "a@b.pe" })).statusCode).toBe(201);
    await marta("PATCH", `/api/sales/sources/${source.id}`, { active: false });
    expect((await ingest(app, source.id, rotated.body.ingestKey, { email: "c@d.pe" })).statusCode).toBe(403);
    expect((await ingest(app, source.id, rotated.body.ingestKey, "[1,2]")).statusCode).toBe(403);
  });
});

describe("acceso a Comercial", () => {
  it("solo el CEO/CCO y Comercial: team leaders, developers y Financiera reciben 403", async () => {
    const { as } = await world();
    expect((await (await as("marta"))("GET", "/api/sales/leads")).status).toBe(200);
    expect((await (await as("jefe"))("GET", "/api/sales/leads")).status).toBe(200);
    for (const username of ["ana", "dev", "fede"]) {
      const api = await as(username);
      expect((await api("GET", "/api/sales/leads")).status).toBe(403);
      expect((await api("GET", "/api/sales/sources")).status).toBe(403);
    }
  });

  it("para convertir, Comercial ve los equipos y sus miembros; Financiera no", async () => {
    const { as } = await world();
    const marta = await as("marta");
    expect((await marta("GET", "/api/teams")).body.teams.map((t: { id: string }) => t.id)).toContain(TEST_TEAM_ID);
    expect((await marta("GET", `/api/ops/members?teamId=${TEST_TEAM_ID}`)).body.members.map((m: { name: string }) => m.name).sort()).toEqual(["Ana Líder", "Diego Dev"]);
    const fede = await as("fede");
    expect((await fede("GET", "/api/teams")).body.teams).toHaveLength(0);
    expect((await fede("GET", `/api/ops/members?teamId=${TEST_TEAM_ID}`)).body.members).toHaveLength(0);
  });
});

describe("embudo comercial", () => {
  it("contacto, demo y propuesta enviada adelantan el lead; 'won' solo por conversión", async () => {
    const { as, marta: martaUser } = await world();
    const marta = await as("marta");
    const created = await marta("POST", "/api/sales/leads", { company: "Manpersa", contactName: "Francisco Wong", email: "francisco@manpersa.pe" });
    expect(created.status).toBe(201);
    const id = created.body.lead.id;
    expect(created.body.lead).toMatchObject({ status: "new", owner: { id: martaUser._id }, source: { name: "Manual" } });

    await marta("POST", `/api/sales/leads/${id}/updates`, { body: "Primera llamada: interesado." });
    expect((await marta("GET", `/api/sales/leads/${id}`)).body.lead.status).toBe("contacted");
    await marta("POST", `/api/sales/leads/${id}/demos`, { title: "Demo del portal", scheduledAt: "2026-11-03T15:00:00-05:00" });
    expect((await marta("GET", `/api/sales/leads/${id}`)).body.lead.status).toBe("demo");
    const proposal = await marta("POST", `/api/sales/leads/${id}/proposals`, { title: "Propuesta Manpersa", url: "https://demo-prospecto-manpersa.example.com/", amountCents: 450_000, status: "sent" });
    expect(proposal.body.proposal).toMatchObject({ status: "sent", area: "commercial" });
    expect(proposal.body.proposal.sentAt).toBeTruthy();
    const detail = (await marta("GET", `/api/sales/leads/${id}`)).body;
    expect(detail.lead.status).toBe("proposal_sent");
    expect(detail.demos).toHaveLength(1);

    expect((await marta("PATCH", `/api/sales/leads/${id}`, { status: "won" })).status).toBe(409);
    // Una demo posterior no lo atrasa.
    await marta("POST", `/api/sales/leads/${id}/demos`, { title: "Segunda demo", scheduledAt: "2026-11-05T15:00:00-05:00" });
    expect((await marta("GET", `/api/sales/leads/${id}`)).body.lead.status).toBe("proposal_sent");
  });

  it("filtra por estado y busca por texto, con los conteos del embudo", async () => {
    const { as } = await world();
    const marta = await as("marta");
    await marta("POST", "/api/sales/leads", { company: "Manpersa" });
    const lost = (await marta("POST", "/api/sales/leads", { company: "Otra SAC" })).body.lead;
    await marta("PATCH", `/api/sales/leads/${lost.id}`, { status: "lost", lostReason: "Sin presupuesto" });
    const all = (await marta("GET", "/api/sales/leads")).body;
    expect(all.counts).toMatchObject({ new: 1, lost: 1 });
    expect((await marta("GET", "/api/sales/leads?status=lost")).body.leads.map((l: { title: string }) => l.title)).toEqual(["Otra SAC"]);
    expect((await marta("GET", "/api/sales/leads?q=manp")).body.leads).toHaveLength(1);
    expect((await marta("GET", "/api/sales/leads?q=.*")).body.leads).toHaveLength(0);
  });

  it("convertir crea el cliente y el proyecto en Kick Off con la propuesta, y no se repite", async () => {
    const { as, store, lead: ana, dev } = await world();
    const marta = await as("marta");
    const id = (await marta("POST", "/api/sales/leads", { company: "Manpersa SAC", contactName: "Francisco Wong" })).body.lead.id;
    const convert = { teamId: TEST_TEAM_ID, projectName: "Automatización Manpersa", leadUserId: ana._id, developerUserId: dev._id };
    expect((await marta("POST", `/api/sales/leads/${id}/convert`, convert)).status).toBe(409);

    const proposal = (await marta("POST", `/api/sales/leads/${id}/proposals`, { title: "Propuesta", url: "https://propuesta.example.com/", status: "sent" })).body.proposal;
    // Responsables de otro rol o equipo: rechazados.
    expect((await marta("POST", `/api/sales/leads/${id}/convert`, { ...convert, leadUserId: dev._id, proposalId: proposal.id })).status).toBe(400);

    const done = await marta("POST", `/api/sales/leads/${id}/convert`, { ...convert, proposalId: proposal.id });
    expect(done.status).toBe(201);
    const project = await store.opsProjects.findOne({ _id: done.body.project.id });
    expect(project).toMatchObject({ stage: "kickoff", customerName: "Manpersa SAC", proposalUrl: "https://propuesta.example.com/", leadId: id, teamId: TEST_TEAM_ID, leadUserId: ana._id });
    expect(await store.customers.findOne({ _id: done.body.customer.id })).toMatchObject({ name: "Manpersa SAC", leadId: id });
    expect(await store.proposals.findOne({ _id: proposal.id })).toMatchObject({ status: "accepted", projectId: project!._id });
    expect((await marta("GET", `/api/sales/leads/${id}`)).body).toMatchObject({ lead: { status: "won" }, project: { id: project!._id } });
    expect((await marta("POST", `/api/sales/leads/${id}/convert`, convert)).status).toBe(409);
    expect((await marta("PATCH", `/api/sales/leads/${id}`, { status: "lost" })).status).toBe(409);

    // El equipo lo ve en Operativa con la propuesta; Comercial lo ve en clientes.
    const team = await as("ana");
    expect((await team("GET", `/api/ops/projects/${project!._id}`)).body.project).toMatchObject({ leadId: id, customerId: done.body.customer.id });
    expect((await team("GET", `/api/ops/projects/${project!._id}/proposals`)).body.proposals).toHaveLength(1);
    expect((await marta("GET", "/api/sales/customers")).body.customers[0]).toMatchObject({ name: "Manpersa SAC", projects: [{ name: "Automatización Manpersa", stage: "kickoff" }] });
  });
});

describe("propuestas desde Operativa", () => {
  it("el Team Leader crea propuestas por deal y quedan como la propuesta del deal", async () => {
    const { as } = await world();
    const ana = await as("ana");
    const project = (await ana("POST", "/api/ops/projects", { name: "Proyecto Acme", customerName: "Acme" })).body.project;
    const deal = (await ana("POST", `/api/ops/projects/${project.id}/deals`, { title: "Módulo de pagos", hours: 30, rateCents: 3000 })).body.deal;
    const created = await ana("POST", `/api/ops/projects/${project.id}/proposals`, { title: "Ampliación: pagos", url: "https://pagos.example.com/", dealId: deal.id, status: "sent" });
    expect(created.status).toBe(201);
    expect(created.body.proposal).toMatchObject({ area: "operations", dealId: deal.id });
    expect((await ana("GET", `/api/ops/projects/${project.id}/deals`)).body.deals[0].proposalUrl).toBe("https://pagos.example.com/");
    expect((await ana("PATCH", `/api/ops/projects/${project.id}/proposals/${created.body.proposal.id}`, { status: "accepted" })).body.proposal.decidedAt).toBeTruthy();
    expect((await (await as("dev"))("POST", `/api/ops/projects/${project.id}/proposals`, { title: "No debería", url: "https://x.example.com/" })).status).toBe(403);
    expect((await (await as("marta"))("GET", `/api/ops/projects/${project.id}/proposals`)).status).toBe(200);
  });
});

describe("procesamiento de reuniones", () => {
  it("una reunión con transcripción se procesa sola: resumen, feedback, action items y sentimiento sugerido", async () => {
    const { analyzer, calls } = fakeAnalyzer();
    const { app, as } = await world({ analyzer });
    const ana = await as("ana");
    const project = (await ana("POST", "/api/ops/projects", { name: "Proyecto Acme", customerName: "Acme" })).body.project;
    const created = await ana("POST", `/api/ops/projects/${project.id}/meetings`, { title: "Revisión semanal", heldAt: "2026-10-28T10:00:00-05:00", transcript: "Cliente: todo va bien, queremos reportes." });
    expect(created.body.meeting.status).toBe("pending");
    await app.meetings.idle();
    const [meeting] = (await ana("GET", `/api/ops/projects/${project.id}/meetings`)).body.meetings;
    expect(meeting).toMatchObject({ status: "processed", summary: "Se revisó el avance.", feedback: ["Quieren reportes semanales."], actionItems: ["Enviar el plan del proyecto"], sentimentSignal: 72 });
    expect(calls[0].context).toContain("Proyecto Acme");
    // El sentimiento del proyecto no cambia solo: queda como sugerencia y como novedad.
    expect((await ana("GET", `/api/ops/projects/${project.id}`)).body.project.sentimentScore).toBe(50);
    expect((await ana("GET", `/api/ops/projects/${project.id}/updates`)).body.updates.some((u: { body: string }) => u.body.includes("Sentimiento sugerido: 72/100"))).toBe(true);
    // Procesada: no se vuelve a procesar.
    expect((await ana("POST", `/api/ops/projects/${project.id}/meetings/${meeting.id}/process`)).status).toBe(409);
    expect(calls).toHaveLength(1);
  });

  it("si falla queda 'failed' sin filtrar detalles, y se puede reintentar", async () => {
    const logs: string[] = [];
    const failing = fakeAnalyzer({ fail: true });
    const { app, as, store } = await world({ analyzer: failing.analyzer, logs });
    const marta = await as("marta");
    const lead = (await marta("POST", "/api/sales/leads", { company: "Manpersa" })).body.lead;
    const created = await marta("POST", `/api/sales/leads/${lead.id}/meetings`, { title: "Demo con Manpersa", heldAt: "2026-10-28T10:00:00-05:00", transcript: "Prospecto: nos interesa." });
    await app.meetings.idle();
    const failed = (await marta("GET", `/api/sales/leads/${lead.id}/meetings`)).body.meetings[0];
    expect(failed.status).toBe("failed");
    expect(failed.processingError).not.toContain("sk-ant");
    expect(logs.join("")).not.toContain("sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(failing.calls[0].context).toContain("Manpersa");

    // Reintento con un analizador que funciona (misma base, otra instancia de la app).
    const working = fakeAnalyzer();
    const second = await buildApp({
      store: store as AdminStore,
      deps: createFakes(store).deps,
      logLevel: "silent",
      meetingAnalyzer: working.analyzer,
      auth: { adminUsername: "jefe", adminPasswordHash: passwordHash, sessionSecret: "x".repeat(40), secureCookies: false, loginGuard: createLoginGuard({ maxPerIp: 1000, maxPerUser: 1000 }) }
    });
    apps.push(second);
    const login = await second.inject({ method: "POST", url: "/api/auth/login", payload: { username: "marta", password: PASSWORD } });
    const cookie = `pp_session=${login.cookies.find((c) => c.name === "pp_session")!.value}`;
    const retried = await second.inject({ method: "POST", url: `/api/sales/leads/${lead.id}/meetings/${created.body.meeting.id}/process`, headers: { cookie } });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().meeting).toMatchObject({ status: "processed", sentimentSignal: 72 });
  });

  it("sin clave de Anthropic queda pendiente y el reproceso responde 503", async () => {
    const { as } = await world();
    const marta = await as("marta");
    const lead = (await marta("POST", "/api/sales/leads", { company: "Manpersa" })).body.lead;
    const created = await marta("POST", `/api/sales/leads/${lead.id}/meetings`, { title: "Llamada inicial", heldAt: "2026-10-28T10:00:00-05:00", transcript: "Hola." });
    expect(created.body.meeting.status).toBe("pending");
    expect((await marta("GET", `/api/sales/leads/${lead.id}/meetings`)).body.processingAvailable).toBe(false);
    expect((await marta("POST", `/api/sales/leads/${lead.id}/meetings/${created.body.meeting.id}/process`)).status).toBe(503);
    expect((await (await as("ana"))("GET", `/api/sales/leads/${lead.id}/meetings`)).status).toBe(403);
  });
});
