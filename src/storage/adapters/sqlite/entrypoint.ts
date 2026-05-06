import { resolve } from "node:path";

import { z } from "zod";

import type { StorageProviderFactoryContext } from "../../provider.js";
import { SqliteStorageProvider } from "./provider.js";

const sqliteProviderEnvSchema = z.object({
  SQLITE_DATABASE_PATH: z
    .string()
    .min(1)
    .default("./data/review-worker.sqlite"),
});

export function createStorageProvider(
  context: StorageProviderFactoryContext,
): SqliteStorageProvider {
  const parsedEnv = sqliteProviderEnvSchema.parse({
    SQLITE_DATABASE_PATH: context.env.SQLITE_DATABASE_PATH,
  });

  return new SqliteStorageProvider({
    databasePath: resolve(parsedEnv.SQLITE_DATABASE_PATH),
    ...(context.logger && { logger: context.logger }),
  });
}
