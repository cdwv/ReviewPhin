import { describe, expect, it, vi } from "vitest";

import { HarnessChatterRunner } from "../src/review/harness-chatter.js";
import type {
  HarnessModelConfig,
  HarnessTenantContext,
} from "../src/harness/types.js";
import type { ReviewContext } from "../src/review/types.js";

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
      parsed: {
        memory: {
          status: "written",
          summary: "Saved a durable tone preference.",
        },
        replies: [],
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
        attachments: [
          {
            type: "blob",
            data: "AQID",
            mimeType: "image/png",
            displayName: "trigger-note-55-diagram.png",
          },
        ],
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
        tenant: createTenantRuntimeContext(),
      },
    );

    expect(result.memory?.status).toBe("written");
    const firstCall = run.mock.calls.at(0) as [unknown] | undefined;
    expect(firstCall?.[0]).toEqual(
      expect.objectContaining({
        attachments: [
          {
            type: "blob",
            data: "AQID",
            mimeType: "image/png",
            displayName: "trigger-note-55-diagram.png",
          },
        ],
        model: "gpt-5.4-mini",
        workingDirectory: "H:\\repo",
        tools: ["glob", "rg", "view", "add_memory_entry"],
        subagents: [],
        responseFormat: expect.objectContaining({
          schema: expect.anything(),
          looksLike: expect.any(Function),
        }),
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
      parsed: {
        memory: null,
        replies: [],
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
        attachments: [
          {
            type: "blob",
            data: "AQID",
            mimeType: "image/png",
            displayName: "trigger-note-55-diagram.png",
          },
        ],
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
        tenant: createTenantRuntimeContext(),
      },
    );

    const firstCall = run.mock.calls.at(0) as [unknown] | undefined;
    expect(firstCall?.[0]).toEqual(
      expect.objectContaining({
        attachments: [
          {
            type: "blob",
            data: "AQID",
            mimeType: "image/png",
            displayName: "trigger-note-55-diagram.png",
          },
        ],
        workingDirectory: "H:\\repo",
        tools: ["glob", "rg", "view"],
        metadata: {
          codeReviewId: 7,
          workspacePath: "H:\\repo",
        },
        responseFormat: expect.objectContaining({
          schema: expect.anything(),
          looksLike: expect.any(Function),
        }),
      }),
    );
  });

  it("uses the parsed shared-harness response payload for replies", async () => {
    const runner = new HarnessChatterRunner({
      modelConfig: createModelConfig(),
      harnessRuntime: {
        run: vi.fn(async () => ({
          response: {
            data: {
              content: "Good question first.\n\n{\"note\":\"ignored here\"}",
            },
          },
          parsed: {
            memory: null,
            replies: [
              {
                target: {
                  kind: "summary-discussion-reply",
                  noteId: 55,
                  discussionId: "disc_summary",
                },
                replyBody: "The payload is still valid.",
              },
            ],
          },
          events: [],
        })),
      } as never,
    });

    const result = await runner.run(
      {
        attachments: [
          {
            type: "blob",
            data: "AQID",
            mimeType: "image/png",
            displayName: "trigger-note-55-diagram.png",
          },
        ],
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
        tenant: createTenantRuntimeContext(),
      },
    );

    expect(result).toEqual({
      memory: null,
      replies: [
        {
          target: {
            kind: "summary-discussion-reply",
            noteId: 55,
            discussionId: "disc_summary",
          },
          replyBody: "The payload is still valid.",
        },
      ],
    });
  });

  it("surfaces shared harness parse errors for malformed chatter output", async () => {
    const runner = new HarnessChatterRunner({
      modelConfig: createModelConfig(),
      harnessRuntime: {
        run: vi.fn(async () => ({
          response: {
            data: {
              content: "Not valid structured output",
            },
          },
          parseError: {
            reason: "schema-mismatch",
            message:
              "Harness response contained JSON objects, but none matched the expected schema",
          },
          events: [],
        })),
      } as never,
    });

    await expect(
      runner.run(
        {
          attachments: [
            {
              type: "blob",
              data: "AQID",
              mimeType: "image/png",
              displayName: "trigger-note-55-diagram.png",
            },
          ],
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
          tenant: createTenantRuntimeContext(),
        },
      ),
    ).rejects.toThrow(
      /Harness response contained JSON objects, but none matched the expected schema/,
    );
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

function createTenantRuntimeContext(): HarnessTenantContext {
  return {
    id: "tenant_1",
    memoryEnabled: true,
    projectMemoryBackend: {
      load: vi.fn(async () => ({
        enabled: true,
        page: null,
        entries: [],
      })),
      saveEntries: vi.fn(async (entries) => ({
        enabled: true,
        page: null,
        entries,
      })),
    },
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

function createReviewContext(): ReviewContext {
  return {
    attachments: [
      {
        sourceKind: "trigger-note",
        noteId: 55,
        displayName: "trigger-note-55-diagram.png",
        contentType: "image/png",
      },
    ],
    attachmentIssues: [],
    workspacePath: "H:\\repo",
    codeReview: {
      id: 7,
      title: "Add worker summary",
      description: "Description",
      webUrl: "https://gitlab.example.com/group/project/-/merge_requests/7",
      sourceBranch: "feature",
      targetBranch: "main",
      authorUsername: "developer",
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
