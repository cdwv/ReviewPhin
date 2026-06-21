import type { DatabaseSync } from "node:sqlite";

import { normalizeGitLabBaseUrl } from "../../../../platforms/gitlab/url.js";
import { createId } from "../../../../utils/ids.js";
import { getTableColumnNames } from "./helpers.js";
import type { SqliteMigration } from "./types.js";

const migration: SqliteMigration = {
  id: "sqlite:0008_v2_platform_connections",
  transactional: false,
  apply(database) {
    migratePlatformConnections(database);
  },
};

function migratePlatformConnections(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = OFF");
  let startedTransaction = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    startedTransaction = true;
    database.exec(`
      CREATE TABLE IF NOT EXISTS platform_connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        platform TEXT NOT NULL,
        status TEXT NOT NULL,
        platform_connection_config_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const tenantColumns = getTableColumnNames(database, "tenants");
    if (!tenantColumns.has("platform_connection_id")) {
      database.exec(
        "ALTER TABLE tenants ADD COLUMN platform_connection_id TEXT",
      );
    }

    const tenants = database
      .prepare(
        "SELECT id, platform, platform_config_json, created_at, updated_at FROM tenants ORDER BY created_at, id",
      )
      .all() as Array<{
      id: string;
      platform: string;
      platform_config_json: string;
      created_at: string;
      updated_at: string;
    }>;
    const connectionByCredentialSet = new Map<string, string>();
    const usedNames = new Set(
      (
        database
          .prepare("SELECT name FROM platform_connections")
          .all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );

    for (const tenant of tenants) {
      if (tenant.platform !== "gitlab") {
        throw new Error(
          `Cannot migrate tenant ${tenant.id}: unsupported platform ${tenant.platform}`,
        );
      }

      const migrated = parseMigratedGitLabConfig(tenant.platform_config_json);
      const identity = migrated.ready
        ? JSON.stringify([
            migrated.connectionConfig.baseUrl,
            migrated.connectionConfig.apiToken,
            migrated.connectionConfig.botUserId,
          ])
        : `malformed:${tenant.id}`;
      let connectionId = connectionByCredentialSet.get(identity);
      if (!connectionId) {
        connectionId = createId("connection");
        connectionByCredentialSet.set(identity, connectionId);
        const name = nextConnectionName(
          slugifyGitLabBaseUrl(migrated.connectionConfig.baseUrl),
          usedNames,
        );
        database
          .prepare(
            `INSERT INTO platform_connections (
              id, name, platform, status, platform_connection_config_json,
              created_at, updated_at
            ) VALUES (?, ?, 'gitlab', ?, ?, ?, ?)`,
          )
          .run(
            connectionId,
            name,
            migrated.ready ? "ready" : "setup_required",
            JSON.stringify(migrated.connectionConfig),
            tenant.created_at,
            tenant.updated_at,
          );
      }

      database
        .prepare(
          "UPDATE tenants SET platform_connection_id = ?, platform_config_json = ? WHERE id = ?",
        )
        .run(connectionId, JSON.stringify(migrated.tenantConfig), tenant.id);
    }

    database.exec(`
      CREATE TABLE tenants_v2 (
        id TEXT PRIMARY KEY,
        tenant_key TEXT NOT NULL UNIQUE,
        platform TEXT NOT NULL,
        platform_connection_id TEXT NOT NULL,
        platform_config_json TEXT NOT NULL,
        model_profile_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (platform_connection_id) REFERENCES platform_connections(id)
      );
      INSERT INTO tenants_v2
      SELECT id, tenant_key, platform, platform_connection_id,
        platform_config_json, model_profile_name, created_at, updated_at
      FROM tenants;
      DROP TABLE tenants;
      ALTER TABLE tenants_v2 RENAME TO tenants;
      CREATE INDEX tenants_platform_connection_id_idx
      ON tenants (platform_connection_id);
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
}

function parseMigratedGitLabConfig(value: string): {
  ready: boolean;
  tenantConfig: Record<string, unknown>;
  connectionConfig: Record<string, unknown>;
} {
  let config: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    }
  } catch {
    // Preserve malformed records as setup-required connections.
  }

  const tenantConfig = pickDefined(config, ["projectId", "webhookSecret"]);
  const connectionConfig = pickDefined(config, [
    "baseUrl",
    "apiToken",
    "botUserId",
    "botUsername",
  ]);
  const ready =
    typeof connectionConfig.baseUrl === "string" &&
    isValidUrl(connectionConfig.baseUrl) &&
    typeof connectionConfig.apiToken === "string" &&
    connectionConfig.apiToken.length > 0 &&
    typeof connectionConfig.botUserId === "number" &&
    Number.isInteger(connectionConfig.botUserId) &&
    connectionConfig.botUserId > 0 &&
    typeof connectionConfig.botUsername === "string" &&
    connectionConfig.botUsername.length > 0 &&
    typeof tenantConfig.projectId === "number" &&
    Number.isInteger(tenantConfig.projectId) &&
    tenantConfig.projectId > 0 &&
    typeof tenantConfig.webhookSecret === "string" &&
    tenantConfig.webhookSecret.length > 0;

  if (typeof connectionConfig.baseUrl === "string") {
    connectionConfig.baseUrl = normalizeMigratedBaseUrl(
      connectionConfig.baseUrl,
    );
  }

  return { ready, tenantConfig, connectionConfig };
}

function pickDefined(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    keys
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, source[key]]),
  );
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeMigratedBaseUrl(value: string): string {
  try {
    return normalizeGitLabBaseUrl(value);
  } catch {
    return value;
  }
}

function slugifyGitLabBaseUrl(value: unknown): string {
  if (typeof value !== "string") {
    return "unknown";
  }
  try {
    const labels = new URL(value).hostname.toLowerCase().split(".");
    if (labels.length > 1) {
      labels.pop();
    }
    return (
      labels
        .join("-")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "unknown"
    );
  } catch {
    return "unknown";
  }
}

function nextConnectionName(base: string, usedNames: Set<string>): string {
  let name = base;
  for (let suffix = 1; usedNames.has(name); suffix += 1) {
    name = `${base}-${suffix}`;
  }
  usedNames.add(name);
  return name;
}

export default migration;
