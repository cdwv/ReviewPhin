import type { DatabaseSync } from "node:sqlite";

import { getTableColumnNames, tableExists } from "./helpers.js";
import type { SqliteMigration } from "./types.js";

const migration: SqliteMigration = {
  id: "sqlite:0011_v5_job_claims_and_reasoning_effort",
  transactional: false,
  apply(database) {
    applyReasoningEffortColumns(database);
    applyInteractionRunClaimColumns(database);
    applyCodeReviewSnapshotRunColumn(database);
    applyInteractionJobClaimColumns(database);
  },
};

function applyReasoningEffortColumns(database: DatabaseSync): void {
  if (!tableExists(database, "model_profiles")) {
    return;
  }
  const columns = getTableColumnNames(database, "model_profiles");
  if (!columns.has("review_reasoning_effort")) {
    database.exec(
      "ALTER TABLE model_profiles ADD COLUMN review_reasoning_effort TEXT",
    );
  }
  if (!columns.has("text_generation_reasoning_effort")) {
    database.exec(
      "ALTER TABLE model_profiles ADD COLUMN text_generation_reasoning_effort TEXT",
    );
  }
}

function applyInteractionRunClaimColumns(database: DatabaseSync): void {
  if (!tableExists(database, "interaction_runs")) {
    return;
  }
  const columns = getTableColumnNames(database, "interaction_runs");
  if (!columns.has("interaction_job_claim_token")) {
    database.exec(
      "ALTER TABLE interaction_runs ADD COLUMN interaction_job_claim_token TEXT",
    );
  }
  if (!columns.has("review_reasoning_effort")) {
    database.exec(
      "ALTER TABLE interaction_runs ADD COLUMN review_reasoning_effort TEXT",
    );
  }
  if (!columns.has("text_generation_reasoning_effort")) {
    database.exec(
      "ALTER TABLE interaction_runs ADD COLUMN text_generation_reasoning_effort TEXT",
    );
  }
}

function applyCodeReviewSnapshotRunColumn(database: DatabaseSync): void {
  if (!tableExists(database, "code_review_snapshots")) {
    return;
  }
  const columns = getTableColumnNames(database, "code_review_snapshots");
  if (!columns.has("interaction_run_id")) {
    database.exec(
      "ALTER TABLE code_review_snapshots ADD COLUMN interaction_run_id TEXT",
    );
  }
}

function applyInteractionJobClaimColumns(database: DatabaseSync): void {
  if (!tableExists(database, "interaction_jobs")) {
    return;
  }
  const columns = getTableColumnNames(database, "interaction_jobs");
  if (columns.has("available_at")) {
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
        available_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        claim_token TEXT,
        claimed_by TEXT,
        claim_expires_at TEXT,
        latest_interaction_run_id TEXT,
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
        available_at,
        started_at,
        finished_at,
        claim_token,
        claimed_by,
        claim_expires_at,
        latest_interaction_run_id
      )
      SELECT
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
        enqueued_at,
        started_at,
        finished_at,
        NULL,
        NULL,
        NULL,
        NULL
      FROM interaction_jobs;

      DROP TABLE interaction_jobs;
      ALTER TABLE interaction_jobs_next RENAME TO interaction_jobs;

      CREATE INDEX IF NOT EXISTS idx_interaction_jobs_eligible
        ON interaction_jobs (status, available_at, enqueued_at, id);
      CREATE INDEX IF NOT EXISTS idx_interaction_jobs_active_lease
        ON interaction_jobs (status, claim_expires_at);
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
      `Interaction job claim migration left invalid foreign keys in: ${tables.join(", ")}`,
    );
  }
}

export default migration;
