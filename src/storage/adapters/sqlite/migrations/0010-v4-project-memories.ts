import type { DatabaseSync } from "node:sqlite";

import { getTableColumnNames } from "./helpers.js";
import type { SqliteMigration } from "./types.js";

const migration: SqliteMigration = {
  id: "sqlite:0010_v4_project_memories",
  transactional: true,
  apply(database: DatabaseSync) {
    const columns = getTableColumnNames(database, "project_memories");
    if (columns.has("id")) {
      return;
    }

    database.exec(`
      CREATE TABLE project_memories (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL UNIQUE,
        entries_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id)
      );
    `);
  },
};

export default migration;
