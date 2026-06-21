import { getTableColumnNames } from "./helpers.js";
import type { SqliteMigration } from "./types.js";

const migration: SqliteMigration = {
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
};

export default migration;
