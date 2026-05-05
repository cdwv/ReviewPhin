import { describe, expect, it, vi } from "vitest";

import type { HarnessModelConfig, HarnessTenantContext } from "../src/harness/types.js";
import { HarnessReviewProvider } from "../src/review/harness-review-provider.js";
import type { ReviewContext } from "../src/review/types.js";
import { repoPath, tmpPath } from "./test-paths.js";

describe("HarnessReviewProvider", () => {
  it("keeps existing memory entries when prompt-budget coalescing fails", async () => {
    const provider = new HarnessReviewProvider({
      logger: createLogger(),
      modelConfig: createModelConfig(),
      harnessRuntime: {
        run: vi.fn()
      } as never,
      memoryConsolidator: {
        coalesce: vi.fn(async () => {
          throw new Error("boom");
        })
      } as never,
      maxPromptMemoryChars: 5_000
    });

    const mergedEntries = [
      { text: "Team policy is to keep dolphin jokes tasteful and occasional." }
    ];

    const result = await (provider as any).coalesceProjectMemorySafely(
      {
        entries: mergedEntries,
        maxChars: 5_000,
        targetChars: 3_750,
        reason: "prompt-budget"
      },
      {
        logging: {
          interactionRunId: "run_1",
          tenantId: "tenant_1"
        },
        workspacePath: repoPath()
      },
      {
        tenant: createTenantRuntimeContext()
      }
    );

    expect(result).toEqual(mergedEntries);
  });

  it("routes reviewer runs through the shared harness runtime", async () => {
    const run = vi.fn(async () => ({
      response: {
        data: {
          content: JSON.stringify({
            overview: {
              summary: "Looks good",
              overallSeverity: "low"
            },
            findings: [],
            priorDispositions: []
          })
        }
      },
      events: []
    }));

    const provider = new HarnessReviewProvider({
      logger: createLogger(),
      modelConfig: createModelConfig(),
      harnessRuntime: {
        run
      } as never,
      memoryConsolidator: {
        coalesce: vi.fn(async (input) => input.coalesceInput.entries)
      } as never,
      maxPromptMemoryChars: 5_000
    });

    const result = await provider.review(createReviewContext(), {
      tenant: createTenantRuntimeContext()
    });

    expect(result.overview.summary).toBe("Looks good");
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.4",
        tenant: createTenantRuntimeContext(),
        tools: ["glob", "rg", "view"],
        subagents: ["context-analyst", "review-author"],
        agent: "review-author"
      })
    );
  });

  it("synthesizes a reply handoff summary when the model returns it blank", async () => {
    const run = vi.fn(async () => ({
      response: {
        data: {
          content: JSON.stringify({
            overview: {
              summary: "Looks good",
              overallSeverity: "low"
            },
            findings: [],
            priorDispositions: [
              {
                threadId: "thread_1",
                action: "resolve",
                resolution: "dismissed"
              }
            ],
            replyHandoff: {
              summary: "   ",
              targets: [
                {
                  kind: "discussion-reply",
                  noteId: 55,
                  discussionId: "disc_1",
                  guidance: "The concern is not applicable because the value is validated before this path runs."
                }
              ]
            }
          })
        }
      },
      events: []
    }));

    const provider = new HarnessReviewProvider({
      logger: createLogger(),
      modelConfig: createModelConfig(),
      harnessRuntime: {
        run
      } as never,
      memoryConsolidator: {
        coalesce: vi.fn(async (input) => input.coalesceInput.entries)
      } as never,
      maxPromptMemoryChars: 5_000
    });

    const result = await provider.review(createReviewContext(), {
      tenant: createTenantRuntimeContext()
    });

    expect(result.priorDispositions).toEqual([
      {
        threadId: "thread_1",
        action: "resolve",
        resolution: "dismissed"
      }
    ]);
    expect(result.replyHandoff).toEqual({
      summary: "The concern is not applicable because the value is validated before this path runs.",
      targets: [
        {
          kind: "discussion-reply",
          noteId: 55,
          discussionId: "disc_1",
          guidance: "The concern is not applicable because the value is validated before this path runs."
        }
      ]
    });
  });

  it("falls back to the review overview when a blank handoff has no target guidance", async () => {
    const run = vi.fn(async () => ({
      response: {
        data: {
          content: JSON.stringify({
            overview: {
              summary: "The rerun found no remaining blocking issues.",
              overallSeverity: "low",
              mergeReadiness: {
                status: "ready",
                confidence: "high",
                summary: "Everything needed for merge readiness is now addressed."
              }
            },
            findings: [],
            priorDispositions: [
              {
                threadId: "thread_1",
                action: "resolve",
                resolution: "resolved"
              }
            ],
            replyHandoff: {
              summary: "   ",
              targets: [
                {
                  kind: "discussion-reply",
                  noteId: 55,
                  discussionId: "disc_1",
                  guidance: "   "
                }
              ]
            }
          })
        }
      },
      events: []
    }));

    const provider = new HarnessReviewProvider({
      logger: createLogger(),
      modelConfig: createModelConfig(),
      harnessRuntime: {
        run
      } as never,
      memoryConsolidator: {
        coalesce: vi.fn(async (input) => input.coalesceInput.entries)
      } as never,
      maxPromptMemoryChars: 5_000
    });

    const result = await provider.review(createReviewContext(), {
      tenant: createTenantRuntimeContext()
    });

    expect(result.replyHandoff).toEqual({
      summary: "Everything needed for merge readiness is now addressed.",
      targets: [
        {
          kind: "discussion-reply",
          noteId: 55,
          discussionId: "disc_1",
          guidance: "   "
        }
      ]
    });
  });
});

function createLogger() {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => createLogger())
  } as never;
}

function createModelConfig(): HarnessModelConfig {
  return {
    modelProfileName: "default",
    selectionSource: "default",
    reviewModel: "gpt-5.4",
    textGenerationModel: "gpt-5.4-mini",
    authToken: null,
    provider: undefined,
    providerBaseUrl: null,
    providerType: null
  };
}

function createTenantRuntimeContext(): HarnessTenantContext {
  return {
    id: "tenant_1",
    baseUrl: "https://gitlab.example.com",
    projectId: 1085,
    apiToken: "token",
    memoryEnabled: true
  };
}

function createReviewContext(): ReviewContext {
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
      entries: []
    },
    trigger: {
      kind: "summary-follow-up",
      noteId: 55,
      authorUsername: "developer",
      body: "Please commit this to memory.",
      instruction: "Please commit this to memory.",
      targetThreadId: null,
      targetDiscussionId: null,
      targetThreadTitle: null,
      responseTarget: {
        kind: "summary-discussion-reply",
        locationType: "summary-discussion",
        triggerKind: "summary-follow-up",
        noteId: 55,
        discussionId: "disc_summary",
        authorUsername: "developer",
        body: "Please commit this to memory.",
        instruction: "Please commit this to memory."
      }
    },
    priorThreads: [],
    scope: {
      mode: "incremental-rereview",
      scopeSummary: "Summary note requested another review pass.",
      widenScopeHints: [],
      allChangedFiles: [],
      omittedChangedFiles: [],
      targetThread: null,
      previousReview: null,
      priorFindings: [],
      deltaSincePreviousReview: null
    },
    logging: {
      interactionRunId: "run_1",
      interactionJobId: "job_1",
      tenantId: "tenant_1",
      runDirectory: tmpPath()
    }
  };
}
