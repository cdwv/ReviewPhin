import { interactionRequestId } from "../../../interaction-batches.js";
import type { SqliteMigration } from "./types.js";
import { tableExists } from "./helpers.js";

const migration: SqliteMigration = {
  id: "sqlite:0013_v7_interaction_batches",
  apply(database) {
    if (tableExists(database, "model_profiles"))
      database.exec(
        "ALTER TABLE model_profiles ADD COLUMN routing_model TEXT; ALTER TABLE model_profiles ADD COLUMN routing_reasoning_effort TEXT;",
      );
    if (tableExists(database, "interaction_runs"))
      database.exec(
        "ALTER TABLE interaction_runs ADD COLUMN replies_json TEXT;",
      );
    if (!tableExists(database, "interaction_jobs")) return;
    database.exec(`
      ALTER TABLE interaction_jobs ADD COLUMN batch_kind TEXT CHECK(batch_kind IS NULL OR batch_kind = 'comment');
      CREATE TABLE interaction_requests (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        code_review_id INTEGER NOT NULL,
        dedupe_key TEXT NOT NULL,
        interaction_job_id TEXT REFERENCES interaction_jobs(id) ON DELETE CASCADE,
        comment_id INTEGER,
        trigger_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        received_at TEXT NOT NULL,
        admitted_at TEXT,
        debounce_ms INTEGER NOT NULL DEFAULT 0,
        UNIQUE(tenant_id, dedupe_key)
      );
      CREATE INDEX interaction_requests_job_idx ON interaction_requests(interaction_job_id, received_at, id);
    `);
    const insert = database.prepare(`INSERT INTO interaction_requests
      (id, tenant_id, code_review_id, dedupe_key, interaction_job_id, comment_id, trigger_json, payload_json, head_sha, received_at, admitted_at, debounce_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`);
    for (const job of database
      .prepare("SELECT * FROM interaction_jobs")
      .iterate()) {
      insert.run(
        interactionRequestId(String(job.tenant_id), String(job.dedupe_key)),
        job.tenant_id!,
        job.code_review_id!,
        job.dedupe_key!,
        job.id!,
        job.comment_id!,
        job.trigger_json!,
        job.payload_json!,
        job.head_sha!,
        job.enqueued_at!,
        job.enqueued_at!,
      );
    }
  },
};
export default migration;
