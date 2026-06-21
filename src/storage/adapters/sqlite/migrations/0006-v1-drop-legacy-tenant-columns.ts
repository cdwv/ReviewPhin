import type { DatabaseSync } from "node:sqlite";

import { getTableColumnNames, hasAnyColumns } from "./helpers.js";
import type { SqliteMigration } from "./types.js";

const LEGACY_TENANT_COLUMNS = [
  "base_url",
  "project_id",
  "api_token",
  "webhook_secret",
  "bot_user_id",
  "bot_username",
] as const;

const migration: SqliteMigration = {
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
};

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
    .all() as Array<{ table: string }>;
  if (violations.length > 0) {
    const tables = [...new Set(violations.map((violation) => violation.table))];
    throw new Error(
      `Tenant schema cleanup left invalid foreign keys in: ${tables.join(", ")}`,
    );
  }
}

export default migration;
