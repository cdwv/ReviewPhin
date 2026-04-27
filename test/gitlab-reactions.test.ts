import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GitLabClient } from "../src/gitlab/client.js";
import type { GitLabDiscussion, GitLabNoteHookPayload } from "../src/gitlab/types.js";
import { ReviewWorker } from "../src/jobs/review-worker.js";
import { createLogger } from "../src/logger.js";

const tenant = {
  id: "tenant_1",
  key: "https://gitlab.example.com::123",
  baseUrl: "https://gitlab.example.com",
  projectId: 123,
  apiToken: "token",
  webhookSecret: "secret",
  botUserId: 999,
  botUsername: "review-bot",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

const directMentionPayload: GitLabNoteHookPayload = {
  object_kind: "note",
  project: {
    id: 123,
    web_url: "https://gitlab.example.com/group/project"
  },
  repository: {
    homepage: "https://gitlab.example.com/group/project"
  },
  merge_request: {
    iid: 7,
    title: "Add worker",
    description: "Adds the worker",
    source_branch: "feature",
    target_branch: "main",
    last_commit: {
      id: "abc123"
    }
  },
  object_attributes: {
    id: 55,
    note: "@review-bot please review this",
    noteable_type: "MergeRequest",
    url: "https://gitlab.example.com/group/project/-/merge_requests/7#note_55"
  },
  user: {
    id: 42,
    username: "developer",
    name: "Dev User",
    web_url: "https://gitlab.example.com/developer"
  }
};

const followUpPayload: GitLabNoteHookPayload = {
  ...directMentionPayload,
  object_attributes: {
    id: 56,
    note: "Please make this more human.",
    noteable_type: "MergeRequest",
    url: "https://gitlab.example.com/group/project/-/merge_requests/7#note_56"
  }
};

describe("GitLab reactions", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("lists and creates merge request note award emojis", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "GET") {
        expect(url).toBe(
          "https://gitlab.example.com/api/v4/projects/123/merge_requests/7/notes/55/award_emoji?page=1&per_page=100"
        );
        return new Response("[]", {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      expect(init?.method).toBe("POST");
      expect(url).toBe("https://gitlab.example.com/api/v4/projects/123/merge_requests/7/notes/55/award_emoji");
      expect(new Headers(init?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
      expect(String(init?.body)).toContain("name=eyes");

      return new Response(
        JSON.stringify({
          id: 1,
          name: "eyes",
          user: {
            id: 999,
            username: "review-bot",
            name: "Review Bot"
          },
          created_at: new Date().toISOString()
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    });

    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      apiToken: "token",
      logger: createLogger("silent")
    });

    const existing = await client.listMergeRequestNoteAwardEmojis(123, 7, 55);
    expect(existing).toEqual([]);

    const created = await client.createMergeRequestNoteAwardEmoji(123, 7, 55, "eyes");
    expect(created.name).toBe("eyes");
  });

  it("adds reactions to direct mention trigger notes when a review starts and completes", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "GET" && url.includes("/discussions?")) {
        return new Response("[]", {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      if (init?.method === "GET" && url.includes("/notes/55/award_emoji")) {
        return new Response("[]", {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      const body = String(init?.body);
      const reactionName = body.includes("white_check_mark") ? "white_check_mark" : "eyes";
      return new Response(
        JSON.stringify({
          id: reactionName === "eyes" ? 1 : 2,
          name: reactionName,
          user: {
            id: 999,
            username: "review-bot",
            name: "Review Bot"
          },
          created_at: new Date().toISOString()
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const worker = createWorker({
      payload: directMentionPayload,
      discussions: []
    });

    await worker.createReviewJobFromWebhook(directMentionPayload, tenant, {
      kind: "direct-mention",
      note: {
        kind: "merge-request-note",
        noteId: 55
      }
    });
    await worker.processJob("job_1");

    const postedUrls = fetchMock.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([input]) => String(input));
    const postedBodies = fetchMock.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => String(init?.body));

    expect(postedUrls.every((url) => url.includes("/merge_requests/7/notes/55/award_emoji"))).toBe(true);
    expect(postedBodies.some((body) => body.includes("name=eyes"))).toBe(true);
    expect(postedBodies.some((body) => body.includes("name=white_check_mark"))).toBe(true);
  });

  it("adds reactions to follow-up discussion notes when a review starts and completes", async () => {
    const discussions = [
      {
        id: "disc_1",
        individual_note: false,
        notes: [
          {
            id: 10,
            type: "DiscussionNote",
            body: "**Finding**\n\nOriginal wording",
            author: { id: 999, username: "review-bot", name: "Review Bot" },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            system: false
          },
          {
            id: 56,
            type: "DiscussionNote",
            body: "Please make this more human.",
            author: { id: 42, username: "developer", name: "Dev User" },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            system: false
          }
        ]
      }
    ] satisfies GitLabDiscussion[];

    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "GET" && url.includes("/discussions?")) {
        return new Response(JSON.stringify(discussions), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      if (init?.method === "GET" && url.includes("/discussions/disc_1/notes/56/award_emoji")) {
        return new Response("[]", {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      const body = String(init?.body);
      const reactionName = body.includes("white_check_mark") ? "white_check_mark" : "eyes";
      return new Response(
        JSON.stringify({
          id: reactionName === "eyes" ? 1 : 2,
          name: reactionName,
          user: {
            id: 999,
            username: "review-bot",
            name: "Review Bot"
          },
          created_at: new Date().toISOString()
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const worker = createWorker({
      payload: followUpPayload,
      discussions
    });

    await worker.createReviewJobFromWebhook(followUpPayload, tenant, {
      kind: "follow-up-comment",
      note: {
        kind: "discussion-note",
        discussionId: "disc_1",
        noteId: 56
      }
    });
    await worker.processJob("job_1");

    const postedUrls = fetchMock.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([input]) => String(input));
    const postedBodies = fetchMock.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => String(init?.body));

    expect(postedUrls.every((url) => url.includes("/merge_requests/7/discussions/disc_1/notes/56/award_emoji"))).toBe(
      true
    );
    expect(postedBodies.some((body) => body.includes("name=eyes"))).toBe(true);
    expect(postedBodies.some((body) => body.includes("name=white_check_mark"))).toBe(true);
  });
});

function createWorker(input: { payload: GitLabNoteHookPayload; discussions: GitLabDiscussion[] }): ReviewWorker {
  const job = {
    id: "job_1",
    tenantId: tenant.id,
    dedupeKey: "dedupe",
    projectId: tenant.projectId,
    mergeRequestIid: 7,
    noteId: input.payload.object_attributes.id,
    headSha: "abc123",
    status: "queued" as const,
    payloadJson: JSON.stringify(input.payload),
    retryCount: 0,
    lastError: null,
    enqueuedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null
  };

  const storage = {
    createOrGetReviewJob: vi.fn(async () => ({
      job,
      created: true
    })),
    getReviewJobById: vi.fn(async () => job),
    markJobInProgress: vi.fn(async () => {}),
    listDiscussionMappings: vi.fn(async () => []),
    createReviewRun: vi.fn(async () => ({
      id: "run_1",
      reviewJobId: "job_1",
      tenantId: tenant.id,
      provider: "copilot-sdk",
      model: null,
      status: "in_progress",
      resultJson: null,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null
    })),
    getLatestCompletedReviewForMergeRequest: vi.fn(async () => null),
    completeReviewRun: vi.fn(async () => {}),
    replaceReviewFindings: vi.fn(async () => {}),
    markJobCompleted: vi.fn(async () => {}),
    failReviewRun: vi.fn(async () => {}),
    markJobQueued: vi.fn(async () => {}),
    markJobFailed: vi.fn(async () => {})
  };

  return new ReviewWorker({
    storage: storage as never,
    tenantRegistry: {
      getTenantById: vi.fn(async () => tenant)
    } as never,
    hydrator: {
      hydrate: vi.fn(async () => ({
        tenant,
        job,
        mergeRequest: {
          id: 1,
          iid: 7,
          project_id: tenant.projectId,
          title: "Add worker",
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
        versions: [],
        latestVersion: null,
        changes: [],
        notes: [],
        discussions: input.discussions,
        workspace: {
          rootPath: join("tmp", "workspace"),
          cleanupRoot: join("tmp", "cleanup"),
          strategy: "targeted-files",
          instructionFiles: []
        },
        snapshot: {
          id: "snapshot_1",
          reviewJobId: "job_1",
          tenantId: tenant.id,
          mergeRequestIid: 7,
          headSha: "abc123",
          mergeRequestJson: "{}",
          versionsJson: "[]",
          changesJson: "[]",
          notesJson: "[]",
          discussionsJson: "[]",
          instructionsJson: "[]",
          workspaceStrategy: "targeted-files",
          createdAt: new Date().toISOString()
        }
      }))
    } as never,
    workspaceMaterializer: {
      cleanup: vi.fn(async () => {})
    } as never,
    reviewProvider: {
      name: "copilot-sdk",
      review: vi.fn(async () => ({
        overview: {
          summary: "Done",
          overallSeverity: "low" as const
        },
        findings: [],
        priorDispositions: []
      }))
    },
    reconciler: {
      reconcile: vi.fn(async () => ({
        created: 0,
        updated: 0,
        replied: 0,
        resolved: 0,
        kept: 0,
        summaryNoteAction: "created" as const
      }))
    } as never,
    logger: createLogger("silent"),
    runLogDir: join("tmp", "run-logs"),
    maxJobRetries: 3,
    retryBackoffMs: 5000
  });
}
