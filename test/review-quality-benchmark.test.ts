import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

describe("review quality benchmark evidence", () => {
  it("does not borrow a newer job snapshot for an older run", () => {
    const workspace = mkdtempSync(join(tmpdir(), "review-quality-benchmark-"));
    const databasePath = join(workspace, "review-worker.sqlite");
    const logsPath = join(workspace, "run-logs");
    mkdirSync(logsPath);

    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        CREATE TABLE tenants (
          id TEXT PRIMARY KEY,
          tenant_key TEXT NOT NULL,
          platform TEXT NOT NULL
        );
        CREATE TABLE interaction_jobs (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          code_review_id INTEGER NOT NULL,
          trigger_json TEXT,
          head_sha TEXT
        );
        CREATE TABLE interaction_runs (
          id TEXT PRIMARY KEY,
          interaction_job_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT,
          status TEXT NOT NULL,
          result_json TEXT,
          error TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          model_profile_name TEXT,
          provider_type TEXT,
          text_generation_model TEXT
        );
        CREATE TABLE interaction_run_metrics (
          id TEXT PRIMARY KEY,
          interaction_run_id TEXT NOT NULL,
          harness TEXT,
          harness_session_key TEXT,
          session_type TEXT,
          trigger_kind TEXT,
          prompt_mode TEXT,
          prompt_chars INTEGER,
          prompt_context_changed_files INTEGER,
          prompt_context_prior_discussions INTEGER,
          prompt_context_comments INTEGER,
          assistant_turns INTEGER,
          assistant_calls INTEGER,
          tool_executions INTEGER,
          view_tool_calls INTEGER,
          glob_tool_calls INTEGER,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cache_read_tokens INTEGER,
          cache_write_tokens INTEGER,
          reasoning_tokens INTEGER,
          api_duration_ms INTEGER,
          usage_unit TEXT,
          usage_amount REAL,
          repeated_view_reads INTEGER,
          repeated_view_paths_json TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE code_review_snapshots (
          id TEXT PRIMARY KEY,
          interaction_job_id TEXT NOT NULL,
          interaction_run_id TEXT,
          code_review_json TEXT,
          versions_json TEXT,
          changes_json TEXT,
          comments_json TEXT,
          discussions_json TEXT,
          instructions_json TEXT,
          project_memory_json TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE review_findings (
          id TEXT PRIMARY KEY,
          interaction_run_id TEXT NOT NULL,
          identity_key TEXT,
          severity TEXT,
          category TEXT,
          title TEXT,
          body TEXT,
          anchor_json TEXT,
          suggestion_json TEXT,
          status TEXT,
          created_at TEXT NOT NULL
        );
      `);
      database
        .prepare(
          "INSERT INTO tenants (id, tenant_key, platform) VALUES (?, ?, ?)",
        )
        .run("tenant-1", "https://git.example::1", "gitlab");
      database
        .prepare(
          "INSERT INTO interaction_jobs (id, tenant_id, code_review_id, trigger_json, head_sha) VALUES (?, ?, ?, ?, ?)",
        )
        .run("job-1", "tenant-1", 1, "{}", "old-head");
      database
        .prepare(
          `INSERT INTO interaction_runs (
             id, interaction_job_id, tenant_id, provider, status, result_json,
             started_at, finished_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "run-old",
          "job-1",
          "tenant-1",
          "copilot-sdk",
          "completed",
          JSON.stringify({
            overview: {
              summary: "The older review completed.",
              overallSeverity: "low",
              overallAssessment: "Ready.",
              mergeReadiness: {
                status: "ready",
                confidence: "high",
                summary: "No findings.",
              },
              highlights: [],
            },
            findings: [],
            priorDispositions: [],
          }),
          "2026-04-28T08:00:00.000Z",
          "2026-04-28T08:01:00.000Z",
        );
      database
        .prepare(
          "INSERT INTO interaction_run_metrics (id, interaction_run_id, prompt_mode, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          "metric-old",
          "run-old",
          "first-pass-full",
          "2026-04-28T08:01:00.000Z",
        );
      database
        .prepare(
          `INSERT INTO code_review_snapshots (
             id, interaction_job_id, interaction_run_id, code_review_json,
             versions_json, changes_json, comments_json, discussions_json,
             instructions_json, project_memory_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "snapshot-newer",
          "job-1",
          "run-newer",
          JSON.stringify({ title: "Later retry state" }),
          "[]",
          JSON.stringify([{ new_path: "later.ts", diff: "+later" }]),
          "[]",
          "[]",
          "[]",
          "null",
          "2026-04-28T09:00:00.000Z",
        );
    } finally {
      database.close();
    }

    try {
      execFileSync(
        process.execPath,
        [
          resolve(
            ".agents/skills/review-quality-benchmark/scripts/benchmark.mjs",
          ),
          "prepare",
          "--workspace",
          workspace,
          "--db",
          databasePath,
          "--logs",
          logsPath,
          "--from",
          "2026-04-28",
          "--to",
          "2026-04-28",
          "--judge-model",
          "test-judge",
        ],
        { stdio: "pipe" },
      );

      const packet = JSON.parse(
        readFileSync(
          join(
            workspace,
            "benchmark-report",
            "tmp",
            "packets",
            "run-old.json",
          ),
          "utf8",
        ),
      ) as {
        evidence: {
          codeReview: { details: unknown; changedFiles: unknown[] };
        };
      };

      expect(packet.evidence.codeReview.details).toBeNull();
      expect(packet.evidence.codeReview.changedFiles).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
