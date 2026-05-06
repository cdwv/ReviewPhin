import { describe, expect, it, vi } from "vitest";

import { HarnessChatterRunner } from "../src/review/harness-chatter.js";
import type { HarnessModelConfig } from "../src/harness/types.js";

describe("HarnessChatterRunner", () => {
  it("uses the text-generation model and memory-only tool exposure for memory passes", async () => {
    const run = vi.fn(async () => ({
      response: {
        data: {
          content: JSON.stringify({
            memory: {
              status: "written",
              summary: "Saved a durable tone preference.",
            },
            replies: [],
          }),
        },
      },
      events: [],
    }));

    const runner = new HarnessChatterRunner({
      modelConfig: createModelConfig(),
      harnessRuntime: {
        run,
      } as never,
    });

    const result = await runner.run(
      {
        phase: "memory",
        replyStyle: "summary-follow-up",
        trigger: createTrigger(),
        responseTargets: [createTrigger().responseTarget],
        reviewContext: createReviewContext(),
        projectMemory: {
          enabled: true,
          page: null,
          entries: [],
        },
      },
      {
        tenant: {
          id: "tenant_1",
          baseUrl: "https://gitlab.example.com",
          projectId: 1085,
          apiToken: "token",
          memoryEnabled: true,
        },
      },
    );

    expect(result.memory?.status).toBe("written");
    const firstCall = run.mock.calls.at(0) as [unknown] | undefined;
    expect(firstCall?.[0]).toEqual(
      expect.objectContaining({
        model: "gpt-5.4-mini",
        workingDirectory: "H:\\repo",
        tools: ["glob", "rg", "view", "add_memory_entry"],
        subagents: [],
      }),
    );
  });

  it("exposes read-only repository tools for reply passes", async () => {
    const run = vi.fn(async () => ({
      response: {
        data: {
          content: JSON.stringify({
            memory: null,
            replies: [],
          }),
        },
      },
      events: [],
    }));

    const runner = new HarnessChatterRunner({
      modelConfig: createModelConfig(),
      harnessRuntime: {
        run,
      } as never,
    });

    await runner.run(
      {
        phase: "reply",
        replyStyle: "direct-answer",
        trigger: createTrigger(),
        responseTargets: [createTrigger().responseTarget],
        reviewContext: createReviewContext(),
        projectMemory: {
          enabled: true,
          page: null,
          entries: [],
        },
      },
      {
        tenant: {
          id: "tenant_1",
          baseUrl: "https://gitlab.example.com",
          projectId: 1085,
          apiToken: "token",
          memoryEnabled: true,
        },
      },
    );

    const firstCall = run.mock.calls.at(0) as [unknown] | undefined;
    expect(firstCall?.[0]).toEqual(
      expect.objectContaining({
        workingDirectory: "H:\\repo",
        tools: ["glob", "rg", "view"],
        metadata: {
          mergeRequestIid: 7,
          workspacePath: "H:\\repo",
        },
      }),
    );
  });

  it("rejects threaded replies that omit discussion ids", async () => {
    const runner = new HarnessChatterRunner({
      modelConfig: createModelConfig(),
      harnessRuntime: {
        run: vi.fn(async () => ({
          response: {
            data: {
              content: JSON.stringify({
                memory: null,
                replies: [
                  {
                    target: {
                      kind: "discussion-reply",
                      noteId: 55,
                    },
                    replyBody: "Here is the explanation.",
                  },
                ],
              }),
            },
          },
          events: [],
        })),
      } as never,
    });

    await expect(
      runner.run(
        {
          phase: "reply",
          replyStyle: "direct-answer",
          trigger: createTrigger(),
          responseTargets: [createTrigger().responseTarget],
          reviewContext: createReviewContext(),
          projectMemory: {
            enabled: true,
            page: null,
            entries: [],
          },
        },
        {
          tenant: {
            id: "tenant_1",
            baseUrl: "https://gitlab.example.com",
            projectId: 1085,
            apiToken: "token",
            memoryEnabled: true,
          },
        },
      ),
    ).rejects.toThrow(/discussionId is required for threaded reply targets/);
  });
});

function createModelConfig(): HarnessModelConfig {
  return {
    modelProfileName: "default",
    selectionSource: "default",
    reviewModel: "gpt-5.4",
    textGenerationModel: "gpt-5.4-mini",
    authToken: null,
    provider: undefined,
    providerBaseUrl: null,
    providerType: null,
  };
}

function createTrigger() {
  return {
    kind: "summary-follow-up" as const,
    noteId: 55,
    authorUsername: "developer",
    body: "For future reference, keep the tone concise.",
    instruction: "For future reference, keep the tone concise.",
    targetThreadId: null,
    targetDiscussionId: "disc_summary",
    targetThreadTitle: null,
    responseTarget: {
      kind: "summary-discussion-reply" as const,
      locationType: "summary-discussion" as const,
      triggerKind: "summary-follow-up" as const,
      noteId: 55,
      discussionId: "disc_summary",
      authorUsername: "developer",
      body: "For future reference, keep the tone concise.",
      instruction: "For future reference, keep the tone concise.",
    },
  };
}

function createReviewContext() {
  return {
    workspacePath: "H:\\repo",
    mergeRequest: {
      id: 1,
      iid: 7,
      project_id: 1085,
      title: "Add worker summary",
      description: "Description",
      web_url: "https://gitlab.example.com/group/project/-/merge_requests/7",
      source_branch: "feature",
      target_branch: "main",
      author: {
        id: 42,
        username: "developer",
        name: "Dev User",
      },
    },
    changes: [],
    notes: [],
    discussions: [],
    instructionFiles: [],
    projectMemory: {
      enabled: true,
      page: null,
      entries: [],
    },
    trigger: createTrigger(),
    priorThreads: [],
    scope: {
      mode: "first-pass-full" as const,
      scopeSummary: "Full review",
      widenScopeHints: [],
      allChangedFiles: [],
      omittedChangedFiles: [],
      targetThread: null,
      previousReview: null,
      priorFindings: [],
      deltaSincePreviousReview: null,
    },
  };
}
