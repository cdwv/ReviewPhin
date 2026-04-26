import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GitLabClient } from "../src/gitlab/client.js";
import { ReviewWorker } from "../src/jobs/review-worker.js";
import { createLogger } from "../src/logger.js";
import type { GitLabNoteHookPayload } from "../src/gitlab/types.js";

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

const payload: GitLabNoteHookPayload = {
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
    note: "please /review this",
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

  it("adds reactions when a review starts and completes", async () => {
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === "GET") {
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

    const job = {
      id: "job_1",
      tenantId: tenant.id,
      dedupeKey: "dedupe",
      projectId: tenant.projectId,
      mergeRequestIid: 7,
      noteId: 55,
      headSha: "abc123",
      status: "queued" as const,
      payloadJson: JSON.stringify(payload),
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
      completeReviewRun: vi.fn(async () => {}),
      replaceReviewFindings: vi.fn(async () => {}),
      markJobCompleted: vi.fn(async () => {}),
      failReviewRun: vi.fn(async () => {}),
      markJobQueued: vi.fn(async () => {}),
      markJobFailed: vi.fn(async () => {})
    };

    const worker = new ReviewWorker({
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
          discussions: [],
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
          kept: 0
        }))
      } as never,
      logger: createLogger("silent"),
      maxJobRetries: 3,
      retryBackoffMs: 5000
    });

    await worker.createReviewJobFromWebhook(payload, tenant);
    await worker.processJob("job_1");

    const postedBodies = fetchMock.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => String(init?.body));

    expect(postedBodies.some((body) => body.includes("name=eyes"))).toBe(true);
    expect(postedBodies.some((body) => body.includes("name=white_check_mark"))).toBe(true);
  });
});
