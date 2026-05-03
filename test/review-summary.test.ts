import { describe, expect, it } from "vitest";

import { buildReviewSummaryNote } from "../src/review/summary.js";
import { tmpPath } from "./test-paths.js";

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
          modelProfileName: null,
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
          rootPath: tmpPath("review-workspaces", "run_1"),
          cleanupRoot: tmpPath("review-workspaces", "run_1"),
          strategy: "git",
          instructionFiles: []
        },
        projectMemory: {
          enabled: true,
          page: null,
          entries: []
        },
        snapshot: {
          id: "snapshot_1",
          interactionJobId: "job_1",
          tenantId: "tenant_1",
          mergeRequestIid: 7,
          headSha: "abc123",
          mergeRequestJson: "{}",
          versionsJson: "[]",
          changesJson: "[]",
           notesJson: "[]",
           discussionsJson: "[]",
           instructionsJson: "[]",
           projectMemoryJson: null,
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

  it("uses active persisted findings in the suggested fixes prompt when the current run only resolves threads", () => {
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
          modelProfileName: null,
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
          title: "Keep storage state visible",
          description: "Adds storage migration follow-up",
          web_url: "https://gitlab.example.com/group/project/-/merge_requests/7",
          source_branch: "feature",
          target_branch: "main",
          author: {
            id: 42,
            username: "developer",
            name: "Dev User"
          }
        },
        changes: [],
        versions: [],
        latestVersion: null,
        notes: [],
        discussions: [],
        workspace: {
          rootPath: tmpPath("review-workspaces", "run_2"),
          cleanupRoot: tmpPath("review-workspaces", "run_2"),
          strategy: "git",
          instructionFiles: []
        },
        projectMemory: {
          enabled: true,
          page: null,
          entries: []
        },
        snapshot: {
          id: "snapshot_2",
          interactionJobId: "job_1",
          tenantId: "tenant_1",
          mergeRequestIid: 7,
          headSha: "abc123",
          mergeRequestJson: "{}",
          versionsJson: "[]",
          changesJson: "[]",
          notesJson: "[]",
          discussionsJson: "[]",
          instructionsJson: "[]",
          projectMemoryJson: null,
          workspaceStrategy: "git",
          createdAt: timestamp
        }
      },
      reviewResult: {
        overview: {
          summary: "One thread was dismissed, but merge readiness still depends on an older open storage fix.",
          overallSeverity: "medium",
          mergeReadiness: {
            status: "needs_attention",
            confidence: "medium",
            summary: "Ready to dismiss the targeted migration thread, but still needs the remaining storage correctness fix from the previous review."
          }
        },
        findings: [],
        priorDispositions: []
      },
      activeFindings: [
        {
          title: "Keep latest completed finding status in sync",
          body: "Status writes should update the latest completed finding row so future re-reviews read the same state that reconciliation writes.",
          severity: "medium",
          category: "correctness"
        }
      ],
      reviewedAt: new Date(timestamp)
    });

    expect(note).toContain("- **Findings snapshot:** 1 finding (1 medium)");
    expect(note).toContain("Keep latest completed finding status in sync");
    expect(note).toContain("Status writes should update the latest completed finding row");
  });

  it("does not report ready when persisted open findings remain after a rerun", () => {
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
          modelProfileName: null,
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
          title: "Keep summary readiness aligned",
          description: "Resolves one thread",
          web_url: "https://gitlab.example.com/group/project/-/merge_requests/7",
          source_branch: "feature",
          target_branch: "main",
          author: {
            id: 42,
            username: "developer",
            name: "Dev User"
          }
        },
        changes: [],
        versions: [],
        latestVersion: null,
        notes: [],
        discussions: [],
        workspace: {
          rootPath: tmpPath("review-workspaces", "run_3"),
          cleanupRoot: tmpPath("review-workspaces", "run_3"),
          strategy: "git",
          instructionFiles: []
        },
        projectMemory: {
          enabled: true,
          page: null,
          entries: []
        },
        snapshot: {
          id: "snapshot_3",
          interactionJobId: "job_1",
          tenantId: "tenant_1",
          mergeRequestIid: 7,
          headSha: "abc123",
          mergeRequestJson: "{}",
          versionsJson: "[]",
          changesJson: "[]",
          notesJson: "[]",
          discussionsJson: "[]",
          instructionsJson: "[]",
          projectMemoryJson: null,
          workspaceStrategy: "git",
          createdAt: timestamp
        }
      },
      reviewResult: {
        overview: {
          summary: "The targeted rerun looks good.",
          overallAssessment: "The targeted rerun looks good.",
          overallSeverity: "low",
          mergeReadiness: {
            status: "ready",
            confidence: "high",
            summary: "No blocking issues were found in this rerun."
          },
          highlights: ["The rerun resolved the directly requested thread."]
        },
        findings: [],
        priorDispositions: []
      },
      activeFindings: [
        {
          title: "Keep latest completed finding status in sync",
          body: "Status writes should update the latest completed finding row so future re-reviews read the same state that reconciliation writes.",
          severity: "medium",
          category: "correctness"
        }
      ],
      reviewedAt: new Date(timestamp)
    });

    expect(note).toContain("Persisted open findings remain after reconciling the latest review");
    expect(note).toContain("- **Status:** Needs attention");
    expect(note).toContain("- **Confidence:** Medium");
    expect(note).toContain("- **Rationale:** Persisted open findings remain and should be reviewed before merge.");
    expect(note).toContain("- **Overall severity:** Medium");
    expect(note).toContain("<details><summary>Suggested fixes prompt</summary>");
    expect(note).not.toContain("- **Status:** Ready");
  });
});
