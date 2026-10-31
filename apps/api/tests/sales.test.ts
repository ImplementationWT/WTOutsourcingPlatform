import { Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createLoginGuard } from "../src/auth/login-guard.js";
import { hashPassword } from "../src/auth/password.js";
import { clearRegisteredSecrets } from "../src/lib/redact.js";
import type { MeetingAnalyzer } from "../src/meetings/analyzer.js";
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
      return {
        summary: "Se revisó el avance.",
        feedback: ["Quieren reportes semanales."],
        actionItems: [{ text: "Enviar el plan del proyecto", kind: "internal_work", owner: "Ana", projectedHours: 3, phase: null }],
        clientSentiment: "good",
        engagement: "neutral",
        kind: "sprint_review",
        inputTokens: 1200,
        outputTokens: 200
      };
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

describe("acceso a Comercial", () => {
  it("CEO/CCO y Comercial trabajan; Financiera solo lee (§6); team leaders y developers reciben 403", async () => {
    const { as } = await world();
    expect((await (await as("marta"))("GET", "/api/sales/leads")).body.canWrite).toBe(true);
    expect((await (await as("jefe"))("GET", "/api/sales/leads")).status).toBe(200);
    const fede = await as("fede");
    const read = await fede("GET", "/api/sales/leads");
    expect(read.status).toBe(200);
    expect(read.body.canWrite).toBe(false);
    expect((await fede("POST", "/api/sales/leads", { company: "Acme" })).status).toBe(403);
    for (const username of ["ana", "dev"]) {
      const api = await as(username);
      expect((await api("GET", "/api/sales/leads")).status).toBe(403);
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
  it("contacto, demo y propuesta enviada adelantan el lead; «Ganado» se marca a mano", async () => {
    const { as, marta: martaUser } = await world();
    const marta = await as("marta");
    const created = await marta("POST", "/api/sales/leads", { company: "Manpersa", contactName: "Francisco Wong", email: "francisco@manpersa.pe" });
    expect(created.status).toBe(201);
    const id = created.body.lead.id;
    expect(created.body.lead).toMatchObject({ status: "new", setter: { id: martaUser._id }, closer: null, source: "Manual" });

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

    // Una demo posterior no lo atrasa.
    await marta("POST", `/api/sales/leads/${id}/demos`, { title: "Segunda demo", scheduledAt: "2026-11-05T15:00:00-05:00" });
    expect((await marta("GET", `/api/sales/leads/${id}`)).body.lead.status).toBe("proposal_sent");
    // Sin conversión: «Ganado» se marca a mano, y el lead muestra sus deals.
    expect((await marta("PATCH", `/api/sales/leads/${id}`, { status: "won", source: "Referido" })).body.lead).toMatchObject({ status: "won", source: "Referido" });
    const deal = (await marta("POST", "/api/deals", { title: "Portal Manpersa", leadId: id })).body.deal;
    expect((await marta("GET", `/api/sales/leads/${id}`)).body.deals).toMatchObject([{ id: deal.id, dealCode: deal.dealCode }]);
  });

  it("filtra por estado y busca por texto, con los conteos del embudo", async () => {
    const { as } = await world();
    const marta = await as("marta");
    await marta("POST", "/api/sales/leads", { company: "Manpersa" });
    const lost = (await marta("POST", "/api/sales/leads", { company: "Otra SAC" })).body.lead;
    await marta("PATCH", `/api/sales/leads/${lost.id}`, { status: "lost", lostReason: "Sin presupuesto" });
    const all = (await marta("GET", "/api/sales/leads")).body;
    expect(all.counts).toMatchObject({ new: 1, lost: 1 });
    expect((await marta("GET", "/api/sales/leads?status=lost")).body.rows.map((l: { title: string }) => l.title)).toEqual(["Otra SAC"]);
    expect((await marta("GET", "/api/sales/leads?q=manp")).body.rows).toHaveLength(1);
    expect((await marta("GET", "/api/sales/leads?q=.*")).body.rows).toHaveLength(0);
    // Vistas: activos y fríos (Cold Leads) en la misma tabla.
    expect((await marta("GET", "/api/sales/leads?view=active")).body.rows.map((l: { title: string }) => l.title)).toEqual(["Manpersa"]);
    expect((await marta("GET", "/api/sales/leads?view=cold")).body.rows.map((l: { title: string }) => l.title)).toEqual(["Otra SAC"]);
  });
});

describe("propuestas desde Operativa", () => {
  it("el Team Leader crea propuestas por deal y quedan como la propuesta del deal", async () => {
    const { as } = await world();
    const ana = await as("ana");
    const project = (await ana("POST", "/api/ops/projects", { name: "Proyecto Acme", customerName: "Acme" })).body.project;
    const deal = (await ana("POST", "/api/deals", { projectId: project.id, title: "Módulo de pagos", hours: 30, rateCents: 3000 })).body.deal;
    const created = await ana("POST", `/api/ops/projects/${project.id}/proposals`, { title: "Ampliación: pagos", url: "https://pagos.example.com/", dealId: deal.id, status: "sent" });
    expect(created.status).toBe(201);
    expect(created.body.proposal).toMatchObject({ area: "operations", dealId: deal.id });
    expect((await ana("GET", `/api/deals/${deal.id}`)).body.deal.proposalUrl).toBe("https://pagos.example.com/");
    expect((await ana("PATCH", `/api/ops/projects/${project.id}/proposals/${created.body.proposal.id}`, { status: "accepted" })).body.proposal.decidedAt).toBeTruthy();
    expect((await (await as("dev"))("POST", `/api/ops/projects/${project.id}/proposals`, { title: "No debería", url: "https://x.example.com/" })).status).toBe(403);
    expect((await (await as("marta"))("GET", `/api/ops/projects/${project.id}/proposals`)).status).toBe(200);
  });
});

describe("procesamiento de reuniones", () => {
  it("una reunión con transcripción se procesa sola: resumen, feedback, action items tipados, sentimiento y tipo", async () => {
    const { analyzer, calls } = fakeAnalyzer();
    const { app, as } = await world({ analyzer });
    const ana = await as("ana");
    const project = (await ana("POST", "/api/ops/projects", { name: "Proyecto Acme", customerName: "Acme" })).body.project;
    const created = await ana("POST", `/api/ops/projects/${project.id}/meetings`, { title: "Revisión semanal", heldAt: "2026-10-28T10:00:00-05:00", transcript: "Cliente: todo va bien, queremos reportes." });
    expect(created.body.meeting.status).toBe("pending");
    await app.meetings.idle();
    const [meeting] = (await ana("GET", `/api/ops/projects/${project.id}/meetings`)).body.meetings;
    expect(meeting).toMatchObject({
      status: "processed",
      reviewStatus: "new",
      summary: "Se revisó el avance.",
      feedback: ["Quieren reportes semanales."],
      clientSentiment: "good",
      kind: "sprint_review",
      actionItems: [{ text: "Enviar el plan del proyecto", kind: "internal_work", ownerName: "Ana", projectedHours: 3, status: "proposed", taskId: null }]
    });
    expect(calls[0].context).toContain("Proyecto Acme");
    // Claude propone: el Health del proyecto no cambia y no se crean tareas solas.
    const after = (await ana("GET", `/api/ops/projects/${project.id}`)).body.project;
    expect(after).toMatchObject({ health: "neutral", sentimentScore: 55 });
    expect((await ana("GET", `/api/ops/projects/${project.id}/tasks`)).body.tasks).toHaveLength(0);
    expect((await ana("GET", `/api/ops/projects/${project.id}/updates`)).body.updates.some((u: { body: string }) => u.body.includes("Sentimiento del cliente: Bien"))).toBe(true);
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
    expect(retried.json().meeting).toMatchObject({ status: "processed", clientSentiment: "good" });
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
    // Financiera lee las reuniones comerciales, sin registrar.
    const fede = await as("fede");
    expect((await fede("GET", `/api/sales/leads/${lead.id}/meetings`)).body.conversions).toEqual([]);
    expect((await fede("POST", `/api/sales/leads/${lead.id}/meetings`, { title: "Otra", heldAt: "2026-10-28T10:00:00-05:00" })).status).toBe(403);
  });
});
