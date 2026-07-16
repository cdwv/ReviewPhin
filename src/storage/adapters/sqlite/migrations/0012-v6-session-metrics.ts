import type { DatabaseSync } from "node:sqlite";

import { getTableColumnNames, tableExists } from "./helpers.js";
import type { SqliteMigration } from "./types.js";

const migration: SqliteMigration = {
  id: "sqlite:0012_v6_session_metrics",
  transactional: false,
  apply(database) {
    migrateInteractionRunMetrics(database);
  },
};

function migrateInteractionRunMetrics(database: DatabaseSync): void {
  if (!tableExists(database, "interaction_run_metrics")) {
    return;
  }
  if (
    getTableColumnNames(database, "interaction_run_metrics").has(
      "harness_session_key",
    )
  ) {
    return;
  }

  database.exec("PRAGMA foreign_keys = OFF");
  let startedTransaction = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    startedTransaction = true;
    database.exec(`
      CREATE TABLE interaction_run_metrics_next (
        id TEXT PRIMARY KEY,
        interaction_run_id TEXT NOT NULL,
        harness TEXT NOT NULL,
        harness_session_key TEXT NOT NULL,
        session_type TEXT NOT NULL,
        trigger_kind TEXT,
        prompt_mode TEXT,
        prompt_chars INTEGER NOT NULL,
        prompt_context_changed_files INTEGER NOT NULL,
        prompt_context_prior_discussions INTEGER NOT NULL,
        prompt_context_comments INTEGER NOT NULL,
        assistant_turns INTEGER NOT NULL,
        assistant_calls INTEGER NOT NULL,
        tool_executions INTEGER NOT NULL,
        view_tool_calls INTEGER NOT NULL,
        glob_tool_calls INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        reasoning_tokens INTEGER NOT NULL,
        api_duration_ms INTEGER NOT NULL,
        usage_unit TEXT,
        usage_amount REAL,
        usage_by_model_json TEXT NOT NULL,
        repeated_view_reads INTEGER NOT NULL,
        repeated_view_paths_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (interaction_run_id) REFERENCES interaction_runs(id),
        UNIQUE(interaction_run_id, harness, harness_session_key),
        CHECK ((usage_unit IS NULL) = (usage_amount IS NULL))
      );

      INSERT INTO interaction_run_metrics_next (
        id, interaction_run_id, harness, harness_session_key, session_type,
        trigger_kind, prompt_mode, prompt_chars,
        prompt_context_changed_files, prompt_context_prior_discussions,
        prompt_context_comments, assistant_turns, assistant_calls,
        tool_executions, view_tool_calls, glob_tool_calls, input_tokens,
        output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, api_duration_ms, usage_unit, usage_amount,
        usage_by_model_json, repeated_view_reads, repeated_view_paths_json,
        created_at, updated_at
      )
      SELECT
        id, interaction_run_id, 'github.copilot-sdk', 'legacy:' || id,
        'unknown', trigger_kind, prompt_mode, prompt_chars,
        prompt_context_changed_files, prompt_context_prior_discussions,
        prompt_context_comments, assistant_turns, assistant_calls,
        tool_executions, view_tool_calls, glob_tool_calls, input_tokens,
        output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, api_duration_ms, 'github.copilot.premium-request',
        premium_requests,
        '[{"model":"unknown","amount":' || premium_requests || '}]',
        repeated_view_reads,
        repeated_view_paths_json, created_at, updated_at
      FROM interaction_run_metrics;

      DROP TABLE interaction_run_metrics;
      ALTER TABLE interaction_run_metrics_next RENAME TO interaction_run_metrics;
      CREATE INDEX idx_interaction_run_metrics_run
        ON interaction_run_metrics (interaction_run_id);
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
    throw new Error(
      "Session metrics migration left invalid foreign key references",
    );
  }
}

export default migration;
