import { describe, expect, it } from "vitest";

import { renderPrompt } from "../src/prompts/instruction-renderer.js";
import { buildReviewPrompt } from "../src/prompts/prompt-builders.js";
import type { ReviewContext } from "../src/review/types.js";
import { repoPath } from "./test-paths.js";

describe("buildReviewPrompt", () => {
  it("includes project memory in the serialized prompt context", () => {
    const prompt = buildReviewPrompt(createContext(), {
      maxPromptMemoryChars: 5_000
    });

    expect(prompt).toContain('"projectMemory": {');
    expect(prompt).toContain('"totalEntryCount": 2');
    expect(prompt).toContain('"includedEntryCount": 2');
    expect(prompt).toContain("Team policy is to prefer pnpm scripts");
    expect(prompt).toContain("For future reference, we generally avoid snapshot tests");
  });

  it("caps the amount of project memory included in the prompt context", () => {
    const prompt = buildReviewPrompt(
      createContext(
        Array.from({ length: 6 }, (_, index) => ({
          text: `Long-lived memory ${index + 1}: ${"x".repeat(60)}`
        }))
      ),
      {
        maxPromptMemoryChars: 240
      }
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

    expect(prompt).toContain("The latest user instruction came from a reply to the bot's merge request summary note.");
    expect(prompt).toContain('"kind": "summary-follow-up"');
  });

  it("nudges the reviewer to check for actionable unused code in the edited scope", () => {
    const prompt = buildReviewPrompt(createContext());

    expect(prompt).toContain("unused locals, helper functions, imports, parameters, or computed values");
    expect(prompt).toContain("instruction precedence from lowest to highest");
    expect(prompt).toContain("merge-request-level user comments, then the current `reviewTrigger`");
    expect(prompt).toContain("prefer updating that existing thread/finding instead of creating a duplicate");
    expect(renderPrompt("subagent.context-analyst", {})).toContain("unused locals, helper functions, imports, parameters, or assigned values");
    expect(renderPrompt("subagent.context-analyst", {})).toContain("merge-request-level user comments, then the current request");
    expect(renderPrompt("subagent.review-author", {})).not.toContain("unused");
  });

  it("uses the incremental summary-follow-up registered combination", () => {
    const prompt = buildReviewPrompt(createContext(null, "summary-follow-up", "incremental-rereview"));

    expect(prompt).toContain("This merge request has already been reviewed before.");
    expect(prompt).toContain("The latest user instruction came from a reply to the bot's merge request summary note.");
  });

  it("includes prior finding history with status and resolve resolution schema", () => {
    const prompt = buildReviewPrompt(createContext(null, "direct-mention", "incremental-rereview"));

    expect(prompt).toContain('"priorFindings": [');
    expect(prompt).toContain('"status": "open"');
    expect(prompt).toContain('"identityKey": "finding:src/api.ts:12"');
    expect(prompt).toContain("treat `resolved` and `dismissed` prior findings as inactive by default");
    expect(prompt).toContain('"resolution": "optional resolved | dismissed"');
  });

  it("uses the follow-up-thread registered combination without the summary overlay", () => {
    const prompt = buildReviewPrompt(createContext(null, "follow-up-comment", "follow-up-thread"));

    expect(prompt).toContain("This is a focused follow-up on an existing bot-owned discussion thread.");
    expect(prompt).not.toContain("The latest user instruction came from a reply to the bot's merge request summary note.");
  });

  it("renders registered standalone prompts and parameterized templates", () => {
    expect(renderPrompt("subagent.context-analyst", {})).toContain("You are a read-only context analyst.");
    expect(renderPrompt("subagent.review-author", {})).toContain("You are a review author.");
    expect(
      renderPrompt("memory.coalesce", {
        entries: [{ text: "Keep pnpm usage consistent." }],
        maxChars: 100,
        targetChars: 80,
        reason: "prompt-budget"
      })
    ).toContain("Reason for compression: prompt-budget");
  });
});

function createContext(
  entries: Array<{
    text: string;
  }> | null = [
    { text: "Team policy is to prefer pnpm scripts for local development." },
    { text: "For future reference, we generally avoid snapshot tests for API responses." }
  ],
  triggerKind: ReviewContext["trigger"]["kind"] = "direct-mention",
  mode: ReviewContext["scope"]["mode"] = "first-pass-full"
): ReviewContext {
  return {
    workspacePath: repoPath(),
    mergeRequest: {
      id: 1,
      iid: 7,
      project_id: 1085,
      title: "Add prompt memory context",
      description: "Description",
      web_url: "https://gitlab.example.com/group/project/-/merge_requests/7",
      source_branch: "feature",
      target_branch: "main",
      author: {
        id: 1,
        username: "developer",
        name: "Dev"
      }
    },
    changes: [],
    notes: [],
    discussions: [],
    instructionFiles: [],
    projectMemory: {
      enabled: true,
      page: {
        title: "Reviewphin memory",
        slug: "Reviewphin-memory",
        format: "markdown",
        content: ""
      },
      entries: entries ?? [
        { text: "Team policy is to prefer pnpm scripts for local development." },
        { text: "For future reference, we generally avoid snapshot tests for API responses." }
      ]
    },
    trigger: {
      kind: triggerKind,
      noteId: 55,
      authorUsername: "developer",
      body:
        triggerKind === "summary-follow-up"
          ? "In the future, please remember to throw in some dolphin related joke when it fits into the overall assessment."
          : "@review-bot review",
      instruction:
        triggerKind === "summary-follow-up"
          ? "In the future, please remember to throw in some dolphin related joke when it fits into the overall assessment."
          : "review",
      targetThreadId: null,
      targetDiscussionId: null,
      targetThreadTitle: null
    },
    priorThreads: [],
    scope: {
      mode,
      scopeSummary: "Full review",
      widenScopeHints: [],
      allChangedFiles: [],
      omittedChangedFiles: [],
      targetThread: null,
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
                  side: "new"
                },
                suggestion: null,
                reviewRunId: "run_prev",
                reviewedAt: "2026-04-27T12:00:00.000Z",
                headSha: "prevhead"
              }
            ]
          : [],
      deltaSincePreviousReview: null
    }
  };
}
