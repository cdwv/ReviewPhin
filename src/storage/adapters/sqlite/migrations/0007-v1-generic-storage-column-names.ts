import { renameColumnIfNeeded } from "./helpers.js";
import type { SqliteMigration } from "./types.js";

const migration: SqliteMigration = {
  id: "sqlite:0007_v1_generic_storage_column_names",
  apply(database) {
    renameColumnIfNeeded(database, "interaction_jobs", "note_id", "comment_id");
    renameColumnIfNeeded(
      database,
      "code_review_snapshots",
      "notes_json",
      "comments_json",
    );
    renameColumnIfNeeded(
      database,
      "interaction_run_metrics",
      "prompt_context_prior_threads",
      "prompt_context_prior_discussions",
    );
    renameColumnIfNeeded(
      database,
      "interaction_run_metrics",
      "prompt_context_notes",
      "prompt_context_comments",
    );
    renameColumnIfNeeded(
      database,
      "discussion_mappings",
      "platform_thread_id",
      "platform_discussion_id",
    );
    renameColumnIfNeeded(
      database,
      "discussion_mappings",
      "bot_note",
      "bot_comment",
    );
    renameColumnIfNeeded(
      database,
      "discussion_mappings",
      "note_author_id",
      "comment_author_id",
    );
    renameColumnIfNeeded(
      database,
      "discussion_mappings",
      "note_author_username",
      "comment_author_username",
    );
  },
};

export default migration;
