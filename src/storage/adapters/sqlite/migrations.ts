import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "pino";

export const SQLITE_BASELINE_MIGRATION_ID = "sqlite:0001_v0_baseline";

interface SqliteMigration {
  readonly id: string;
  readonly transactional?: boolean;
  apply(database: DatabaseSync): void;
}

const LEGACY_TENANT_COLUMNS = [
  "base_url",
  "project_id",
  "api_token",
  "webhook_secret",
  "bot_user_id",
  "bot_username",
] as const;

const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
  {
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
          note_id INTEGER NOT NULL,
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
          notes_json TEXT NOT NULL,
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
          prompt_context_prior_threads INTEGER NOT NULL,
          prompt_context_notes INTEGER NOT NULL,
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
          gitlab_note_id INTEGER NOT NULL,
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
  },
  {
    id: "sqlite:0002_v1_platform_tenants",
    apply(database) {
      const tenantColumns = getTableColumnNames(database, "tenants");
      if (!hasAnyColumns(tenantColumns, ["base_url", "webhook_secret"])) {
        return;
      }
      ensureTenantPlatformColumns(database, tenantColumns);
    },
  },
  {
    id: "sqlite:0003_v1_review_entity_ids",
    apply(database) {
      const interactionJobColumns = getTableColumnNames(
        database,
        "interaction_jobs",
      );
      if (interactionJobColumns.has("project_id")) {
        database.exec(
          "ALTER TABLE interaction_jobs RENAME COLUMN project_id TO repository_id",
        );
      }
      if (interactionJobColumns.has("merge_request_iid")) {
        database.exec(
          "ALTER TABLE interaction_jobs RENAME COLUMN merge_request_iid TO code_review_id",
        );
      }

      const snapshotTableName = resolveSnapshotTableName(database);
      const snapshotColumns = getTableColumnNames(database, snapshotTableName);
      if (snapshotColumns.has("merge_request_iid")) {
        database.exec(
          `ALTER TABLE ${snapshotTableName} RENAME COLUMN merge_request_iid TO code_review_id`,
        );
      }

      const discussionMappingColumns = getTableColumnNames(
        database,
        "discussion_mappings",
      );
      if (discussionMappingColumns.has("project_id")) {
        database.exec(
          "ALTER TABLE discussion_mappings RENAME COLUMN project_id TO repository_id",
        );
      }
      if (discussionMappingColumns.has("merge_request_iid")) {
        database.exec(
          "ALTER TABLE discussion_mappings RENAME COLUMN merge_request_iid TO code_review_id",
        );
      }
      if (discussionMappingColumns.has("gitlab_discussion_id")) {
        database.exec(
          "ALTER TABLE discussion_mappings RENAME COLUMN gitlab_discussion_id TO platform_thread_id",
        );
      }
      if (discussionMappingColumns.has("gitlab_note_id")) {
        database.exec(
          "ALTER TABLE discussion_mappings RENAME COLUMN gitlab_note_id TO platform_comment_id",
        );
      }
    },
  },
  {
    id: "sqlite:0004_v1_tenant_scoped_reviews",
    apply(database) {
      const interactionJobColumns = getTableColumnNames(
        database,
        "interaction_jobs",
      );
      if (interactionJobColumns.has("repository_id")) {
        database.exec("ALTER TABLE interaction_jobs DROP COLUMN repository_id");
      }

      const discussionMappingColumns = getTableColumnNames(
        database,
        "discussion_mappings",
      );
      if (discussionMappingColumns.has("repository_id")) {
        database.exec(
          "ALTER TABLE discussion_mappings DROP COLUMN repository_id",
        );
      }
    },
  },
  {
    id: "sqlite:0005_v1_code_review_snapshots",
    apply(database) {
      if (
        tableExists(database, "merge_request_snapshots") &&
        !tableExists(database, "code_review_snapshots")
      ) {
        database.exec(
          "ALTER TABLE merge_request_snapshots RENAME TO code_review_snapshots",
        );
      }

      const snapshotColumns = getTableColumnNames(
        database,
        "code_review_snapshots",
      );
      if (snapshotColumns.has("merge_request_iid")) {
        database.exec(
          "ALTER TABLE code_review_snapshots RENAME COLUMN merge_request_iid TO code_review_id",
        );
      }
      if (snapshotColumns.has("merge_request_json")) {
        database.exec(
          "ALTER TABLE code_review_snapshots RENAME COLUMN merge_request_json TO code_review_json",
        );
      }
    },
  },
  {
    id: "sqlite:0006_v1_drop_legacy_tenant_columns",
    transactional: false,
    apply(database) {
      const tenantColumns = getTableColumnNames(database, "tenants");
      if (!hasAnyColumns(tenantColumns, LEGACY_TENANT_COLUMNS)) {
        return;
      }

      ensureTenantPlatformColumns(database, tenantColumns);
      rebuildTenantTableWithoutLegacyColumns(database);
    },
  },
];

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
    `Finished applying SQLite migrations for adapter "${adapterName}".}`,
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

function tableExists(database: DatabaseSync, tableName: string): boolean {
  const row = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    )
    .get(tableName) as { name: string } | undefined;
  return row !== undefined;
}

function getTableColumnNames(
  database: DatabaseSync,
  tableName: string,
): Set<string> {
  if (!tableExists(database, tableName)) {
    return new Set();
  }
  return new Set(
    (
      database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );
}

function hasAnyColumns(
  columnNames: ReadonlySet<string>,
  expectedColumnNames: readonly string[],
): boolean {
  return expectedColumnNames.some((columnName) => columnNames.has(columnName));
}

function ensureTenantPlatformColumns(
  database: DatabaseSync,
  tenantColumns: ReadonlySet<string>,
): void {
  if (!tenantColumns.has("platform")) {
    database.exec("ALTER TABLE tenants ADD COLUMN platform TEXT");
  }
  if (!tenantColumns.has("platform_config_json")) {
    database.exec("ALTER TABLE tenants ADD COLUMN platform_config_json TEXT");
  }

  if (tenantColumns.has("base_url")) {
    database.exec(`
      UPDATE tenants
      SET
        platform = COALESCE(platform, 'gitlab'),
        platform_config_json = COALESCE(
          platform_config_json,
          json_object(
            'baseUrl', base_url,
            'projectId', project_id,
            'apiToken', api_token,
            'webhookSecret', webhook_secret,
            'botUserId', bot_user_id,
            'botUsername', bot_username
          )
        )
    `);
    return;
  }

  if (tenantColumns.has("webhook_secret")) {
    database.exec(`
      UPDATE tenants
      SET
        platform = COALESCE(platform, 'gitlab'),
        platform_config_json = CASE
          WHEN COALESCE(platform, 'gitlab') = 'gitlab'
            AND json_extract(COALESCE(platform_config_json, json_object()), '$.webhookSecret') IS NULL
          THEN json_set(
            COALESCE(platform_config_json, json_object()),
            '$.webhookSecret',
            webhook_secret
          )
          ELSE COALESCE(platform_config_json, json_object())
        END
    `);
  }
}

function rebuildTenantTableWithoutLegacyColumns(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = OFF");

  let startedTransaction = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    startedTransaction = true;
    database.exec(`
      CREATE TABLE tenants_next (
        id TEXT PRIMARY KEY,
        tenant_key TEXT NOT NULL UNIQUE,
        platform TEXT NOT NULL,
        platform_config_json TEXT NOT NULL,
        model_profile_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO tenants_next (
        id,
        tenant_key,
        platform,
        platform_config_json,
        model_profile_name,
        created_at,
        updated_at
      )
      SELECT
        id,
        tenant_key,
        COALESCE(platform, 'gitlab'),
        platform_config_json,
        model_profile_name,
        created_at,
        updated_at
      FROM tenants;

      DROP TABLE tenants;
      ALTER TABLE tenants_next RENAME TO tenants;
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
    .all() as Array<{
    table: string;
  }>;
  if (violations.length > 0) {
    const tables = [...new Set(violations.map((violation) => violation.table))];
    throw new Error(
      `Tenant schema cleanup left invalid foreign keys in: ${tables.join(", ")}`,
    );
  }
}

function resolveSnapshotTableName(database: DatabaseSync): string {
  return tableExists(database, "code_review_snapshots")
    ? "code_review_snapshots"
    : "merge_request_snapshots";
}
