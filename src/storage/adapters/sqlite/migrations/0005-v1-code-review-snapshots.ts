import { getTableColumnNames, tableExists } from "./helpers.js";
import type { SqliteMigration } from "./types.js";

const migration: SqliteMigration = {
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
};

export default migration;
