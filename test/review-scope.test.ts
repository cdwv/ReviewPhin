import { describe, expect, it } from "vitest";

import { buildScopedReviewContext } from "../src/review/review-scope.js";
import type { ProviderThreadContext } from "../src/review/types.js";
import { repoPath } from "./test-paths.js";

const mergeRequest = {
  id: 1,
  iid: 7,
  project_id: 123,
  title: "Improve review scoping",
  description: "Optimizes how review context is prepared.",
  web_url: "https://gitlab.example.com/group/project/-/merge_requests/7",
  source_branch: "feature",
  target_branch: "main",
  author: {
    id: 42,
    username: "developer",
    name: "Dev User",
  },
};

describe("buildScopedReviewContext", () => {
  it("uses incremental re-review mode when a previous completed review exists", () => {
    const scoped = buildScopedReviewContext({
      workspacePath: repoPath(),
      mergeRequest,
      changes: [
        createChange("src/existing.ts", "@@ -1 +1 @@\n-old\n+old"),
        createChange("src/delta.ts", "@@ -1 +1 @@\n-old\n+new"),
      ],
      notes: [createNote(1, "Looks good")],
      discussions: [],
      instructionFiles: [],
      trigger: {
        kind: "direct-mention",
        noteId: 55,
        authorUsername: "developer",
        body: "@review-bot review",
        instruction: "review",
        targetThreadId: null,
        targetDiscussionId: null,
        targetThreadTitle: null,
        responseTarget: createResponseTarget(
          "direct-mention",
          55,
          "@review-bot review",
          "review",
        ),
      },
      priorThreads: [
        createThread(
          "map_1",
          "disc_1",
          "Existing finding",
          "src/existing.ts",
          false,
        ),
      ],
      previousReview: {
        reviewRunId: "run_prev",
        finishedAt: "2026-04-27T12:00:00.000Z",
        headSha: "prevhead",
        resultJson: JSON.stringify({
          overview: {
            summary: "Needs work",
            overallSeverity: "medium",
            mergeReadiness: {
              status: "needs_attention",
              confidence: "medium",
              summary: "A prior issue remained open.",
            },
          },
          findings: [
            {
              title: "Existing finding",
              body: "Original body",
              severity: "medium",
              category: "correctness",
              anchor: {
                path: "src/existing.ts",
                startLine: 1,
                endLine: 1,
                side: "new",
              },
            },
          ],
          priorDispositions: [],
        }),
        changesJson: JSON.stringify([
          createChange("src/existing.ts", "@@ -1 +1 @@\n-old\n+old"),
        ]),
      },
    });

    expect(scoped.scope.mode).toBe("incremental-rereview");
    expect(scoped.changes).toHaveLength(2);
    expect(scoped.changes.map((change) => change.new_path)).toEqual([
      "src/existing.ts",
      "src/delta.ts",
    ]);
    expect(scoped.scope.previousReview?.reviewRunId).toBe("run_prev");
    expect(scoped.scope.deltaSincePreviousReview?.changedFiles).toHaveLength(1);
  });

  it("keeps open prior findings in incremental focus even without live unresolved threads", () => {
    const scoped = buildScopedReviewContext({
      workspacePath: repoPath(),
      mergeRequest,
      changes: [
        createChange("src/existing.ts", "@@ -1 +1 @@\n-old\n+old"),
        createChange("src/delta.ts", "@@ -1 +1 @@\n-old\n+new"),
      ],
      notes: [],
      discussions: [],
      instructionFiles: [],
      trigger: {
        kind: "direct-mention",
        noteId: 57,
        authorUsername: "developer",
        body: "@review-bot review again",
        instruction: "review again",
        targetThreadId: null,
        targetDiscussionId: null,
        targetThreadTitle: null,
        responseTarget: createResponseTarget(
          "direct-mention",
          57,
          "@review-bot review again",
          "review again",
        ),
      },
      priorThreads: [],
      priorFindings: [
        {
          findingId: "finding_1",
          identityKey: "identity_existing",
          status: "open",
          title: "Existing finding",
          body: "Original body",
          severity: "medium",
          category: "correctness",
          anchor: {
            path: "src/existing.ts",
            startLine: 1,
            endLine: 1,
            side: "new",
          },
          suggestion: null,
          reviewRunId: "run_prev",
          reviewedAt: "2026-04-27T12:00:00.000Z",
          headSha: "prevhead",
        },
      ],
      previousReview: {
        reviewRunId: "run_prev",
        finishedAt: "2026-04-27T12:00:00.000Z",
        headSha: "prevhead",
        resultJson: JSON.stringify({
          overview: {
            summary: "Needs work",
            overallSeverity: "medium",
          },
          findings: [],
          priorDispositions: [],
        }),
        changesJson: JSON.stringify([
          createChange("src/existing.ts", "@@ -1 +1 @@\n-old\n+old"),
        ]),
      },
    });

    expect(scoped.changes.map((change) => change.new_path)).toEqual([
      "src/existing.ts",
      "src/delta.ts",
    ]);
    expect(scoped.scope.priorFindings).toHaveLength(1);
    expect(scoped.scope.priorFindings[0]?.status).toBe("open");
  });

  it("routes summary follow-up triggers through incremental re-review when a previous review exists", () => {
    const scoped = buildScopedReviewContext({
      workspacePath: repoPath(),
      mergeRequest,
      changes: [createChange("src/delta.ts", "@@ -1 +1 @@\n-old\n+new")],
      notes: [],
      discussions: [],
      instructionFiles: [],
      trigger: {
        kind: "summary-follow-up",
        noteId: 90,
        authorUsername: "developer",
        body: "For future reference, prefer tasteful dolphin jokes in the overall assessment when they fit.",
        instruction:
          "For future reference, prefer tasteful dolphin jokes in the overall assessment when they fit.",
        targetThreadId: null,
        targetDiscussionId: null,
        targetThreadTitle: null,
        responseTarget: createResponseTarget(
          "summary-follow-up",
          90,
          "For future reference, prefer tasteful dolphin jokes in the overall assessment when they fit.",
          "For future reference, prefer tasteful dolphin jokes in the overall assessment when they fit.",
          "disc_summary",
        ),
      },
      priorThreads: [],
      previousReview: {
        reviewRunId: "run_prev",
        finishedAt: "2026-04-27T12:00:00.000Z",
        headSha: "prevhead",
        resultJson: JSON.stringify({
          overview: {
            summary: "Prior pass",
            overallSeverity: "low",
          },
          findings: [],
          priorDispositions: [],
        }),
        changesJson: JSON.stringify([]),
      },
    });

    expect(scoped.scope.mode).toBe("incremental-rereview");
    expect(scoped.scope.scopeSummary).toContain(
      "summary note requested another review pass",
    );
  });

  it("keeps current MR diffs for incremental re-reviews when there is no delta", () => {
    const scoped = buildScopedReviewContext({
      workspacePath: repoPath(),
      mergeRequest,
      changes: [
        createChange("src/same-head-a.ts", "@@ -1 +1 @@\n-old-a\n+new-a"),
        createChange("src/same-head-b.ts", "@@ -1 +1 @@\n-old-b\n+new-b"),
      ],
      notes: [createNote(1, "Looks good")],
      discussions: [],
      instructionFiles: [],
      trigger: {
        kind: "direct-mention",
        noteId: 56,
        authorUsername: "developer",
        body: "@review-bot review again",
        instruction: "review again",
        targetThreadId: null,
        targetDiscussionId: null,
        targetThreadTitle: null,
        responseTarget: createResponseTarget(
          "direct-mention",
          56,
          "@review-bot review again",
          "review again",
        ),
      },
      priorThreads: [],
      previousReview: {
        reviewRunId: "run_prev",
        finishedAt: "2026-04-27T12:00:00.000Z",
        headSha: "samehead",
        resultJson: JSON.stringify({
          overview: {
            summary: "Prior pass",
            overallSeverity: "low",
          },
          findings: [],
          priorDispositions: [],
        }),
        changesJson: JSON.stringify([
          createChange("src/same-head-a.ts", "@@ -1 +1 @@\n-old-a\n+new-a"),
          createChange("src/same-head-b.ts", "@@ -1 +1 @@\n-old-b\n+new-b"),
        ]),
      },
    });

    expect(scoped.scope.mode).toBe("incremental-rereview");
    expect(scoped.scope.deltaSincePreviousReview?.changedFiles).toEqual([]);
    expect(scoped.changes.map((change) => change.new_path)).toEqual([
      "src/same-head-a.ts",
      "src/same-head-b.ts",
    ]);
  });

  it("keeps follow-up reviews focused on the target thread and related file", () => {
    const targetThread = createThread(
      "map_target",
      "disc_target",
      "Target finding",
      "src/target.ts",
      false,
    );
    const otherThread = createThread(
      "map_other",
      "disc_other",
      "Other finding",
      "src/other.ts",
      false,
    );
    const scoped = buildScopedReviewContext({
      workspacePath: repoPath(),
      mergeRequest,
      changes: [
        createChange("src/target.ts", "@@ -1 +1 @@\n-old\n+new"),
        createChange("src/other.ts", "@@ -1 +1 @@\n-old\n+new"),
      ],
      notes: [createNote(1, "General MR note")],
      discussions: [
        {
          id: "disc_target",
          individual_note: false,
          notes: [createDiscussionNote(10, "Target finding")],
        },
        {
          id: "disc_other",
          individual_note: false,
          notes: [createDiscussionNote(11, "Other finding")],
        },
      ],
      instructionFiles: [],
      trigger: {
        kind: "follow-up-comment",
        noteId: 77,
        authorUsername: "developer",
        body: "Please reword this.",
        instruction: "Please reword this.",
        targetThreadId: "map_target",
        targetDiscussionId: "disc_target",
        targetThreadTitle: "Target finding",
        responseTarget: createResponseTarget(
          "follow-up-comment",
          77,
          "Please reword this.",
          "Please reword this.",
          "disc_target",
        ),
      },
      priorThreads: [targetThread, otherThread],
      previousReview: null,
    });

    expect(scoped.scope.mode).toBe("follow-up-thread");
    expect(scoped.priorThreads).toEqual([targetThread]);
    expect(scoped.changes).toHaveLength(1);
    expect(scoped.changes[0]?.new_path).toBe("src/target.ts");
    expect(scoped.notes).toEqual([]);
  });

  it("keeps follow-up reviews pinned to focused files even when the target file is no longer in MR changes", () => {
    const targetThread = createThread(
      "map_target",
      "disc_target",
      "Target finding",
      "src/target.ts",
      false,
    );
    const scoped = buildScopedReviewContext({
      workspacePath: repoPath(),
      mergeRequest,
      changes: [createChange("src/other.ts", "@@ -1 +1 @@\n-old\n+new")],
      notes: [createNote(1, "General MR note")],
      discussions: [
        {
          id: "disc_target",
          individual_note: false,
          notes: [createDiscussionNote(10, "Target finding")],
        },
      ],
      instructionFiles: [],
      trigger: {
        kind: "follow-up-comment",
        noteId: 78,
        authorUsername: "developer",
        body: "Please re-check the prior thread.",
        instruction: "Please re-check the prior thread.",
        targetThreadId: "map_target",
        targetDiscussionId: "disc_target",
        targetThreadTitle: "Target finding",
        responseTarget: createResponseTarget(
          "follow-up-comment",
          78,
          "Please re-check the prior thread.",
          "Please re-check the prior thread.",
          "disc_target",
        ),
      },
      priorThreads: [targetThread],
      previousReview: null,
    });

    expect(scoped.scope.mode).toBe("follow-up-thread");
    expect(scoped.priorThreads).toEqual([targetThread]);
    expect(scoped.changes).toEqual([]);
    expect(scoped.scope.omittedChangedFiles).toHaveLength(1);
    expect(scoped.scope.omittedChangedFiles[0]?.path).toBe("src/other.ts");
  });

  it("keeps first-pass direct mentions bounded for large merge requests", () => {
    const scoped = buildScopedReviewContext({
      workspacePath: repoPath(),
      mergeRequest,
      changes: Array.from({ length: 16 }, (_, index) =>
        createChange(
          `src/feature-${index + 1}.ts`,
          `@@ -1 +1 @@\n-old-${index}\n+new-${index}`,
        ),
      ),
      notes: [],
      discussions: [],
      instructionFiles: [],
      trigger: {
        kind: "direct-mention",
        noteId: 88,
        authorUsername: "developer",
        body: "@review-bot review",
        instruction: "review",
        targetThreadId: null,
        targetDiscussionId: null,
        targetThreadTitle: null,
        responseTarget: createResponseTarget(
          "direct-mention",
          88,
          "@review-bot review",
          "review",
        ),
      },
      priorThreads: [],
      previousReview: null,
    });

    expect(scoped.scope.mode).toBe("first-pass-full");
    expect(scoped.changes).toHaveLength(12);
    expect(scoped.scope.omittedChangedFiles).toHaveLength(4);
  });

  it("allows an explicit full rescan override even when previous review data exists", () => {
    const scoped = buildScopedReviewContext({
      workspacePath: repoPath(),
      mergeRequest,
      changes: [createChange("src/delta.ts", "@@ -1 +1 @@\n-old\n+new")],
      notes: [],
      discussions: [],
      instructionFiles: [],
      trigger: {
        kind: "direct-mention",
        noteId: 89,
        authorUsername: "developer",
        body: "@review-bot full rescan please",
        instruction: "full rescan please",
        targetThreadId: null,
        targetDiscussionId: null,
        targetThreadTitle: null,
        responseTarget: createResponseTarget(
          "direct-mention",
          89,
          "@review-bot full rescan please",
          "full rescan please",
        ),
      },
      priorThreads: [],
      previousReview: {
        reviewRunId: "run_prev",
        finishedAt: "2026-04-27T12:00:00.000Z",
        headSha: "prevhead",
        resultJson: JSON.stringify({
          overview: {
            summary: "Prior pass",
            overallSeverity: "low",
          },
          findings: [],
          priorDispositions: [],
        }),
        changesJson: JSON.stringify([]),
      },
    });

    expect(scoped.scope.mode).toBe("first-pass-full");
  });
});

function createChange(path: string, diff: string) {
  return {
    old_path: path,
    new_path: path,
    diff,
    new_file: false,
    renamed_file: false,
    deleted_file: false,
  };
}

function createResponseTarget(
  kind: "direct-mention" | "summary-follow-up" | "follow-up-comment",
  noteId: number,
  body: string,
  instruction: string,
  discussionId?: string,
) {
  return {
    kind:
      kind === "summary-follow-up"
        ? "summary-discussion-reply"
        : kind === "follow-up-comment"
          ? "finding-thread-reply"
          : discussionId
            ? "discussion-reply"
            : "merge-request-note",
    locationType:
      kind === "summary-follow-up"
        ? "summary-discussion"
        : kind === "follow-up-comment"
          ? "finding-thread"
          : discussionId
            ? "discussion-note"
            : "merge-request-note",
    triggerKind: kind,
    noteId,
    discussionId,
    authorUsername: "developer",
    body,
    instruction,
  } as const;
}

function createNote(id: number, body: string) {
  return {
    id,
    body,
    author: {
      id: 42,
      username: "developer",
      name: "Dev User",
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    system: false,
  };
}

function createDiscussionNote(id: number, body: string) {
  return {
    ...createNote(id, body),
    type: "DiscussionNote",
  };
}

function createThread(
  threadId: string,
  discussionId: string,
  title: string,
  path: string,
  resolved: boolean,
): ProviderThreadContext {
  return {
    threadId,
    discussionId,
    noteId: Number.parseInt(threadId.replace(/\D/g, ""), 10) || 1,
    title,
    body: `**${title}**\n\nBody`,
    anchor: {
      path,
      startLine: 1,
      endLine: 1,
      side: "new",
    },
    resolved,
    humanReplies: [],
  };
}
