import { describe, expect, it } from "vitest";
import { verifyPassword, hashPassword } from "../src/auth/password.js";
import { deriveNames, parseSlug } from "../src/domain/naming.js";
import { envSchema, loadEnv } from "../src/config/env.js";
import { TransientError } from "../src/lib/errors.js";
import { clearRegisteredSecrets, redact, redactString, registerSecret, REDACTED } from "../src/lib/redact.js";
import { backoffDelay, withRetry } from "../src/lib/retry.js";

describe("nombres derivados del slug", () => {
  const opts = { targetOwner: "acme-org", appsDomain: "apps.example.com" };

  it("cumple el contrato del template (MONGODB_DB ^client_[a-z0-9_]+$)", () => {
    const names = deriveNames(parseSlug("acme-crm-2"), opts);
    expect(names).toMatchObject({
      clientId: "acme-crm-2",
      repository: "acme-crm-2-app",
      database: "client_acme_crm_2",
      dbUser: "app_acme_crm_2",
      host: "acme-crm-2.apps.example.com",
      baseUrl: "https://acme-crm-2.apps.example.com"
    });
    expect(names.database).toMatch(/^client_[a-z0-9_]+$/);
  });

  it("rechaza slugs que no pasan la validación", () => {
    for (const bad of ["Acme", "acme_crm", "a", "-x-", "a/b", "acme crm", ""]) {
      expect(() => parseSlug(bad), bad).toThrow();
    }
  });
});

describe("redacción", () => {
  it("oculta URIs, tokens, Bearer y claves privadas", () => {
    const text = [
      "mongodb+srv://user:p%40ss@cluster.mongodb.net/?x=1",
      "mongodb://root:secret@localhost:27017",
      "ghs_0123456789abcdefghij0123456789abcd",
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlMTIz",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----"
    ].join(" | ");
    const out = redactString(text);
    for (const leaked of ["p%40ss", "root:secret", "ghs_0123", "github_pat_11", "eyJhbGci", "abc\n-----END"]) {
      expect(out).not.toContain(leaked);
    }
  });

  it("oculta por clave y por valor registrado, también dentro de errores", () => {
    clearRegisteredSecrets();
    registerSecret("s3cr3t-value-123");
    const error = new Error("falló con s3cr3t-value-123", { cause: { password: "x", uri: "y" } });
    const out = redact({ password: "abc", nested: { mongodbUri: "z", note: "s3cr3t-value-123" }, error });
    expect(out.password).toBe(REDACTED);
    expect(out.nested.mongodbUri).toBe(REDACTED);
    expect(out.nested.note).toBe(REDACTED);
    expect(JSON.stringify(out)).not.toContain("s3cr3t-value-123");
  });
});

describe("reintentos", () => {
  it("backoff exponencial con jitter acotado", () => {
    const opts = { attempts: 5, baseMs: 100, maxMs: 1000, random: () => 1 };
    expect([0, 1, 2, 3, 4].map((n) => backoffDelay(n, opts))).toEqual([100, 200, 400, 800, 1000]);
    expect(backoffDelay(3, { ...opts, random: () => 0 })).toBe(0);
  });

  it("solo reintenta errores temporales", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new Error("fatal");
      }, { attempts: 3, baseMs: 1, maxMs: 1, sleep: async () => {} })
    ).rejects.toThrow("fatal");
    expect(calls).toBe(1);

    calls = 0;
    const result = await withRetry(async () => {
      if (++calls < 3) throw new TransientError("t", "temporal");
      return "ok";
    }, { attempts: 3, baseMs: 1, maxMs: 1, sleep: async () => {} });
    expect(result).toBe("ok");
  });
});

describe("configuración", () => {
  it("valida las variables de Atlas sin mostrar valores", () => {
    const result = envSchema.safeParse({ ATLAS_PROJECT_ID: "not-an-id", ATLAS_CLIENT_SECRET: "super-secret-value" });
    expect(result.success).toBe(false);
    const messages = JSON.stringify(result.error!.issues);
    expect(messages).toContain("ATLAS_PROJECT_ID");
    expect(messages).not.toContain("super-secret-value");
  });

  it("ATLAS_CLUSTER_SRV_HOST debe ser un hostname, no una URI", () => {
    const shape = envSchema.shape.ATLAS_CLUSTER_SRV_HOST;
    expect(shape.safeParse("cluster0.abcde.mongodb.net").success).toBe(true);
    expect(shape.safeParse("mongodb+srv://u:p@cluster0.abcde.mongodb.net").success).toBe(false);
  });
});

describe("configuración del template y de la contraseña inicial", () => {
  const base = {
    GITHUB_APP_ID: "1",
    GITHUB_INSTALLATION_ID: "2",
    GITHUB_PRIVATE_KEY_PATH: "/tmp/key.pem",
    GITHUB_TEMPLATE_OWNER: "acme",
    GITHUB_TEMPLATE_REPO: "node-typescript-template",
    GITHUB_TARGET_OWNER: "acme",
    ATLAS_PROJECT_ID: "a".repeat(24),
    ATLAS_CLIENT_ID: "id",
    ATLAS_CLIENT_SECRET: "secret",
    ATLAS_CLUSTER_NAME: "cluster",
    ATLAS_CLUSTER_SRV_HOST: "cluster.abcde.mongodb.net",
    ADMIN_MONGODB_URI: "mongodb://localhost",
    APPS_DOMAIN: "apps.example.test",
    PANEL_ADMIN_USERNAME: "admin",
    PANEL_ADMIN_PASSWORD_HASH: "scrypt$x",
    SESSION_SECRET: "x".repeat(32)
  };

  it("por defecto: template 1.1.0, schema mínima 1 y modo random (que exige la clave)", () => {
    expect(() => loadEnv(base)).toThrow(/INITIAL_PASSWORD_KEY_PATH/);
    const env = loadEnv({ ...base, INITIAL_PASSWORD_KEY_PATH: "/run/secrets/key" });
    expect(env).toMatchObject({ TEMPLATE_VERSION: "1.1.0", MIN_SCHEMA_VERSION: 1, INITIAL_ADMIN_MODE: "random" });
  });

  it("valores vacíos usan el valor por defecto; el modo default no exige clave", () => {
    const env = loadEnv({ ...base, TEMPLATE_VERSION: "", MIN_SCHEMA_VERSION: "", INITIAL_ADMIN_MODE: "default" });
    expect(env).toMatchObject({ TEMPLATE_VERSION: "1.1.0", MIN_SCHEMA_VERSION: 1, INITIAL_ADMIN_MODE: "default" });
  });

  it("rechaza versiones y modos inválidos", () => {
    expect(envSchema.shape.TEMPLATE_VERSION.safeParse("v1.2").success).toBe(false);
    expect(envSchema.shape.TEMPLATE_VERSION.safeParse("1.2.0").success).toBe(true);
    expect(envSchema.shape.MIN_SCHEMA_VERSION.safeParse("0").success).toBe(false);
    expect(envSchema.shape.INITIAL_ADMIN_MODE.safeParse("manual").success).toBe(false);
  });
});

describe("contraseña del panel", () => {
  it("hash scrypt verificable y resistente a contraseñas incorrectas", async () => {
    const hash = await hashPassword("una contraseña larga");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("una contraseña larga", hash)).toBe(true);
    expect(await verifyPassword("otra", hash)).toBe(false);
  });
});
