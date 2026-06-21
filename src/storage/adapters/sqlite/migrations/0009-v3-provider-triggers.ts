import type { DatabaseSync } from "node:sqlite";

import { getTableColumnNames } from "./helpers.js";
import type { SqliteMigration } from "./types.js";

const migration: SqliteMigration = {
  id: "sqlite:0009_v3_provider_triggers",
  transactional: false,
  apply(database) {
    migrateInteractionJobTriggers(database);
  },
};

function migrateInteractionJobTriggers(database: DatabaseSync): void {
  const columns = getTableColumnNames(database, "interaction_jobs");
  if (columns.has("trigger_json")) {
    return;
  }

  database.exec("PRAGMA foreign_keys = OFF");
  let startedTransaction = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    startedTransaction = true;
    database.exec(`
      CREATE TABLE interaction_jobs_next (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        code_review_id INTEGER NOT NULL,
        comment_id INTEGER,
        trigger_json TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        enqueued_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id)
      );

      INSERT INTO interaction_jobs_next (
        id,
        tenant_id,
        dedupe_key,
        code_review_id,
        comment_id,
        trigger_json,
        head_sha,
        status,
        payload_json,
        retry_count,
        last_error,
        enqueued_at,
        started_at,
        finished_at
      )
      SELECT
        id,
        tenant_id,
        dedupe_key,
        code_review_id,
        comment_id,
        json_object('kind', 'comment', 'commentId', comment_id),
        head_sha,
        status,
        payload_json,
        retry_count,
        last_error,
        enqueued_at,
        started_at,
        finished_at
      FROM interaction_jobs;

      DROP TABLE interaction_jobs;
      ALTER TABLE interaction_jobs_next RENAME TO interaction_jobs;
    `);
    database.exec("COMMIT");
    startedTransaction = false;
  } catch (error) {
    if (startedTransaction) {
      database.exec("ROLLBACK");
    }
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }

  const violations = database
    .prepare("PRAGMA foreign_key_check")
    .all() as Array<{ table: string }>;
  if (violations.length > 0) {
    const tables = [...new Set(violations.map((violation) => violation.table))];
    throw new Error(
      `Interaction job trigger migration left invalid foreign keys in: ${tables.join(", ")}`,
    );
  }
}

export default migration;
