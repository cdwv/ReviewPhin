import { describe, expect, it } from "vitest";

import { renderPrompt } from "../src/prompts/instruction-renderer.js";
import {
  buildCompactReviewContext,
  buildChatterPrompt,
  buildReviewPrompt,
} from "../src/prompts/prompt-builders.js";
import type {
  CommentReviewTriggerContext,
  ReviewContext,
} from "../src/review/types.js";
import { repoPath } from "./test-paths.js";

describe("buildReviewPrompt", () => {
  it("serializes provider-owned manual triggers without fake comment fields", () => {
    const context: ReviewContext = {
      ...createContext(),
      trigger: {
        kind: "manual-review",
        provider: "github",
        source: "check-run-requested-action",
        instruction: null,
        metadata: {
          checkRunId: 1357,
          actionIdentifier: "run_review",
        },
      },
    };

    const prompt = buildReviewPrompt(context);
    const compact = buildCompactReviewContext(context, 5_000);

    expect(prompt).toContain('"kind": "manual-review"');
    expect(prompt).toContain('"checkRunId": 1357');
    expect(compact.reviewTrigger).not.toHaveProperty("commentId");
  });

  it("includes local manual instructions in the compact review trigger", () => {
    const context: ReviewContext = {
      ...createContext(),
      trigger: {
        kind: "manual-review",
        provider: "gitlab",
        source: "cli",
        instruction: "Focus on authorization boundary regressions.",
        metadata: {
          requestId: "local-review_1",
          codeReviewId: 7,
          createdAt: "2026-07-12T09:00:00.000Z",
        },
      },
    };

    const compact = buildCompactReviewContext(context, 5_000);

    expect(compact.reviewTrigger).toEqual(
      expect.objectContaining({
        source: "cli",
        instruction: "Focus on authorization boundary regressions.",
      }),
    );
  });

  it("includes project memory in the serialized prompt context", () => {
    const prompt = buildReviewPrompt(createContext(), {
      maxPromptMemoryChars: 5_000,
    });

    expect(prompt).toContain('"projectMemory": {');
    expect(prompt).toContain('"totalEntryCount": 2');
    expect(prompt).toContain('"includedEntryCount": 2');
    expect(prompt).toContain("Team policy is to prefer pnpm scripts");
    expect(prompt).toContain(
      "For future reference, we generally avoid snapshot tests",
    );
    expect(prompt).toContain('"attachments": [');
    expect(prompt).toContain('"displayName": "trigger-comment-55-diagram.png"');
    expect(prompt).toContain('"contentType": "image/png"');
  });

  it("surfaces GitLab image download issues in reviewer prompts", () => {
    const prompt = buildReviewPrompt(
      createContext(undefined, "direct-mention", "first-pass-full", [
        {
          sourceKind: "code-review-description",
          commentId: null,
          displayName: "code-review-description-architecture.png",
          status: 503,
          message:
            "GitLab image request failed for https://gitlab.example.com/-/project/1085/uploads/missing/architecture.png with 503",
          url: "https://gitlab.example.com/-/project/1085/uploads/missing/architecture.png",
        },
      ]),
    );

    expect(prompt).toContain("Runtime note:");
    expect(prompt).toContain(
      "The platform failed to download 1 referenced image attachment(s) before this run.",
    );
    expect(prompt).toContain("code-review-description-architecture.png");
    expect(prompt).toContain('"attachmentIssues": [');
    expect(prompt).toContain('"status": 503');
  });

  it("caps the amount of project memory included in the prompt context", () => {
    const prompt = buildReviewPrompt(
      createContext(
        Array.from({ length: 6 }, (_, index) => ({
          text: `Long-lived memory ${index + 1}: ${"x".repeat(60)}`,
        })),
      ),
      {
        maxPromptMemoryChars: 240,
      },
    );

    expect(prompt).toContain('"totalEntryCount": 6');
    expect(prompt).toContain('"includedEntryCount": 2');
    expect(prompt).toContain('"omittedEntryCount": 4');
    expect(prompt).toContain("Long-lived memory 1");
    expect(prompt).toContain("Long-lived memory 2");
    expect(prompt).not.toContain("Long-lived memory 4");
  });

  it("adds summary follow-up instructions from the markdown prompt file", () => {
    const prompt = buildReviewPrompt(createContext(null, "summary-follow-up"));

    expect(prompt).toContain(
      "The latest user instruction came from a reply to the bot's code review summary comment.",
    );
    expect(prompt).toContain('"kind": "summary-follow-up"');
  });

  it("nudges the reviewer to check for actionable unused code in the edited scope", () => {
    const prompt = buildReviewPrompt(createContext());

    expect(prompt).toContain(
      "unused locals, helper functions, imports, parameters, or computed values",
    );
    expect(prompt).toContain("instruction precedence from lowest to highest");
    expect(prompt).toContain(
      "code-review-level user comments, then the current `reviewTrigger`",
    );
    expect(prompt).toContain(
      "prefer updating that existing discussion/finding instead of creating a duplicate",
    );
    expect(renderPrompt("subagent.context-analyst", {})).toContain(
      "unused locals, helper functions, imports, parameters, or assigned values",
    );
    expect(renderPrompt("subagent.context-analyst", {})).toContain(
      "code-review-level user comments, then the current request",
    );
    expect(renderPrompt("subagent.review-author", {})).not.toContain("unused");
  });

  it("uses the incremental summary-follow-up registered combination", () => {
    const prompt = buildReviewPrompt(
      createContext(null, "summary-follow-up", "incremental-rereview"),
    );

    expect(prompt).toContain(
      "This code review has already been reviewed before.",
    );
    expect(prompt).toContain(
      "The latest user instruction came from a reply to the bot's code review summary comment.",
    );
  });

  it("includes prior finding history with status and resolve resolution schema", () => {
    const prompt = buildReviewPrompt(
      createContext(null, "direct-mention", "incremental-rereview"),
    );

    expect(prompt).toContain('"priorFindings": [');
    expect(prompt).toContain('"status": "open"');
    expect(prompt).toContain('"identityKey": "finding:src/api.ts:12"');
    expect(prompt).toContain(
      "treat `resolved` and `dismissed` prior findings as inactive by default",
    );
    expect(prompt).toContain('"resolution": "optional resolved | dismissed"');
  });

  it("uses the follow-up-discussion registered combination without the summary overlay", () => {
    const prompt = buildReviewPrompt(
      createContext(null, "follow-up-comment", "follow-up-discussion"),
    );

    expect(prompt).toContain(
      "This is a focused follow-up on an existing bot-owned discussion.",
    );
    expect(prompt).not.toContain(
      "The latest user instruction came from a reply to the bot's code review summary comment.",
    );
  });

  it("renders registered standalone prompts and parameterized templates", () => {
    expect(renderPrompt("subagent.context-analyst", {})).toContain(
      "You are a read-only context analyst.",
    );
    expect(renderPrompt("subagent.review-author", {})).toContain(
      "You are a review author.",
    );
    expect(renderPrompt("reply.direct-mention", {})).toContain(
      "You are the lightweight interaction chatter",
    );
    expect(renderPrompt("reply.memory-update", {})).toContain(
      "This phase runs before any optional reviewer pass.",
    );
    expect(
      renderPrompt("memory.coalesce", {
        entries: [{ text: "Keep pnpm usage consistent." }],
        maxChars: 100,
        targetChars: 80,
        reason: "prompt-budget",
      }),
    ).toContain("Reason for compression: prompt-budget");
  });

  it("builds chatter prompts with grouped target context and reviewer handoff", () => {
    const prompt = buildChatterPrompt({
      phase: "reply",
      replyStyle: "summary-follow-up",
      trigger: createContext(null, "summary-follow-up").trigger,
      responseTargets: [
        createContext(null, "summary-follow-up").trigger.responseTarget,
      ],
      projectMemory: createContext().projectMemory,
      reviewContext: createContext(),
      reviewResult: {
        overview: {
          summary: "Still needs one fix",
          overallSeverity: "medium",
        },
        findings: [],
        priorDispositions: [],
        replyHandoff: {
          summary:
            "The prior finding still applies because validation is missing.",
          targets: [
            {
              kind: "summary-discussion-reply",
              commentId: 55,
              discussionId: "disc_summary",
              guidance: "Explain that schema validation is still absent.",
            },
          ],
        },
      },
    });

    expect(prompt).toContain('"phase": "reply"');
    expect(prompt).toContain('"codeReview": {');
    expect(prompt).toContain('"author": "developer"');
    expect(prompt).toContain('"changedFiles": [');
    expect(prompt).toContain('"responseTargets": [');
    expect(prompt).toContain(
      "The prior finding still applies because validation is missing.",
    );
    expect(prompt).toContain("Formatting contract:");
    expect(prompt).toContain(
      "Return exactly one JSON object matching the schema below.",
    );
    expect(prompt).toContain(
      "Do not include Markdown fences, introductions, explanations, or trailing text outside the JSON object.",
    );
  });

  it("surfaces GitLab image download issues in chatter prompts", () => {
    const prompt = buildChatterPrompt({
      phase: "reply",
      replyStyle: "direct-answer",
      trigger: createContext().trigger,
      responseTargets: [createContext().trigger.responseTarget],
      projectMemory: createContext().projectMemory,
      reviewContext: createContext(
        undefined,
        "direct-mention",
        "first-pass-full",
        [
          {
            sourceKind: "trigger-comment",
            commentId: 55,
            displayName: "trigger-comment-55-screenshot.png",
            status: 403,
            message:
              "GitLab image request failed for https://gitlab.example.com/-/project/1085/uploads/denied/screenshot.png with 403",
            url: "https://gitlab.example.com/-/project/1085/uploads/denied/screenshot.png",
          },
        ],
      ),
    });

    expect(prompt).toContain("Runtime note:");
    expect(prompt).toContain("trigger-comment-55-screenshot.png");
    expect(prompt).toContain('"attachmentIssues": [');
    expect(prompt).toContain('"status": 403');
  });
});

function createContext(
  entries:
    | Array<{
        text: string;
      }>
    | null
    | undefined = [
    { text: "Team policy is to prefer pnpm scripts for local development." },
    {
      text: "For future reference, we generally avoid snapshot tests for API responses.",
    },
  ],
  triggerKind: CommentReviewTriggerContext["kind"] = "direct-mention",
  mode: ReviewContext["scope"]["mode"] = "first-pass-full",
  attachmentIssues: ReviewContext["attachmentIssues"] = [],
): ReviewContext & { trigger: CommentReviewTriggerContext } {
  return {
    attachments: [
      {
        sourceKind: "trigger-comment",
        commentId: 55,
        displayName: "trigger-comment-55-diagram.png",
        contentType: "image/png",
      },
    ],
    attachmentIssues,
    workspacePath: repoPath(),
    codeReview: {
      id: 7,
      title: "Add prompt memory context",
      description: "Description",
      webUrl: "https://gitlab.example.com/group/project/-/merge_requests/7",
      sourceBranch: "feature",
      targetBranch: "main",
      authorUsername: "developer",
    },
    changes: [
      {
        oldPath: "src/old-worker.ts",
        newPath: "src/worker.ts",
        diff: "@@ -1,2 +1,4 @@\n-export function oldWorker() {}\n+export function worker() {\n+  return true;\n+}",
        newFile: false,
        renamedFile: true,
        deletedFile: false,
      },
    ],
    comments: [
      {
        id: 60,
        body: "Can we summarize the worker changes clearly?",
        authorUsername: "reviewer",
        resolvable: false,
        resolved: false,
      },
    ],
    discussions: [],
    projectMemory: {
      enabled: true,
      page: {
        title: "Reviewphin memory",
        slug: "Reviewphin-memory",
        format: "markdown",
        content: "",
      },
      entries: entries ?? [
        {
          text: "Team policy is to prefer pnpm scripts for local development.",
        },
        {
          text: "For future reference, we generally avoid snapshot tests for API responses.",
        },
      ],
    },
    trigger: {
      kind: triggerKind,
      commentId: 55,
      authorUsername: "developer",
      body:
        triggerKind === "summary-follow-up"
          ? "In the future, please remember to throw in some dolphin related joke when it fits into the overall assessment."
          : "@review-bot review",
      instruction:
        triggerKind === "summary-follow-up"
          ? "In the future, please remember to throw in some dolphin related joke when it fits into the overall assessment."
          : "review",
      targetDiscussionId: null,
      targetPlatformDiscussionId: null,
      targetDiscussionTitle: null,
      responseTarget: {
        kind:
          triggerKind === "summary-follow-up"
            ? "summary-discussion-reply"
            : "code-review-comment",
        locationType:
          triggerKind === "summary-follow-up"
            ? "summary-discussion"
            : "code-review-comment",
        triggerKind,
        commentId: 55,
        ...(triggerKind === "summary-follow-up"
          ? { discussionId: "disc_summary" }
          : {}),
        authorUsername: "developer",
        body:
          triggerKind === "summary-follow-up"
            ? "In the future, please remember to throw in some dolphin related joke when it fits into the overall assessment."
            : "@review-bot review",
        instruction:
          triggerKind === "summary-follow-up"
            ? "In the future, please remember to throw in some dolphin related joke when it fits into the overall assessment."
            : "review",
      },
    },
    priorDiscussions: [],
    scope: {
      mode,
      scopeSummary: "Full review",
      widenScopeHints: [],
      allChangedFiles: [],
      omittedChangedFiles: [],
      targetDiscussion: null,
      previousReview: null,
      priorFindings:
        mode === "incremental-rereview"
          ? [
              {
                findingId: "finding_1",
                identityKey: "finding:src/api.ts:12",
                status: "open",
                title: "Validate request body",
                body: "The request body is still accepted without schema validation.",
                severity: "medium",
                category: "correctness",
                anchor: {
                  path: "src/api.ts",
                  startLine: 12,
                  endLine: 12,
                  side: "new",
                },
                suggestion: null,
                reviewRunId: "run_prev",
                reviewedAt: "2026-04-27T12:00:00.000Z",
                headSha: "prevhead",
              },
            ]
          : [],
      deltaSincePreviousReview: null,
    },
  };
}
