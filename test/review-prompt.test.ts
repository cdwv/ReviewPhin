import { describe, expect, it } from "vitest";

import { buildReviewPrompt } from "../src/review/prompt.js";
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
});

function createContext(
  entries: Array<{
    text: string;
  }> | null = [
    { text: "Team policy is to prefer pnpm scripts for local development." },
    { text: "For future reference, we generally avoid snapshot tests for API responses." }
  ],
  triggerKind: ReviewContext["trigger"]["kind"] = "direct-mention"
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
    projectMemoryWriteTarget: null,
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
      mode: "first-pass-full",
      scopeSummary: "Full review",
      widenScopeHints: [],
      allChangedFiles: [],
      omittedChangedFiles: [],
      targetThread: null,
      previousReview: null,
      deltaSincePreviousReview: null
    }
  };
}
