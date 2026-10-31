import { buildApp } from "../../src/app.js";
import { createLoginGuard } from "../../src/auth/login-guard.js";
import type { MeetingAnalyzer } from "../../src/meetings/analyzer.js";
import { freshStore } from "./db.js";
import { createFakes } from "./fakes.js";
import { OTHER_TEAM_ID, seedUser, TEST_TEAM_ID } from "./users.js";

export const PASSWORD = "correct horse battery staple";
export type App = Awaited<ReturnType<typeof buildApp>>;

/** Analizador falso de reuniones: siempre propone lo mismo y cuenta las llamadas. */
export function fakeAnalyzer() {
  const calls: { title: string; transcript: string; context: string }[] = [];
  const analyzer: MeetingAnalyzer = {
    async analyze(input) {
      calls.push(input);
      return {
        summary: "Se acordó el alcance del reporte.",
        feedback: ["Les gusta el tablero."],
        actionItems: [
          { text: "Armar el reporte semanal", kind: "internal_work", owner: "Ana", projectedHours: 6, phase: "Sprint 2" },
          { text: "Agregar exportación a Excel", kind: "scope_risk", owner: null, projectedHours: 10, phase: null }
        ],
        clientSentiment: "excellent",
        engagement: "good",
        kind: "sprint_review",
        inputTokens: 1000,
        outputTokens: 100
      };
    }
  };
  return { analyzer, calls };
}

/**
 * App de prueba con un usuario por rol: jefe (CEO/CCO, de la configuración), ana (Team Leader del
 * equipo de los tests), dev (developer), marta (Comercial), fede (Financiera) y otto (Team
 * Leader de otro equipo).
 */
export async function world(apps: App[], passwordHash: string, { analyzer, readAiSigningKey }: { analyzer?: MeetingAnalyzer; readAiSigningKey?: Buffer } = {}) {
  const store = await freshStore();
  const fakes = createFakes(store);
  const app = await buildApp({
    store,
    deps: fakes.deps,
    logLevel: "silent",
    meetingAnalyzer: analyzer,
    readAiSigningKey,
    auth: { adminUsername: "jefe", adminPasswordHash: passwordHash, sessionSecret: "x".repeat(40), secureCookies: false, loginGuard: createLoginGuard({ maxPerIp: 1000, maxPerUser: 1000 }) }
  });
  apps.push(app);
  const users = {
    ana: await seedUser(store, passwordHash, { username: "ana", name: "Ana Líder", role: "lead", teamId: TEST_TEAM_ID }),
    dev: await seedUser(store, passwordHash, { username: "dev", name: "Diego Dev", role: "developer", teamId: TEST_TEAM_ID }),
    marta: await seedUser(store, passwordHash, { username: "marta", name: "Marta Marketing", role: "commercial", teamId: null }),
    fede: await seedUser(store, passwordHash, { username: "fede", name: "Fede Finanzas", role: "finance", teamId: null }),
    otto: await seedUser(store, passwordHash, { username: "otto", name: "Otto Otro", role: "lead", teamId: OTHER_TEAM_ID })
  };
  const as = async (username: string) => {
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: PASSWORD } });
    const cookie = login.cookies.find((c) => c.name === "pp_session");
    const headers = { cookie: cookie ? `pp_session=${cookie.value}` : "" };
    return async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
      const response = await app.inject({ method, url, headers, payload: payload as never });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- respuestas JSON variadas en los tests
      return { status: response.statusCode, body: response.json() as Record<string, any> };
    };
  };
  return { app, store, as, users };
}
