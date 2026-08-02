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
import { repoPath, tmpPath } from "./test-paths.js";

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

  it("allows relevant diff context anchors without encouraging unrelated inline locations", () => {
    const prompt = buildReviewPrompt(createContext());

    expect(prompt).toContain("line available in the review diff");
    expect(prompt).toContain("unchanged context line inside a diff hunk");
    expect(prompt).toContain(
      "Use an old-side anchor only when removed code itself is the subject",
    );
    expect(prompt).toContain("does not need to be its only cause");
    expect(prompt).toContain(
      "Never choose an unrelated changed line merely to make the finding inline",
    );
    expect(prompt).toContain(
      "omit the anchor and identify the file, symbol, and line in the body",
    );
    expect(prompt).toContain(
      "recheck each anchor against the diff and each unanchored finding",
    );
    expect(prompt).not.toContain(
      "anchor must point to the changed line that causes",
    );
  });

  it("asks for plain, structured findings without duplicating that guidance in the agent role", () => {
    const prompt = buildReviewPrompt(createContext());
    const authorPrompt = renderPrompt("subagent.review-author", {});

    expect(prompt).toContain("a developer who may not know this project");
    expect(prompt).toContain("problem, its concrete effect or risk");
    expect(prompt).toContain("Use separate short paragraphs");
    expect(prompt).toContain("Use a compact Markdown list");
    expect(prompt).toContain("Put that formatting inside the finding's `body`");
    expect(prompt).toContain("Do not compress distinct points");
    expect(authorPrompt).not.toContain(
      "a developer who may not know this project",
    );
  });

  it("includes the review validator's input JSON Schema", () => {
    const prompt = buildReviewPrompt(createContext());
    const schema = extractPromptJsonSchema(prompt);
    const overview = getSchemaProperty(schema, "overview");
    const finding = asRecord(getSchemaProperty(schema, "findings").items);
    const anchor = getSchemaProperty(finding, "anchor");
    const anchorObject = asRecord((anchor.anyOf as unknown[])[0]);
    const suggestion = getSchemaProperty(finding, "suggestion");
    const suggestionObject = asRecord((suggestion.anyOf as unknown[])[0]);
    const replyHandoff = getSchemaProperty(schema, "replyHandoff");
    const handoffTargets = getSchemaProperty(replyHandoff, "targets");
    const handoffTarget = asRecord(handoffTargets.items);

    expect(prompt).toContain(
      "JSON Schema (properties not listed in `required` may be omitted):",
    );
    expect(schema.required).toEqual(["overview", "findings"]);
    expect(overview.required).toEqual(["summary", "overallSeverity"]);
    expect(finding.required).toEqual(["title", "body", "severity", "category"]);
    expect(anchorObject.required).toEqual([
      "path",
      "startLine",
      "endLine",
      "side",
    ]);
    expect(anchorObject.description).toContain("inclusive range");
    expect(suggestionObject.required).toEqual([
      "replacement",
      "startLine",
      "endLine",
    ]);
    expect(getSchemaProperty(schema, "priorDispositions").default).toEqual([]);
    expect(replyHandoff.required).toEqual(["summary"]);
    expect(handoffTargets.default).toEqual([]);
    expect(handoffTarget.required).toEqual(["kind", "commentId", "guidance"]);
    expect(getSchemaProperty(handoffTarget, "discussionId").description).toBe(
      "Required unless kind is code-review-comment",
    );
    expect(prompt).toContain(
      "new-side anchor whose line range exactly matches the suggestion range",
    );
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

  it.each([
    "first-pass-full",
    "incremental-rereview",
    "follow-up-discussion",
  ] as const)(
    "requires %s overviews to summarize the entire code review",
    (mode) => {
      const context = createContext(
        null,
        mode === "follow-up-discussion"
          ? "follow-up-comment"
          : "direct-mention",
        mode,
      );
      context.scope.previousReview = {
        reviewRunId: "run_previous",
        reviewedAt: "2026-07-13T09:00:00.000Z",
        headSha: "previous-head",
        overviewSummary: "Adds tenant-scoped review synchronization.",
        mergeReadiness: null,
      };

      const prompt = buildReviewPrompt(context);

      expect(prompt).toContain(
        "current overall state of the entire code review",
      );
      expect(prompt).toContain("assess merge readiness with confidence");
      expect(prompt).toContain("include concise highlights when useful");
      expect(prompt).toContain(
        "It must stand alone, regardless of this pass's inspection scope",
      );
      expect(prompt).toContain(
        "treat it as a draft: preserve what remains true",
      );
      expect(prompt).toContain(
        "Return one rewritten summary, not an appended update or review history.",
      );
      expect(prompt).toContain(
        '"overviewSummary": "Adds tenant-scoped review synchronization."',
      );
    },
  );

  it("includes prior finding history and the disposition resolution contract", () => {
    const prompt = buildReviewPrompt(
      createContext(null, "direct-mention", "incremental-rereview"),
    );
    const schema = extractPromptJsonSchema(prompt);
    const priorDispositions = getSchemaProperty(schema, "priorDispositions");
    const disposition = asRecord(priorDispositions.items);

    expect(prompt).toContain('"priorFindings": [');
    expect(prompt).toContain('"status": "open"');
    expect(prompt).toContain('"identityKey": "finding:src/api.ts:12"');
    expect(prompt).toContain(
      "treat `resolved` and `dismissed` prior findings as inactive by default",
    );
    expect(getSchemaProperty(disposition, "resolution").enum).toEqual([
      "resolved",
      "dismissed",
    ]);
  });

  it("uses a complete compact manifest and omits full diffs when Git inspection is ready", () => {
    const context = createContext();
    context.gitInspection = {
      baseRef: "refs/reviewphin/base",
      headRef: "refs/reviewphin/head",
      emptyGitConfigPath: tmpPath("empty-git-config"),
    };
    context.scope.allChangedFiles = [
      {
        path: "src/worker.ts",
        oldPath: "src/old-worker.ts",
        newFile: false,
        renamedFile: true,
        deletedFile: false,
        additions: 3,
        deletions: 1,
        changedLineRanges: [
          {
            oldStart: 1,
            oldEnd: 2,
            newStart: 1,
            newEnd: 4,
          },
        ],
        diffAvailable: true,
      },
    ];

    const prompt = buildReviewPrompt(context);
    const compact = buildCompactReviewContext(context, 5_000);
    const serialized = JSON.stringify(compact);

    expect(prompt).toContain(
      "`changedFiles` is the complete review change boundary",
    );
    expect(prompt).toContain(
      "trusted base and head revisions provided by `gitInspection`",
    );
    expect(compact.changedFiles).toHaveLength(1);
    expect(compact.inlineDiffs).toEqual([]);
    expect(compact.gitInspection).toEqual(
      expect.objectContaining({
        available: true,
        tool: "git_readonly",
        baseRevision: "base",
        headRevision: "head",
      }),
    );
    expect(serialized).not.toContain("export function oldWorker");
  });

  it("prefers split path-scoped reads for large Git-backed reviews in every review mode", () => {
    const expectedGuidance =
      "prefer splitting reads into several path-scoped `git_readonly` diffs";

    for (const [triggerKind, scopeMode] of [
      ["direct-mention", "first-pass-full"],
      ["direct-mention", "incremental-rereview"],
      ["follow-up-comment", "follow-up-discussion"],
    ] as const) {
      const context = createContext(undefined, triggerKind, scopeMode);
      context.gitInspection = {
        baseRef: "refs/reviewphin/base",
        headRef: "refs/reviewphin/head",
        emptyGitConfigPath: tmpPath("empty-git-config"),
      };

      expect(buildReviewPrompt(context)).toContain(expectedGuidance);
    }
  });

  it("names every platform path beyond the former first-pass limit", () => {
    const context = createContext();
    context.gitInspection = {
      baseRef: "refs/reviewphin/base",
      headRef: "refs/reviewphin/head",
      emptyGitConfigPath: tmpPath("empty-git-config"),
    };
    context.scope.allChangedFiles = Array.from({ length: 20 }, (_, index) => ({
      path: `src/file-${index + 1}.ts`,
      oldPath: null,
      newFile: false,
      renamedFile: false,
      deletedFile: false,
      additions: 1,
      deletions: 1,
      changedLineRanges: [
        {
          oldStart: index + 1,
          oldEnd: index + 1,
          newStart: index + 1,
          newEnd: index + 1,
        },
      ],
      diffAvailable: true,
    }));

    const prompt = buildReviewPrompt(context);

    for (let index = 1; index <= 20; index += 1) {
      expect(prompt).toContain(`src/file-${index}.ts`);
    }
    expect(prompt).not.toContain("additionalChangedFiles");
  });

  it("keeps the complete platform diff inline when Git inspection is unavailable", () => {
    const context = createContext();
    const compact = buildCompactReviewContext(context, 5_000);

    expect(compact.inlineDiffs[0]?.diff).toBe(context.changes[0]?.diff);
    expect(compact.gitInspection.available).toBe(false);
  });

  it("keeps Git-ready discussion follow-ups free of provider patch text", () => {
    const context = createContext(
      undefined,
      "follow-up-comment",
      "follow-up-discussion",
    );
    context.gitInspection = {
      baseRef: "refs/reviewphin/base",
      headRef: "refs/reviewphin/head",
      emptyGitConfigPath: tmpPath("empty-git-config"),
    };
    context.changes[0]!.diff =
      "@@ -1,2 +1,2 @@\n-old one\n+new one\n@@ -20,2 +20,3 @@\n-old target\n+new target\n+extra";
    context.scope.targetDiscussion = {
      discussionId: "discussion_1",
      platformDiscussionId: "platform_1",
      platformCommentId: 55,
      title: "Target concern",
      body: "Please re-check this line.",
      anchor: {
        path: "src/worker.ts",
        startLine: 21,
        endLine: 21,
        side: "new",
      },
      resolvable: true,
      resolved: false,
      humanReplies: [],
    };

    const compact = buildCompactReviewContext(context, 5_000);

    expect(compact.inlineDiffs).toEqual([]);
    expect(compact.gitInspection.available).toBe(true);
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
      "Return exactly one JSON object matching the JSON Schema below.",
    );
    expect(prompt).toContain(
      "Do not include Markdown fences, introductions, explanations, or trailing text outside the JSON object.",
    );
    expect(prompt).toContain("Match the language of the triggering request");
    expect(prompt).toContain("Lead with the answer or requested action");
    expect(prompt).toContain("do not sacrifice structure for brevity");
    expect(prompt).toContain(
      "Use one paragraph only when the reply contains one idea",
    );
    expect(prompt).toContain(
      "Separate distinct reasons or conditions into short paragraphs",
    );
    expect(prompt).toContain("Put that formatting inside `replyBody`");
    const schema = extractPromptJsonSchema(prompt);
    const replies = getSchemaProperty(schema, "replies");
    const reply = asRecord(replies.items);
    const target = getSchemaProperty(reply, "target");
    expect(schema.required).toBeUndefined();
    expect(getSchemaProperty(schema, "memory").anyOf).toBeInstanceOf(Array);
    expect(replies.default).toEqual([]);
    expect(getSchemaProperty(target, "discussionId").description).toContain(
      "Required unless kind is code-review-comment",
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

function extractPromptJsonSchema(prompt: string): Record<string, unknown> {
  const heading =
    "JSON Schema (properties not listed in `required` may be omitted):\n";
  const start = prompt.indexOf(heading);
  if (start < 0) {
    throw new Error("Prompt JSON Schema heading was not found");
  }
  const schemaStart = start + heading.length;
  const schemaEnd = prompt.indexOf("\n\nContext:", schemaStart);
  if (schemaEnd < 0) {
    throw new Error("Prompt JSON Schema terminator was not found");
  }
  return asRecord(JSON.parse(prompt.slice(schemaStart, schemaEnd)) as unknown);
}

function getSchemaProperty(
  schema: Record<string, unknown>,
  property: string,
): Record<string, unknown> {
  return asRecord(asRecord(schema.properties)[property]);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON Schema object");
  }
  return value as Record<string, unknown>;
}

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
      allChangedFiles: [
        {
          path: "src/worker.ts",
          oldPath: "src/old-worker.ts",
          newFile: false,
          renamedFile: true,
          deletedFile: false,
          additions: 3,
          deletions: 1,
          changedLineRanges: [
            {
              oldStart: 1,
              oldEnd: 2,
              newStart: 1,
              newEnd: 4,
            },
          ],
          diffAvailable: true,
        },
      ],
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
