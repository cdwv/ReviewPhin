import type { DatabaseSync } from "node:sqlite";

import { getTableColumnNames, tableExists } from "./helpers.js";
import type { SqliteMigration } from "./types.js";

const migration: SqliteMigration = {
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
    if (discussionMappingColumns.has("gitlab_comment_id")) {
      database.exec(
        "ALTER TABLE discussion_mappings RENAME COLUMN gitlab_comment_id TO platform_comment_id",
      );
    }
  },
};

function resolveSnapshotTableName(database: DatabaseSync): string {
  return tableExists(database, "code_review_snapshots")
    ? "code_review_snapshots"
    : "merge_request_snapshots";
}

export default migration;
