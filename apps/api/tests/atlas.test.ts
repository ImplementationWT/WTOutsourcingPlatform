import { afterEach, describe, expect, it } from "vitest";
import { AtlasUserExistsError, createAtlasAdapter } from "../src/adapters/atlas.js";
import { FatalError, TransientError } from "../src/lib/errors.js";
import { clearRegisteredSecrets, redactString } from "../src/lib/redact.js";
import { createFetchMock, json } from "./helpers/fetch-mock.js";

const config = {
  projectId: "0123456789abcdef01234567",
  clientId: "mdb_sa_id_test",
  clientSecret: "mdb_sa_sk_test_secret_value",
  clusterName: "shared-cluster",
  baseUrl: "https://atlas.test"
};

const spec = {
  username: "app_acme_crm",
  password: "a".repeat(64),
  database: "client_acme_crm",
  labels: [
    { key: "managed-by", value: "provisioning-platform" },
    { key: "client-id", value: "acme-crm" }
  ],
  description: "provisioning-platform: acme-crm"
};

const tokenOk = () => json(200, { access_token: "eyJhbGciOiJ.test-access-token.signature1234", expires_in: 3600, token_type: "Bearer" });

afterEach(() => clearRegisteredSecrets());

describe("Atlas adapter", () => {
  it("obtiene el token con client credentials y usa el header de versión", async () => {
    const { fetch, calls } = createFetchMock((call) =>
      call.url.endsWith("/api/oauth/token") ? tokenOk() : json(404, { errorCode: "USERNAME_NOT_FOUND" })
    );
    const atlas = createAtlasAdapter(config, fetch);

    expect(await atlas.getDatabaseUser("app_acme_crm")).toBeNull();

    const [tokenCall, getCall] = calls;
    expect(tokenCall.method).toBe("POST");
    expect(tokenCall.body).toBe("grant_type=client_credentials");
    expect(tokenCall.headers.authorization).toBe(
      `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`
    );
    expect(getCall.url).toBe(
      "https://atlas.test/api/atlas/v2/groups/0123456789abcdef01234567/databaseUsers/admin/app_acme_crm"
    );
    expect(getCall.headers.accept).toBe("application/vnd.atlas.2023-01-01+json");
    expect(getCall.headers.authorization).toMatch(/^Bearer /);
  });

  it("reutiliza el token mientras no expira", async () => {
    const { fetch, calls } = createFetchMock((call) =>
      call.url.endsWith("/api/oauth/token") ? tokenOk() : json(404, {})
    );
    const atlas = createAtlasAdapter(config, fetch);
    await atlas.getDatabaseUser("a");
    await atlas.getDatabaseUser("b");
    expect(calls.filter((c) => c.url.endsWith("/api/oauth/token"))).toHaveLength(1);
  });

  it("crea el usuario con readWrite solo sobre su base y scope al clúster", async () => {
    const { fetch, calls } = createFetchMock((call) =>
      call.url.endsWith("/api/oauth/token") ? tokenOk() : json(201, {})
    );
    await createAtlasAdapter(config, fetch).createDatabaseUser(spec);

    const create = calls[1];
    expect(create.method).toBe("POST");
    expect(create.headers["content-type"]).toBe("application/vnd.atlas.2023-01-01+json");
    const body = JSON.parse(create.body!);
    expect(body).toMatchObject({
      groupId: config.projectId,
      databaseName: "admin",
      username: "app_acme_crm",
      roles: [{ roleName: "readWrite", databaseName: "client_acme_crm" }],
      scopes: [{ name: "shared-cluster", type: "CLUSTER" }],
      labels: spec.labels
    });
    expect(body.roles).toHaveLength(1);
  });

  it("409 al crear se traduce en AtlasUserExistsError", async () => {
    const { fetch } = createFetchMock((call) =>
      call.url.endsWith("/api/oauth/token") ? tokenOk() : json(409, { errorCode: "USER_ALREADY_EXISTS" })
    );
    await expect(createAtlasAdapter(config, fetch).createDatabaseUser(spec)).rejects.toBeInstanceOf(
      AtlasUserExistsError
    );
  });

  it("credenciales inválidas detienen con FatalError accionable", async () => {
    const { fetch } = createFetchMock(() => json(401, { error: "invalid_client" }));
    const error = await createAtlasAdapter(config, fetch).getDatabaseUser("x").catch((e) => e);
    expect(error).toBeInstanceOf(FatalError);
    expect(error.code).toBe("atlas_invalid_credentials");
    expect(error.message).toMatch(/ATLAS_CLIENT_ID/);
  });

  it("403 (permisos o IP) es FatalError", async () => {
    const { fetch } = createFetchMock((call) =>
      call.url.endsWith("/api/oauth/token") ? tokenOk() : json(403, { errorCode: "IP_ADDRESS_NOT_ON_ACCESS_LIST" })
    );
    const error = await createAtlasAdapter(config, fetch).getDatabaseUser("x").catch((e) => e);
    expect(error).toBeInstanceOf(FatalError);
    expect(error.message).toContain("IP_ADDRESS_NOT_ON_ACCESS_LIST");
  });

  it("429 y 5xx son TransientError", async () => {
    for (const status of [429, 500, 503]) {
      const { fetch } = createFetchMock((call) =>
        call.url.endsWith("/api/oauth/token") ? tokenOk() : json(status, {})
      );
      await expect(createAtlasAdapter(config, fetch).getDatabaseUser("x")).rejects.toBeInstanceOf(TransientError);
    }
  });

  it("errores de red son TransientError", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }) });
    }) as typeof globalThis.fetch;
    await expect(createAtlasAdapter(config, fetch).getDatabaseUser("x")).rejects.toBeInstanceOf(TransientError);
  });

  it("renueva el token una vez ante un 401 de la API", async () => {
    let apiCalls = 0;
    const { fetch, calls } = createFetchMock((call) => {
      if (call.url.endsWith("/api/oauth/token")) return tokenOk();
      apiCalls++;
      return apiCalls === 1 ? json(401, {}) : json(404, {});
    });
    expect(await createAtlasAdapter(config, fetch).getDatabaseUser("x")).toBeNull();
    expect(calls.filter((c) => c.url.endsWith("/api/oauth/token"))).toHaveLength(2);
  });

  it("registra contraseña, client secret y token para redactarlos", async () => {
    const { fetch } = createFetchMock((call) =>
      call.url.endsWith("/api/oauth/token") ? tokenOk() : json(201, {})
    );
    await createAtlasAdapter(config, fetch).createDatabaseUser(spec);
    const leaked = `pw=${spec.password} secret=${config.clientSecret}`;
    expect(redactString(leaked)).not.toContain(spec.password);
    expect(redactString(leaked)).not.toContain(config.clientSecret);
  });
});
