import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { AdminStore } from "../../src/store/admin-store.js";

let replSet: MongoMemoryReplSet | undefined;
let client: MongoClient | undefined;

/** Un mongod en memoria compartido por archivo; cada test usa una base nueva. */
export async function startDb() {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  client = await MongoClient.connect(replSet.getUri());
}

export async function stopDb() {
  await client?.close();
  await replSet?.stop();
}

export async function freshStore() {
  if (!client) throw new Error("startDb() no se ejecutó");
  const store = new AdminStore(client.db(`admin_test_${randomUUID().slice(0, 8)}`));
  await store.init();
  return store;
}
