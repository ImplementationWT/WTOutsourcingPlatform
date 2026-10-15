import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sodium from "libsodium-wrappers";
import { buildMongoUri, createMongoBootstrapAdapter } from "../src/adapters/mongo-bootstrap.js";
import { OwnershipError } from "../src/lib/errors.js";
import { redactString } from "../src/lib/redact.js";
import { sealForGithub } from "../src/lib/sealed-box.js";

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
});
afterAll(async () => {
  await server?.stop();
});

const doc = { clientId: "acme-crm", templateVersion: "1.0.0", schemaVersion: 1 };

describe("bootstrap de la base del cliente", () => {
  it("crea app_metadata, índice único y documento, y es idempotente", async () => {
    const adapter = createMongoBootstrapAdapter();
    const uri = server.getUri();
    await adapter.bootstrap({ uri, database: "client_acme_crm", document: doc });
    await adapter.bootstrap({ uri, database: "client_acme_crm", document: doc });

    const client = await MongoClient.connect(uri);
    const collection = client.db("client_acme_crm").collection("app_metadata");
    const docs = await collection.find().toArray();
    const indexes = await collection.indexes();
    await client.close();

    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ key: "bootstrap", ...doc });
    expect(indexes.find((i) => i.name === "key_unique")).toMatchObject({ key: { key: 1 }, unique: true });
  });

  it("no toca una base con bootstrap de otro cliente", async () => {
    const adapter = createMongoBootstrapAdapter();
    const uri = server.getUri();
    await adapter.bootstrap({ uri, database: "client_other", document: { ...doc, clientId: "other" } });
    await expect(
      adapter.bootstrap({ uri, database: "client_other", document: doc })
    ).rejects.toBeInstanceOf(OwnershipError);
  });
});

describe("URI y cifrado", () => {
  it("codifica credenciales y la URI queda registrada para redactar", () => {
    const uri = buildMongoUri("cluster0.abc.mongodb.net", "app_acme_crm", "p@ss/w:rd", "acme-crm");
    expect(uri).toBe(
      "mongodb+srv://app_acme_crm:p%40ss%2Fw%3Ard@cluster0.abc.mongodb.net/?retryWrites=true&w=majority&appName=acme-crm"
    );
    expect(redactString(`conectando a ${uri}`)).not.toContain("p%40ss");
  });

  it("sealed box descifrable solo con la clave privada del entorno", async () => {
    await sodium.ready;
    const pair = sodium.crypto_box_keypair();
    const publicKey = sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL);
    const sealed = await sealForGithub(publicKey, "client_acme_crm");
    const opened = sodium.crypto_box_seal_open(
      sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL),
      pair.publicKey,
      pair.privateKey
    );
    expect(sodium.to_string(opened)).toBe("client_acme_crm");
  });
});
