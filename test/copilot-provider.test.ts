import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createSessionMock,
  stopMock
} = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  stopMock: vi.fn()
}));

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: vi.fn().mockImplementation(() => ({
    createSession: createSessionMock,
    stop: stopMock
  })),
  defineTool: (name: string, definition: object) => ({
    name,
    ...definition
  })
}));

import { CopilotReviewProvider } from "../src/review/copilot-provider.js";
import type { ReviewContext } from "../src/review/types.js";
import { repoPath, tmpPath } from "./test-paths.js";

describe("CopilotReviewProvider", () => {
  beforeEach(() => {
    createSessionMock.mockReset();
    stopMock.mockReset();
  });

  it("keeps the incoming coalesced candidate entries when save-threshold coalescing fails", async () => {
    const provider = new CopilotReviewProvider({
      logger: {
        warn: vi.fn(),
        child: vi.fn(() => ({
          warn: vi.fn(),
          error: vi.fn()
        }))
      } as never,
      textGenerationModel: "auto",
      runLogDir: tmpPath(),
      timeoutMs: 1_000,
      maxPromptMemoryChars: 5_000
    });

    const mergedEntries = [
      { text: "Team policy is to keep dolphin jokes tasteful and occasional." }
    ];

    (provider as any).projectMemoryCoalescer = {
      coalesce: vi.fn(async () => {
        throw new Error("boom");
      })
    };

    const result = await (provider as any).coalesceProjectMemorySafely(
      {
        entries: mergedEntries,
        maxChars: 5_000,
        targetChars: 3_750,
        reason: "save-threshold"
      },
      {
        logging: {
          reviewRunId: "run_1",
          tenantId: "tenant_1"
        }
      }
    );

    expect(result).toEqual(mergedEntries);
  });

  it("registers rg and update_project_memory in the session allowlist when memory writes are enabled", async () => {
    createSessionMock.mockResolvedValue({
      sessionId: "session_1",
      on: vi.fn(() => () => {}),
      sendAndWait: vi.fn(async () => ({
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
      })),
      disconnect: vi.fn(async () => {})
    });
    stopMock.mockResolvedValue(undefined);

    const provider = new CopilotReviewProvider({
      logger: {
        warn: vi.fn(),
        error: vi.fn(),
        child: vi.fn(() => ({
          warn: vi.fn(),
          error: vi.fn()
        }))
      } as never,
      textGenerationModel: "auto",
      runLogDir: tmpPath(),
      timeoutMs: 1_000,
      maxPromptMemoryChars: 5_000
    });

    await provider.review(createReviewContext());

    expect(createSessionMock).toHaveBeenCalledOnce();
    const sessionOptions = createSessionMock.mock.calls[0]?.[0];
    expect(sessionOptions.availableTools).toEqual([
      "glob",
      "rg",
      "view",
      "update_project_memory"
    ]);
    expect(sessionOptions.customAgents[0].tools).toEqual(["glob", "rg", "view"]);
    expect(sessionOptions.customAgents[1].tools).toEqual([
      "glob",
      "rg",
      "view",
      "update_project_memory"
    ]);
  });
});

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
    projectMemoryWriteTarget: {
      baseUrl: "https://gitlab.example.com",
      projectId: 1085,
      apiToken: "token"
    },
    trigger: {
      kind: "summary-follow-up",
      noteId: 55,
      authorUsername: "developer",
      body: "Please commit this to memory.",
      instruction: "Please commit this to memory.",
      targetThreadId: null,
      targetDiscussionId: null,
      targetThreadTitle: null
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
      deltaSincePreviousReview: null
    },
    logging: {
      reviewRunId: "run_1",
      jobId: "job_1",
      tenantId: "tenant_1",
      runDirectory: tmpPath()
    }
  };
}
