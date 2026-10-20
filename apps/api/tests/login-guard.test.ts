import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createLoginGuard } from "../src/auth/login-guard.js";
import { hashPassword } from "../src/auth/password.js";
import { freshStore, startDb, stopDb } from "./helpers/db.js";
import { createFakes } from "./helpers/fakes.js";

const PASSWORD = "correct horse battery staple";
let passwordHash: string;

beforeAll(async () => {
  await startDb();
  passwordHash = await hashPassword(PASSWORD);
});
afterAll(stopDb);

describe("límite de intentos: contadores", () => {
  it("bloquea una IP tras sus fallos y la libera al acabar la ventana", () => {
    let t = 0;
    const guard = createLoginGuard({ windowMs: 1_000, maxPerIp: 3, maxPerUser: 100, now: () => t });
    expect(guard.fail("1.1.1.1", "admin")).toBe(false);
    expect(guard.fail("1.1.1.1", "admin")).toBe(false);
    expect(guard.fail("1.1.1.1", "admin")).toBe(true);
    expect(guard.retryAfterMs("1.1.1.1", "admin")).toBe(1_000);
    // Otra IP no se ve afectada.
    expect(guard.retryAfterMs("2.2.2.2", "admin")).toBe(0);
    t = 1_000;
    expect(guard.retryAfterMs("1.1.1.1", "admin")).toBe(0);
  });

  it("un tope por usuario frena ataques repartidos entre IPs; un acierto limpia los fallos", () => {
    const guard = createLoginGuard({ maxPerIp: 100, maxPerUser: 4 });
    for (let i = 0; i < 4; i++) guard.fail(`10.0.0.${i}`, "Admin ");
    expect(guard.retryAfterMs("10.9.9.9", "admin")).toBeGreaterThan(0);

    const other = createLoginGuard({ maxPerIp: 3, maxPerUser: 100 });
    other.fail("1.1.1.1", "admin");
    other.fail("1.1.1.1", "admin");
    other.succeed("1.1.1.1", "admin");
    other.fail("1.1.1.1", "admin");
    expect(other.retryAfterMs("1.1.1.1", "admin")).toBe(0);
  });
});

describe("límite de intentos: login del panel", () => {
  let apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  afterEach(async () => {
    await Promise.all(apps.map((a) => a.close()));
    apps = [];
  });

  async function setup(guard = createLoginGuard({ maxPerIp: 3, maxPerUser: 5 })) {
    const store = await freshStore();
    const app = await buildApp({
      store,
      deps: createFakes(store).deps,
      logLevel: "silent",
      auth: { adminUsername: "admin", adminPasswordHash: passwordHash, sessionSecret: "x".repeat(40), secureCookies: false, loginGuard: guard }
    });
    apps.push(app);
    /** Como llega por nginx: conexión desde 127.0.0.1 y la IP real al final de X-Forwarded-For. */
    const login = (password: string, ip: string, extra: Record<string, string> = {}) =>
      app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "admin", password },
        headers: { "x-forwarded-for": ip, ...extra }
      });
    return { app, login };
  }

  it("tras los fallos de una IP responde 429 aunque la contraseña sea correcta; otra IP sigue entrando", async () => {
    const { login } = await setup();
    for (let i = 0; i < 3; i++) expect((await login("mala", "198.51.100.7")).statusCode).toBe(401);
    const blocked = await login(PASSWORD, "198.51.100.7");
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(blocked.json().error).toMatch(/Demasiados intentos fallidos/);
    expect(blocked.cookies.find((c) => c.name === "pp_session")).toBeUndefined();

    const ok = await login(PASSWORD, "203.0.113.9");
    expect(ok.statusCode).toBe(200);
  });

  it("falsificar X-Forwarded-For no esquiva el bloqueo: cuenta la IP que añadió nginx", async () => {
    const { login } = await setup();
    // El atacante antepone IPs inventadas; nginx añade la real al final.
    for (let i = 0; i < 3; i++) expect((await login("mala", `10.0.0.${i}, 198.51.100.7`)).statusCode).toBe(401);
    expect((await login(PASSWORD, "1.2.3.4, 198.51.100.7")).statusCode).toBe(429);
  });

  it("una conexión que no viene del nginx local no puede elegir su IP con cabeceras", async () => {
    const { app } = await setup();
    const direct = (password: string, forwarded: string) =>
      app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "admin", password },
        remoteAddress: "203.0.113.50",
        headers: { "x-forwarded-for": forwarded }
      });
    for (let i = 0; i < 3; i++) await direct("mala", `10.0.0.${i}`);
    expect((await direct(PASSWORD, "10.0.0.99")).statusCode).toBe(429);
  });

  it("el tope por usuario bloquea un ataque repartido entre muchas IPs", async () => {
    const { login } = await setup();
    for (let i = 0; i < 5; i++) await login("mala", `192.0.2.${i}`);
    expect((await login(PASSWORD, "192.0.2.200")).statusCode).toBe(429);
  });
});
