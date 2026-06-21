import type { SqliteMigration } from "./types.js";

export const SQLITE_BASELINE_MIGRATION_ID = "sqlite:0001_v0_baseline";

const migration: SqliteMigration = {
  id: SQLITE_BASELINE_MIGRATION_ID,
  apply(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS model_profiles (
        name TEXT PRIMARY KEY,
        provider_base_url TEXT,
        provider_type TEXT,
        wire_api TEXT,
        auth_token TEXT,
        review_model TEXT,
        text_generation_model TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY,
        tenant_key TEXT NOT NULL UNIQUE,
        base_url TEXT NOT NULL,
        project_id INTEGER NOT NULL,
        api_token TEXT NOT NULL,
        webhook_secret TEXT NOT NULL,
        bot_user_id INTEGER NOT NULL,
        bot_username TEXT NOT NULL,
        model_profile_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS interaction_jobs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        project_id INTEGER NOT NULL,
        merge_request_iid INTEGER NOT NULL,
        comment_id INTEGER NOT NULL,
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

      CREATE TABLE IF NOT EXISTS code_review_snapshots (
        id TEXT PRIMARY KEY,
        interaction_job_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        code_review_id INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        code_review_json TEXT NOT NULL,
        versions_json TEXT NOT NULL,
        changes_json TEXT NOT NULL,
        comments_json TEXT NOT NULL,
        discussions_json TEXT NOT NULL,
        instructions_json TEXT NOT NULL,
        project_memory_json TEXT,
        workspace_strategy TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (interaction_job_id) REFERENCES interaction_jobs(id),
        FOREIGN KEY (tenant_id) REFERENCES tenants(id)
      );

      CREATE TABLE IF NOT EXISTS interaction_runs (
        id TEXT PRIMARY KEY,
        interaction_job_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        model_profile_name TEXT,
        provider_base_url TEXT,
        provider_type TEXT,
        text_generation_model TEXT,
        status TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        FOREIGN KEY (interaction_job_id) REFERENCES interaction_jobs(id),
        FOREIGN KEY (tenant_id) REFERENCES tenants(id)
      );

      CREATE TABLE IF NOT EXISTS review_findings (
        id TEXT PRIMARY KEY,
        interaction_run_id TEXT NOT NULL,
        identity_key TEXT NOT NULL,
        severity TEXT NOT NULL,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        anchor_json TEXT,
        suggestion_json TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        FOREIGN KEY (interaction_run_id) REFERENCES interaction_runs(id)
      );

      CREATE TABLE IF NOT EXISTS interaction_run_metrics (
        id TEXT PRIMARY KEY,
        interaction_run_id TEXT NOT NULL UNIQUE,
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
        premium_requests INTEGER NOT NULL,
        repeated_view_reads INTEGER NOT NULL,
        repeated_view_paths_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (interaction_run_id) REFERENCES interaction_runs(id)
      );

      CREATE TABLE IF NOT EXISTS discussion_mappings (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        project_id INTEGER NOT NULL,
        merge_request_iid INTEGER NOT NULL,
        identity_key TEXT NOT NULL,
        finding_fingerprint TEXT NOT NULL,
        title TEXT NOT NULL,
        severity TEXT NOT NULL,
        category TEXT NOT NULL,
        body TEXT NOT NULL,
        gitlab_discussion_id TEXT NOT NULL,
        gitlab_comment_id INTEGER NOT NULL,
        anchor_json TEXT,
        position_json TEXT,
        bot_discussion INTEGER NOT NULL,
        bot_note INTEGER NOT NULL,
        note_author_id INTEGER,
        note_author_username TEXT,
        status TEXT NOT NULL,
        last_interaction_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id),
        FOREIGN KEY (last_interaction_run_id) REFERENCES interaction_runs(id),
        UNIQUE(tenant_id, merge_request_iid, gitlab_discussion_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS model_profiles_single_default_idx
      ON model_profiles (is_default)
      WHERE is_default = 1;

      CREATE UNIQUE INDEX IF NOT EXISTS review_findings_interaction_run_identity_key_idx
      ON review_findings (interaction_run_id, identity_key);
    `);
  },
};

export default migration;
