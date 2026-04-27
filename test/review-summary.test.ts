import { describe, expect, it } from "vitest";

import { buildReviewSummaryNote } from "../src/review/summary.js";

describe("review summary note", () => {
  it("wraps the suggested fixes prompt in a fenced md block and escapes embedded fences", () => {
    const timestamp = "2026-04-27T11:00:00.000Z";
    const note = buildReviewSummaryNote({
      context: {
        tenant: {
          id: "tenant_1",
          key: "https://gitlab.example.com::123",
          baseUrl: "https://gitlab.example.com",
          projectId: 123,
          apiToken: "token",
          webhookSecret: "secret",
          botUserId: 999,
          botUsername: "review-bot",
          createdAt: timestamp,
          updatedAt: timestamp
        },
        job: {
          id: "job_1",
          tenantId: "tenant_1",
          dedupeKey: "dedupe_1",
          projectId: 123,
          mergeRequestIid: 7,
          noteId: 55,
          headSha: "abc123",
          status: "completed",
          payloadJson: "{}",
          retryCount: 0,
          lastError: null,
          enqueuedAt: timestamp,
          startedAt: timestamp,
          finishedAt: timestamp
        },
        mergeRequest: {
          id: 7,
          iid: 7,
          project_id: 123,
          title: "Add ```worker```",
          description: "Adds the worker",
          web_url: "https://gitlab.example.com/group/project/-/merge_requests/7",
          source_branch: "feature",
          target_branch: "main",
          author: {
            id: 42,
            username: "developer",
            name: "Dev User"
          }
        },
        changes: [
          {
            old_path: "src/worker.ts",
            new_path: "src/worker.ts",
            new_file: false,
            renamed_file: false,
            deleted_file: false
          }
        ],
        versions: [],
        latestVersion: null,
        notes: [],
        discussions: [],
        workspace: {
          rootPath: "H:\\dev\\gitlab-agentic-webhooks\\tmp\\review-workspaces\\run_1",
          cleanupRoot: "H:\\dev\\gitlab-agentic-webhooks\\tmp\\review-workspaces\\run_1",
          strategy: "git",
          instructionFiles: []
        },
        snapshot: {
          id: "snapshot_1",
          reviewJobId: "job_1",
          tenantId: "tenant_1",
          mergeRequestIid: 7,
          headSha: "abc123",
          mergeRequestJson: "{}",
          versionsJson: "[]",
          changesJson: "[]",
          notesJson: "[]",
          discussionsJson: "[]",
          instructionsJson: "[]",
          workspaceStrategy: "git",
          createdAt: timestamp
        }
      },
      reviewResult: {
        overview: {
          summary: "One fix remains",
          overallSeverity: "high"
        },
        findings: [
          {
            title: "Escape fenced prompt content",
            body: "Preserve content like ```ts\nconst status = \"blocked\";\n``` in the copied prompt.",
            severity: "high",
            category: "correctness"
          }
        ],
        priorDispositions: []
      },
      reviewedAt: new Date(timestamp)
    });

    expect(note).toContain("<details><summary>Suggested fixes prompt</summary>");
    expect(note).toContain("```md\nReview and fix the issues called out for merge request \"Add \\`\\`\\`worker\\`\\`\\`\"");
    expect(note).toContain("Preserve content like \\`\\`\\`ts");
    expect(note).toContain("\n```\n\n</details>");
  });
});
