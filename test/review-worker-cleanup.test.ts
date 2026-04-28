import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

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
    note: "@review-bot review",
    noteable_type: "MergeRequest"
  },
  user: {
    id: 42,
    username: "developer",
    name: "Dev User"
  }
};

describe("ReviewWorker cleanup", () => {
  it("does not fail a completed job when workspace cleanup throws", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === "GET") {
        return new Response("[]", {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      return new Response(
        JSON.stringify({
          id: 1,
          name: "white_check_mark",
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
      getReviewJobById: vi.fn(async () => job),
      markJobInProgress: vi.fn(async () => {}),
      listDiscussionMappings: vi.fn(async () => []),
      createReviewRun: vi.fn(async () => ({
        id: "run_1",
        reviewJobId: job.id,
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
            strategy: "git",
            instructionFiles: []
          },
          projectMemory: {
            enabled: true,
            page: null,
            entries: []
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
            projectMemoryJson: null,
            workspaceStrategy: "git",
            createdAt: new Date().toISOString()
          }
        }))
      } as never,
      workspaceMaterializer: {
        cleanup: vi.fn(async () => {
          throw Object.assign(new Error("busy"), { code: "EBUSY" });
        })
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

    await expect(worker.processJob("job_1")).resolves.toBeUndefined();
    expect(storage.markJobCompleted).toHaveBeenCalledTimes(1);
    expect(storage.failReviewRun).not.toHaveBeenCalled();
    expect(storage.markJobFailed).not.toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });
});
