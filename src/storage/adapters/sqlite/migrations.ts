import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "pino";

import { SQLITE_MIGRATIONS } from "./migrations/index.js";

export { SQLITE_BASELINE_MIGRATION_ID } from "./migrations/0001-v0-baseline.js";

export function applySqliteMigrations(
  database: DatabaseSync,
  adapterName: string,
  logger?: Logger,
): readonly string[] {
  ensureMigrationStateTable(database);
  logger?.info(
    `Checking available SQLite migrations for adapter "${adapterName}"...`,
  );
  const appliedMigrationIds = new Set(
    (
      database
        .prepare(
          "SELECT migration_id FROM storage_migrations WHERE adapter_name = ? ORDER BY migration_id ASC",
        )
        .all(adapterName) as Array<{ migration_id: string }>
    ).map((row) => row.migration_id),
  );
  const newlyAppliedMigrationIds: string[] = [];

  for (const migration of SQLITE_MIGRATIONS) {
    if (appliedMigrationIds.has(migration.id)) {
      continue;
    }

    const useTransaction = migration.transactional !== false;
    try {
      if (useTransaction) {
        database.exec("BEGIN IMMEDIATE");
      }
      migration.apply(database);
      database
        .prepare(
          "INSERT INTO storage_migrations (adapter_name, migration_id, applied_at) VALUES (?, ?, ?)",
        )
        .run(adapterName, migration.id, new Date().toISOString());
      if (useTransaction) {
        database.exec("COMMIT");
      }
      newlyAppliedMigrationIds.push(migration.id);
      logger?.info(
        `Applied SQLite migration "${migration.id}" for adapter "${adapterName}".`,
      );
    } catch (error) {
      if (useTransaction) {
        database.exec("ROLLBACK");
      }
      logger?.error(
        { error },
        `Failed to apply SQLite migration "${migration.id}" for adapter "${adapterName}".`,
      );
      throw error;
    }
  }

  logger?.info(
    { newlyAppliedMigrationIds },
    `Finished applying SQLite migrations for adapter "${adapterName}".`,
  );

  return newlyAppliedMigrationIds;
}

function ensureMigrationStateTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS storage_migrations (
      adapter_name TEXT NOT NULL,
      migration_id TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (adapter_name, migration_id)
    );
  `);
}
