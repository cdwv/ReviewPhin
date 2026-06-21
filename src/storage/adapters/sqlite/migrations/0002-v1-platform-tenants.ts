import type { DatabaseSync } from "node:sqlite";

import { getTableColumnNames, hasAnyColumns } from "./helpers.js";
import type { SqliteMigration } from "./types.js";

const migration: SqliteMigration = {
  id: "sqlite:0002_v1_platform_tenants",
  apply(database) {
    const tenantColumns = getTableColumnNames(database, "tenants");
    if (!hasAnyColumns(tenantColumns, ["base_url", "webhook_secret"])) {
      return;
    }
    ensureTenantPlatformColumns(database, tenantColumns);
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

export default migration;
