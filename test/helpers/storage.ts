import {
  createStorageHelpers,
  type StorageHelpers,
} from "../../src/storage/storage-helpers.js";
import { SqliteStoreDatabase } from "../../src/storage/adapters/sqlite/database.js";
import { createGitLabConnectionRecord } from "./gitlab-tenant.js";

export type TestStorage = StorageHelpers & {
  close(): Promise<void>;
};

export async function openSqliteTestStorage(
  databasePath: string,
): Promise<TestStorage> {
  const database = new SqliteStoreDatabase({ databasePath });
  await database.open();
  await database.prepare();

  const storage = createStorageHelpers(database.createStores());
  if (!(await storage.stores.platformConnections.get("connection-1"))) {
    await storage.stores.platformConnections.upsert(
      createGitLabConnectionRecord(),
    );
  }
  return Object.assign(storage, {
    close: () => database.close(),
  });
}
