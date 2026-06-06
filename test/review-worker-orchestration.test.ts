import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";

import { ReviewWorker } from "../src/jobs/review-worker.js";
import { createLogger } from "../src/logger.js";
import type {
  IPlatform,
  PlatformReviewRuntime,
} from "../src/platforms/IPlatform.js";
import type { GitLabNoteHookPayload } from "../src/platforms/gitlab/types.js";
import type { InteractionRunArtifacts } from "../src/review/run-artifacts.js";
import type { TenantRecord } from "../src/storage/contract/index.js";
import type { StorageHelpers } from "../src/storage/storage-helpers.js";
import { createGitLabConnectionRecord } from "./helpers/gitlab-tenant.js";
import { wrapGitLabPlatformContext } from "./helpers/platform-context.js";
import { overridePlatformRuntime } from "./helpers/platform-runtime.js";

const tenant = {
  id: "tenant_1",
  key: "https://gitlab.example.com::123",
  platform: "gitlab",
  platformConnectionId: "connection-1",
  platformConfigJson: JSON.stringify({
    baseUrl: "https://gitlab.example.com",
    projectId: 123,
    apiToken: "token",
    webhookSecret: "secret",
    botUserId: 999,
    botUsername: "review-bot",
  }),
  baseUrl: "https://gitlab.example.com",
  projectId: 123,
  apiToken: "token",
  webhookSecret: "secret",
  botUserId: 999,
  botUsername: "review-bot",
  modelProfileName: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
const connection = createGitLabConnectionRecord();

const payload: GitLabNoteHookPayload = {
  object_kind: "note",
  project: {
    id: 123,
    web_url: "https://gitlab.example.com/group/project",
    path_with_namespace: "group/project",
  },
  repository: {
    homepage: "https://gitlab.example.com/group/project",
  },
  merge_request: {
    iid: 7,
    title: "Add worker",
    description: "Adds the worker",
    source_branch: "feature",
    target_branch: "main",
    last_commit: {
      id: "abc123",
    },
  },
  object_attributes: {
    id: 55,
    note: "@review-bot what changed here?",
    noteable_type: "MergeRequest",
  },
  user: {
    id: 42,
    username: "developer",
    name: "Dev User",
  },
};

function getRequestUrl(input: URL | RequestInfo): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

function createFreshTriggerNoteResponse(input: {
  requestUrl: string;
  commentId: number;
  kind?: "code-review-comment" | "discussion-comment";
  discussionId?: string;
}): Response {
  if (
    input.requestUrl.includes("/merge_requests/7/notes") &&
    !input.requestUrl.includes("/discussions/") &&
    !input.requestUrl.includes("/award_emoji")
  ) {
    return new Response(
      JSON.stringify(
        input.kind === "discussion-comment"
          ? []
          : [
              {
                id: input.commentId,
                body: payload.object_attributes.note,
                author: payload.user,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                system: false,
              },
            ],
      ),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    );
  }

  if (input.requestUrl.includes("/merge_requests/7/discussions")) {
    return new Response(
      JSON.stringify(
        input.kind === "discussion-comment"
          ? [
              {
                id: input.discussionId ?? "disc_trigger",
                individual_note: false,
                notes: [
                  {
                    id: input.commentId,
                    body: payload.object_attributes.note,
                    author: payload.user,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    system: false,
                  },
                ],
              },
            ]
          : [],
      ),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    );
  }

  return new Response("[]", {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

function createReviewRuntimeFactory(overrides: Partial<PlatformReviewRuntime>) {
  return ({
    platform,
    ...runtimeInput
  }: {
    platform: IPlatform;
    storage: StorageHelpers;
    logger: Logger;
    tenant: TenantRecord;
    interactionJobId: string;
    workspaceRoot: string;
    memoryEnabled: boolean;
    interactionRunId?: string | undefined;
    runArtifacts?: InteractionRunArtifacts | undefined;
  }) =>
    overridePlatformRuntime(
      platform.createReviewRuntime(runtimeInput),
      overrides,
    );
}

describe("ReviewWorker orchestration", () => {
  it("abandons the run without retry when the trigger comment no longer exists", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async (_input: URL | RequestInfo, init?: RequestInit) => {
        if (init?.method === "GET") {
          return new Response("[]", {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          });
        }

        return new Response(null, { status: 204 });
      },
    );

    const job = {
      id: "job_1",
      tenantId: tenant.id,
      dedupeKey: "dedupe",
      projectId: tenant.projectId,
      codeReviewId: 7,
      commentId: 55,
      headSha: "abc123",
      status: "queued" as const,
      payloadJson: JSON.stringify(payload),
      retryCount: 0,
      lastError: null,
      enqueuedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    const createInteractionRun = vi.fn(async () => ({
      id: "run_1",
      interactionJobId: job.id,
      tenantId: tenant.id,
      provider: "copilot-sdk",
      model: null,
      modelProfileName: null,
      providerBaseUrl: null,
      providerType: null,
      textGenerationModel: null,
      status: "in_progress" as const,
      resultJson: null,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    }));
    const cancelInteractionRun = vi.fn(async () => {});
    const failInteractionRun = vi.fn(async () => {});
    const markJobCancelled = vi.fn(async () => {});
    const markJobFailed = vi.fn(async () => {});
    const markJobQueued = vi.fn(async () => {});
    const hydrate = vi.fn(async () => {
      throw new Error(
        "full hydration should not run when the trigger comment is gone",
      );
    });

    const worker = new ReviewWorker({
      storage: {
        stores: {
          interactionJobs: {
            get: vi.fn(async () => job),
          },
          discussionMappings: {
            list: vi.fn(async () => []),
          },
          modelProfiles: {
            get: vi.fn(async () => null),
            find: vi.fn(async () => null),
          },
        },
        getInteractionJobById: vi.fn(async () => job),
        markJobInProgress: vi.fn(async () => {}),
        listDiscussionMappings: vi.fn(async () => []),
        createInteractionRun,
        getModelProfileByName: vi.fn(async () => null),
        getDefaultModelProfile: vi.fn(async () => null),
        getLatestCompletedInteractionForCodeReview: vi.fn(async () => null),
        listPriorReviewFindings: vi.fn(async () => []),
        completeInteractionRun: vi.fn(async () => {}),
        replaceReviewFindings: vi.fn(async () => {}),
        markJobCompleted: vi.fn(async () => {}),
        cancelInteractionRun,
        failInteractionRun,
        markJobCancelled,
        markJobQueued,
        markJobFailed,
      } as never,
      tenantRegistry: {
        getResolvedTenantById: vi.fn(async () => ({ tenant, connection })),
      } as never,
      reviewRuntimeFactory: createReviewRuntimeFactory({
        loadRoutingContext: vi.fn(async () =>
          wrapGitLabPlatformContext({
            tenant,
            job,
            mergeRequest: {
              id: 1,
              iid: 7,
              project_id: tenant.projectId,
              title: "Add worker",
              description: "Adds the worker",
              web_url:
                "https://gitlab.example.com/group/project/-/merge_requests/7",
              source_branch: "feature",
              target_branch: "main",
              author: {
                id: 42,
                username: "developer",
                name: "Dev User",
              },
            },
            changes: [],
            notes: [
              {
                id: 55,
                body: "@review-bot what changed here?",
                author: {
                  id: 42,
                  username: "developer",
                  name: "Dev User",
                },
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                system: false,
              },
            ],
            discussions: [],
            workspace: {
              rootPath: join("tmp", "workspace-routing"),
              cleanupRoot: join("tmp", "cleanup-routing"),
              strategy: "git",
              instructionFiles: [],
            },
            projectMemory: {
              enabled: true,
              page: null,
              entries: [],
            },
          }),
        ),
        hydrate,
        cleanupWorkspace: vi.fn(async () => {}),
      }),
      reviewProviderFactory: {
        createProvider: vi.fn(() => ({
          name: "copilot-sdk",
          review: vi.fn(),
        })),
      },
      chatterRunnerFactory: {
        createRunner: vi.fn(() => ({
          run: vi.fn(),
        })),
      } as never,
      reconciler: {
        reconcile: vi.fn(),
      } as never,
      logger: createLogger("silent"),
      runLogDir: join("tmp", "run-logs"),
      maxJobRetries: 2,
      retryBackoffMs: 1000,
    });

    await expect(worker.processJob(job.id)).rejects.toThrow(
      "Trigger comment 55 no longer exists on merge request 7",
    );

    expect(createInteractionRun).toHaveBeenCalledTimes(1);
    expect(hydrate).not.toHaveBeenCalled();
    expect(cancelInteractionRun).toHaveBeenCalledWith(
      "run_1",
      "Trigger comment 55 no longer exists on merge request 7",
    );
    expect(failInteractionRun).not.toHaveBeenCalled();
    expect(markJobQueued).not.toHaveBeenCalled();
    expect(markJobCancelled).toHaveBeenCalledWith(
      job.id,
      1,
      "Trigger comment 55 no longer exists on merge request 7",
    );
    expect(markJobFailed).not.toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });

  it("skips full hydration for chatter-only replies", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const requestUrl = getRequestUrl(input);
        if (init?.method === "GET") {
          return createFreshTriggerNoteResponse({ requestUrl, commentId: 55 });
        }

        if (requestUrl.includes("/award_emoji")) {
          return new Response(
            JSON.stringify({
              id: 1,
              name: "white_check_mark",
              user: {
                id: 999,
                username: "review-bot",
                name: "Review Bot",
              },
              created_at: new Date().toISOString(),
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        return new Response(
          JSON.stringify({
            id: 500,
            body: "Here is what changed.",
            author: {
              id: 999,
              username: "review-bot",
              name: "Review Bot",
            },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            system: false,
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      },
    );

    const job = {
      id: "job_1",
      tenantId: tenant.id,
      dedupeKey: "dedupe",
      projectId: tenant.projectId,
      codeReviewId: 7,
      commentId: 55,
      headSha: "abc123",
      status: "queued" as const,
      payloadJson: JSON.stringify(payload),
      retryCount: 0,
      lastError: null,
      enqueuedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    const completeInteractionRun = vi.fn(async () => {});
    const hydrate = vi.fn(async () => {
      throw new Error("full hydration should be skipped");
    });
    const chatterRun = vi.fn(async () => ({
      memory: {
        status: "skipped" as const,
        summary: "No durable memory detected.",
      },
      replies: [
        {
          target: {
            kind: "code-review-comment" as const,
            commentId: 55,
          },
          replyBody: "Here is what changed.",
        },
      ],
    }));

    const worker = new ReviewWorker({
      storage: {
        stores: {
          interactionJobs: {
            get: vi.fn(async () => job),
          },
          discussionMappings: {
            list: vi.fn(async () => []),
          },
          modelProfiles: {
            get: vi.fn(async () => null),
            find: vi.fn(async () => null),
          },
        },
        getInteractionJobById: vi.fn(async () => job),
        markJobInProgress: vi.fn(async () => {}),
        listDiscussionMappings: vi.fn(async () => []),
        createInteractionRun: vi.fn(async () => ({
          id: "run_1",
          interactionJobId: job.id,
          tenantId: tenant.id,
          provider: "copilot-sdk",
          model: null,
          modelProfileName: null,
          providerBaseUrl: null,
          providerType: null,
          textGenerationModel: null,
          status: "in_progress" as const,
          resultJson: null,
          error: null,
          startedAt: new Date().toISOString(),
          finishedAt: null,
        })),
        getModelProfileByName: vi.fn(async () => null),
        getDefaultModelProfile: vi.fn(async () => null),
        getLatestCompletedInteractionForCodeReview: vi.fn(async () => null),
        listPriorReviewFindings: vi.fn(async () => []),
        completeInteractionRun,
        replaceReviewFindings: vi.fn(async () => {}),
        markJobCompleted: vi.fn(async () => {}),
        failInteractionRun: vi.fn(async () => {}),
        markJobQueued: vi.fn(async () => {}),
        markJobFailed: vi.fn(async () => {}),
      } as never,
      tenantRegistry: {
        getResolvedTenantById: vi.fn(async () => ({ tenant, connection })),
      } as never,
      reviewRuntimeFactory: createReviewRuntimeFactory({
        loadRoutingContext: vi.fn(async () =>
          wrapGitLabPlatformContext({
            tenant,
            job,
            mergeRequest: {
              id: 1,
              iid: 7,
              project_id: tenant.projectId,
              title: "Add worker",
              description: "Adds the worker",
              web_url:
                "https://gitlab.example.com/group/project/-/merge_requests/7",
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
            workspace: {
              rootPath: join("tmp", "workspace-routing"),
              cleanupRoot: join("tmp", "cleanup-routing"),
              strategy: "git",
              instructionFiles: [],
            },
            projectMemory: {
              enabled: true,
              page: null,
              entries: [],
            },
          }),
        ),
        hydrate,
        cleanupWorkspace: vi.fn(async () => {}),
      }),
      reviewProviderFactory: {
        createProvider: vi.fn(() => ({
          name: "copilot-sdk",
          review: vi.fn(),
        })),
      },
      chatterRunnerFactory: {
        createRunner: vi.fn(() => ({
          run: chatterRun,
          sessionPaths: {
            memory: ["copilot", "chatter", "memory"],
            reply: ["copilot", "chatter", "reply"],
          },
        })),
      } as never,
      reconciler: {
        reconcile: vi.fn(),
      } as never,
      logger: createLogger("silent"),
      runLogDir: join("tmp", "run-logs"),
      maxJobRetries: 3,
      retryBackoffMs: 5000,
    });

    await expect(worker.processJob("job_1")).resolves.toBeUndefined();

    expect(hydrate).not.toHaveBeenCalled();
    expect(chatterRun).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "reply",
        reviewContext: expect.objectContaining({
          workspacePath: join("tmp", "workspace-routing"),
          codeReview: expect.objectContaining({
            id: 7,
          }),
        }),
        responseTargets: [
          expect.objectContaining({
            kind: "code-review-comment",
            commentId: 55,
          }),
        ],
      }),
      expect.any(Object),
    );
    expect(completeInteractionRun).toHaveBeenCalledWith("run_1", null);

    globalThis.fetch = originalFetch;
  });

  it("materializes GitLab image attachments for chatter-only runs without hydrating snapshots", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const requestUrl = getRequestUrl(input);
        if (
          init?.method === "GET" &&
          requestUrl.includes("/api/v4/projects/123/uploads/")
        ) {
          return new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: {
              "content-type": "image/png",
              "content-length": "3",
            },
          });
        }

        if (init?.method === "GET") {
          return createFreshTriggerNoteResponse({ requestUrl, commentId: 55 });
        }

        if (requestUrl.includes("/award_emoji")) {
          return new Response(
            JSON.stringify({
              id: 1,
              name: "white_check_mark",
              user: {
                id: 999,
                username: "review-bot",
                name: "Review Bot",
              },
              created_at: new Date().toISOString(),
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        return new Response(
          JSON.stringify({
            id: 501,
            body: "Here is what changed.",
            author: {
              id: 999,
              username: "review-bot",
              name: "Review Bot",
            },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            system: false,
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      },
    );

    const imagePayload = {
      ...payload,
      merge_request: {
        ...payload.merge_request,
        description:
          "Adds the worker ![Diagram](../uploads/xyz789/diagram.png)",
      },
      object_attributes: {
        ...payload.object_attributes,
        note: "@review-bot what changed here? ![Screenshot](../uploads/abc123/note-image.png)",
      },
    };
    const job = {
      id: "job_images",
      tenantId: tenant.id,
      dedupeKey: "dedupe-images",
      projectId: tenant.projectId,
      codeReviewId: 7,
      commentId: 55,
      headSha: "abc123",
      status: "queued" as const,
      payloadJson: JSON.stringify(imagePayload),
      retryCount: 0,
      lastError: null,
      enqueuedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    const hydrate = vi.fn(async () => {
      throw new Error("full hydration should be skipped");
    });
    const chatterRun = vi.fn(async () => ({
      memory: {
        status: "skipped" as const,
        summary: "No durable memory detected.",
      },
      replies: [
        {
          target: {
            kind: "code-review-comment" as const,
            commentId: 55,
          },
          replyBody: "Here is what changed.",
        },
      ],
    }));

    const worker = new ReviewWorker({
      storage: {
        stores: {
          interactionJobs: {
            get: vi.fn(async () => job),
          },
          discussionMappings: {
            list: vi.fn(async () => []),
          },
          modelProfiles: {
            get: vi.fn(async () => null),
            find: vi.fn(async () => null),
          },
        },
        getInteractionJobById: vi.fn(async () => job),
        markJobInProgress: vi.fn(async () => {}),
        listDiscussionMappings: vi.fn(async () => []),
        createInteractionRun: vi.fn(async () => ({
          id: "run_images",
          interactionJobId: job.id,
          tenantId: tenant.id,
          provider: "copilot-sdk",
          model: null,
          modelProfileName: null,
          providerBaseUrl: null,
          providerType: null,
          textGenerationModel: null,
          status: "in_progress" as const,
          resultJson: null,
          error: null,
          startedAt: new Date().toISOString(),
          finishedAt: null,
        })),
        getModelProfileByName: vi.fn(async () => null),
        getDefaultModelProfile: vi.fn(async () => null),
        getLatestCompletedInteractionForCodeReview: vi.fn(async () => null),
        listPriorReviewFindings: vi.fn(async () => []),
        completeInteractionRun: vi.fn(async () => {}),
        replaceReviewFindings: vi.fn(async () => {}),
        markJobCompleted: vi.fn(async () => {}),
        failInteractionRun: vi.fn(async () => {}),
        markJobQueued: vi.fn(async () => {}),
        markJobFailed: vi.fn(async () => {}),
      } as never,
      tenantRegistry: {
        getResolvedTenantById: vi.fn(async () => ({ tenant, connection })),
      } as never,
      reviewRuntimeFactory: createReviewRuntimeFactory({
        loadRoutingContext: vi.fn(async () =>
          wrapGitLabPlatformContext({
            tenant,
            job,
            mergeRequest: {
              id: 1,
              iid: 7,
              project_id: tenant.projectId,
              title: "Add worker",
              description:
                "Adds the worker ![Diagram](../uploads/xyz789/diagram.png)",
              web_url:
                "https://gitlab.example.com/group/project/-/merge_requests/7",
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
            workspace: {
              rootPath: join("tmp", "workspace-routing"),
              cleanupRoot: join("tmp", "cleanup-routing"),
              strategy: "git",
              instructionFiles: [],
            },
            projectMemory: {
              enabled: true,
              page: null,
              entries: [],
            },
          }),
        ),
        hydrate,
        cleanupWorkspace: vi.fn(async () => {}),
      }),
      reviewProviderFactory: {
        createProvider: vi.fn(() => ({
          name: "copilot-sdk",
          review: vi.fn(),
        })),
      },
      chatterRunnerFactory: {
        createRunner: vi.fn(() => ({
          run: chatterRun,
          sessionPaths: {
            memory: ["copilot", "chatter", "memory"],
            reply: ["copilot", "chatter", "reply"],
          },
        })),
      } as never,
      reconciler: {
        reconcile: vi.fn(),
      } as never,
      logger: createLogger("silent"),
      runLogDir: join("tmp", "run-logs"),
      maxJobRetries: 3,
      retryBackoffMs: 5000,
    });

    await expect(worker.processJob("job_images")).resolves.toBeUndefined();

    expect(hydrate).not.toHaveBeenCalled();
    expect(chatterRun).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          {
            type: "blob",
            data: "AQID",
            mimeType: "image/png",
            displayName: "trigger-comment-55-note-image.png",
          },
          {
            type: "blob",
            data: "AQID",
            mimeType: "image/png",
            displayName: "code-review-description-diagram.png",
          },
        ],
        reviewContext: expect.objectContaining({
          attachments: [
            {
              sourceKind: "trigger-comment",
              commentId: 55,
              displayName: "trigger-comment-55-note-image.png",
              contentType: "image/png",
            },
            {
              sourceKind: "code-review-description",
              commentId: null,
              displayName: "code-review-description-diagram.png",
              contentType: "image/png",
            },
          ],
        }),
      }),
      expect.any(Object),
    );

    globalThis.fetch = originalFetch;
  });

  it("completes the run even when chatter reply publishing fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const requestUrl = getRequestUrl(input);
        if (init?.method === "GET") {
          return createFreshTriggerNoteResponse({ requestUrl, commentId: 56 });
        }

        if (requestUrl.includes("/award_emoji")) {
          return new Response(
            JSON.stringify({
              id: 1,
              name: "white_check_mark",
              user: {
                id: 999,
                username: "review-bot",
                name: "Review Bot",
              },
              created_at: new Date().toISOString(),
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        return new Response("boom", {
          status: 500,
          headers: {
            "content-type": "text/plain",
          },
        });
      },
    );

    const job = {
      id: "job_2",
      tenantId: tenant.id,
      dedupeKey: "dedupe-2",
      projectId: tenant.projectId,
      codeReviewId: 7,
      commentId: 56,
      headSha: "abc123",
      status: "queued" as const,
      payloadJson: JSON.stringify({
        ...payload,
        object_attributes: {
          ...payload.object_attributes,
          id: 56,
          note: "@review-bot what changed here?",
        },
      }),
      retryCount: 0,
      lastError: null,
      enqueuedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    const completeInteractionRun = vi.fn(async () => {});
    const markJobCompleted = vi.fn(async () => {});

    const worker = new ReviewWorker({
      storage: {
        stores: {
          interactionJobs: {
            get: vi.fn(async () => job),
          },
          discussionMappings: {
            list: vi.fn(async () => []),
          },
          modelProfiles: {
            get: vi.fn(async () => null),
            find: vi.fn(async () => null),
          },
        },
        getInteractionJobById: vi.fn(async () => job),
        markJobInProgress: vi.fn(async () => {}),
        listDiscussionMappings: vi.fn(async () => []),
        createInteractionRun: vi.fn(async () => ({
          id: "run_2",
          interactionJobId: job.id,
          tenantId: tenant.id,
          provider: "copilot-sdk",
          model: null,
          modelProfileName: null,
          providerBaseUrl: null,
          providerType: null,
          textGenerationModel: null,
          status: "in_progress" as const,
          resultJson: null,
          error: null,
          startedAt: new Date().toISOString(),
          finishedAt: null,
        })),
        getModelProfileByName: vi.fn(async () => null),
        getDefaultModelProfile: vi.fn(async () => null),
        getLatestCompletedInteractionForCodeReview: vi.fn(async () => null),
        listPriorReviewFindings: vi.fn(async () => []),
        completeInteractionRun,
        replaceReviewFindings: vi.fn(async () => {}),
        markJobCompleted,
        failInteractionRun: vi.fn(async () => {}),
        markJobQueued: vi.fn(async () => {}),
        markJobFailed: vi.fn(async () => {}),
      } as never,
      tenantRegistry: {
        getResolvedTenantById: vi.fn(async () => ({ tenant, connection })),
      } as never,
      reviewRuntimeFactory: createReviewRuntimeFactory({
        loadRoutingContext: vi.fn(async () =>
          wrapGitLabPlatformContext({
            tenant,
            job,
            mergeRequest: {
              id: 1,
              iid: 7,
              project_id: tenant.projectId,
              title: "Add worker",
              description: "Adds the worker",
              web_url:
                "https://gitlab.example.com/group/project/-/merge_requests/7",
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
            workspace: {
              rootPath: join("tmp", "workspace-routing"),
              cleanupRoot: join("tmp", "cleanup-routing"),
              strategy: "git",
              instructionFiles: [],
            },
            projectMemory: {
              enabled: true,
              page: null,
              entries: [],
            },
          }),
        ),
        hydrate: vi.fn(async () => {
          throw new Error("full hydration should be skipped");
        }),
        cleanupWorkspace: vi.fn(async () => {}),
      }),
      reviewProviderFactory: {
        createProvider: vi.fn(() => ({
          name: "copilot-sdk",
          review: vi.fn(),
        })),
      },
      chatterRunnerFactory: {
        createRunner: vi.fn(() => ({
          run: vi.fn(async () => ({
            memory: {
              status: "skipped" as const,
              summary: "No durable memory detected.",
            },
            replies: [
              {
                target: {
                  kind: "code-review-comment" as const,
                  commentId: 56,
                },
                replyBody: "Here is what changed.",
              },
            ],
          })),
          sessionPaths: {
            memory: ["copilot", "chatter", "memory"],
            reply: ["copilot", "chatter", "reply"],
          },
        })),
      } as never,
      reconciler: {
        reconcile: vi.fn(),
      } as never,
      logger: createLogger("silent"),
      runLogDir: join("tmp", "run-logs"),
      maxJobRetries: 3,
      retryBackoffMs: 5000,
    });

    await expect(worker.processJob("job_2")).resolves.toBeUndefined();

    expect(completeInteractionRun).toHaveBeenCalledWith("run_2", null);
    expect(markJobCompleted).toHaveBeenCalledTimes(1);

    globalThis.fetch = originalFetch;
  });

  it("publishes chatter replies into the existing discussion when the trigger comment is threaded", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const requestUrl = getRequestUrl(input);
        if (init?.method === "GET") {
          return createFreshTriggerNoteResponse({
            requestUrl,
            commentId: 77,
            kind: "discussion-comment",
            discussionId: "disc_77",
          });
        }

        if (requestUrl.includes("/award_emoji")) {
          return new Response(
            JSON.stringify({
              id: 1,
              name: "white_check_mark",
              user: {
                id: 999,
                username: "review-bot",
                name: "Review Bot",
              },
              created_at: new Date().toISOString(),
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        return new Response(
          JSON.stringify({
            id: 501,
            body: "Here is the explanation.",
            author: {
              id: 999,
              username: "review-bot",
              name: "Review Bot",
            },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            system: false,
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      },
    );
    globalThis.fetch = fetchMock;

    const threadedPayload = {
      ...payload,
      object_attributes: {
        ...payload.object_attributes,
        id: 77,
        note: "@review-bot can you explain this change?",
      },
    };
    const job = {
      id: "job_3",
      tenantId: tenant.id,
      dedupeKey: "dedupe-3",
      projectId: tenant.projectId,
      codeReviewId: 7,
      commentId: 77,
      headSha: "abc123",
      status: "queued" as const,
      payloadJson: JSON.stringify(threadedPayload),
      retryCount: 0,
      lastError: null,
      enqueuedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };

    const worker = new ReviewWorker({
      storage: {
        stores: {
          interactionJobs: {
            get: vi.fn(async () => job),
          },
          discussionMappings: {
            list: vi.fn(async () => []),
          },
          modelProfiles: {
            get: vi.fn(async () => null),
            find: vi.fn(async () => null),
          },
        },
        getInteractionJobById: vi.fn(async () => job),
        markJobInProgress: vi.fn(async () => {}),
        listDiscussionMappings: vi.fn(async () => []),
        createInteractionRun: vi.fn(async () => ({
          id: "run_3",
          interactionJobId: job.id,
          tenantId: tenant.id,
          provider: "copilot-sdk",
          model: null,
          modelProfileName: null,
          providerBaseUrl: null,
          providerType: null,
          textGenerationModel: null,
          status: "in_progress" as const,
          resultJson: null,
          error: null,
          startedAt: new Date().toISOString(),
          finishedAt: null,
        })),
        getModelProfileByName: vi.fn(async () => null),
        getDefaultModelProfile: vi.fn(async () => null),
        getLatestCompletedInteractionForCodeReview: vi.fn(async () => null),
        listPriorReviewFindings: vi.fn(async () => []),
        completeInteractionRun: vi.fn(async () => {}),
        replaceReviewFindings: vi.fn(async () => {}),
        markJobCompleted: vi.fn(async () => {}),
        failInteractionRun: vi.fn(async () => {}),
        markJobQueued: vi.fn(async () => {}),
        markJobFailed: vi.fn(async () => {}),
      } as never,
      tenantRegistry: {
        getResolvedTenantById: vi.fn(async () => ({ tenant, connection })),
      } as never,
      reviewRuntimeFactory: createReviewRuntimeFactory({
        loadRoutingContext: vi.fn(async () =>
          wrapGitLabPlatformContext({
            tenant,
            job,
            mergeRequest: {
              id: 1,
              iid: 7,
              project_id: tenant.projectId,
              title: "Add worker",
              description: "Adds the worker",
              web_url:
                "https://gitlab.example.com/group/project/-/merge_requests/7",
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
            discussions: [
              {
                id: "disc_individual",
                individual_note: true,
                notes: [
                  {
                    id: 77,
                    body: "@review-bot can you explain this change?",
                    author: {
                      id: 42,
                      username: "developer",
                      name: "Dev User",
                    },
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    system: false,
                  },
                ],
              },
            ],
            workspace: {
              rootPath: join("tmp", "workspace-routing"),
              cleanupRoot: join("tmp", "cleanup-routing"),
              strategy: "git",
              instructionFiles: [],
            },
            projectMemory: {
              enabled: true,
              page: null,
              entries: [],
            },
          }),
        ),
        hydrate: vi.fn(async () => {
          throw new Error("full hydration should be skipped");
        }),
        cleanupWorkspace: vi.fn(async () => {}),
      }),
      reviewProviderFactory: {
        createProvider: vi.fn(() => ({
          name: "copilot-sdk",
          review: vi.fn(),
        })),
      },
      chatterRunnerFactory: {
        createRunner: vi.fn(() => ({
          run: vi.fn(async () => ({
            memory: {
              status: "skipped" as const,
              summary: "No durable memory detected.",
            },
            replies: [
              {
                target: {
                  kind: "discussion-reply" as const,
                  commentId: 77,
                  discussionId: "disc_individual",
                },
                replyBody: "Here is the explanation.",
              },
            ],
          })),
          sessionPaths: {
            memory: ["copilot", "chatter", "memory"],
            reply: ["copilot", "chatter", "reply"],
          },
        })),
      } as never,
      reconciler: {
        reconcile: vi.fn(),
      } as never,
      logger: createLogger("silent"),
      runLogDir: join("tmp", "run-logs"),
      maxJobRetries: 3,
      retryBackoffMs: 5000,
    });

    await expect(worker.processJob("job_3")).resolves.toBeUndefined();

    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          init?.method === "POST" &&
          String(input).includes(
            "/merge_requests/7/discussions/disc_individual/notes",
          ),
      ),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          init?.method === "POST" &&
          String(input).includes("/merge_requests/7/notes") &&
          !String(input).includes("/discussions/") &&
          !String(input).includes("/award_emoji"),
      ),
    ).toBe(false);

    globalThis.fetch = originalFetch;
  });

  it("syncs resolved discussion findings before starting review", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const requestUrl = getRequestUrl(input);
        if (init?.method === "GET") {
          return createFreshTriggerNoteResponse({ requestUrl, commentId: 58 });
        }

        if (requestUrl.includes("/award_emoji")) {
          return new Response(
            JSON.stringify({
              id: 1,
              name: "white_check_mark",
              user: {
                id: 999,
                username: "review-bot",
                name: "Review Bot",
              },
              created_at: new Date().toISOString(),
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        return new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      },
    );

    const job = {
      id: "job_4",
      tenantId: tenant.id,
      dedupeKey: "dedupe-4",
      projectId: tenant.projectId,
      codeReviewId: 7,
      commentId: 58,
      headSha: "abc123",
      status: "queued" as const,
      payloadJson: JSON.stringify({
        ...payload,
        object_attributes: {
          ...payload.object_attributes,
          id: 58,
          note: "@review-bot please review again",
        },
      }),
      retryCount: 0,
      lastError: null,
      enqueuedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    const mappings = [
      {
        id: "map_1",
        tenantId: tenant.id,
        projectId: tenant.projectId,
        codeReviewId: 7,
        identityKey: "identity_old",
        findingFingerprint: "fingerprint_old",
        title: "Old finding",
        severity: "medium",
        category: "bug",
        body: "**Old finding**\n\nOld body",
        platformDiscussionId: "disc_1",
        platformCommentId: 10,
        anchorJson: null,
        positionJson: null,
        botDiscussion: true,
        botComment: true,
        commentAuthorId: 999,
        commentAuthorUsername: "review-bot",
        status: "open" as const,
        lastInteractionRunId: "run_old",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    const priorFindings: Array<{
      findingId: string;
      identityKey: string;
      status: "open" | "resolved";
      title: string;
      body: string;
      severity: string;
      category: string;
      anchor: null;
      suggestion: null;
      interactionRunId: string;
      reviewedAt: string;
      headSha: string;
    }> = [
      {
        findingId: "finding_1",
        identityKey: "identity_old",
        status: "open" as const,
        title: "Old finding",
        body: "Old body",
        severity: "medium",
        category: "bug",
        anchor: null,
        suggestion: null,
        interactionRunId: "run_old",
        reviewedAt: new Date().toISOString(),
        headSha: "abc123",
      },
    ];
    const updateReviewFindingStatus = vi.fn(
      async (
        _tenantId: string,
        _codeReviewId: number,
        identityKey: string,
        status: "open" | "resolved",
      ) => {
        for (const finding of priorFindings) {
          if (finding.identityKey === identityKey) {
            finding.status = status;
          }
        }
        return true;
      },
    );
    const upsertDiscussionMapping = vi.fn(async (input) => {
      mappings[0] = {
        ...mappings[0],
        ...input,
        createdAt: mappings[0]?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return mappings[0];
    });
    const review = vi.fn(
      async (_context: {
        scope: { priorFindings: Array<{ status: string }> };
      }) => ({
        overview: {
          summary: "No further issues found",
          overallSeverity: "low" as const,
        },
        findings: [],
        priorDispositions: [],
      }),
    );

    const routingContext = wrapGitLabPlatformContext({
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
          name: "Dev User",
        },
      },
      changes: [],
      notes: [
        {
          id: 58,
          body: "@review-bot please review again",
          author: {
            id: 42,
            username: "developer",
            name: "Dev User",
          },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          system: false,
        },
      ],
      discussions: [
        {
          id: "disc_1",
          individual_note: false,
          notes: [
            {
              id: 10,
              body: "**Old finding**\n\nOld body",
              author: {
                id: 999,
                username: "review-bot",
                name: "Review Bot",
              },
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              system: false,
              resolved: true,
            },
          ],
        },
      ],
      workspace: {
        rootPath: join("tmp", "workspace-routing"),
        cleanupRoot: join("tmp", "cleanup-routing"),
        strategy: "git" as const,
        instructionFiles: [],
      },
      projectMemory: {
        enabled: true,
        page: null,
        entries: [],
      },
    });

    const worker = new ReviewWorker({
      storage: {
        stores: {
          interactionJobs: {
            get: vi.fn(async () => job),
          },
          discussionMappings: {
            list: vi.fn(async () => mappings),
          },
          modelProfiles: {
            get: vi.fn(async () => null),
            find: vi.fn(async () => null),
          },
        },
        getInteractionJobById: vi.fn(async () => job),
        markJobInProgress: vi.fn(async () => {}),
        createInteractionRun: vi.fn(async () => ({
          id: "run_4",
          interactionJobId: job.id,
          tenantId: tenant.id,
          provider: "copilot-sdk",
          model: null,
          modelProfileName: null,
          providerBaseUrl: null,
          providerType: null,
          textGenerationModel: null,
          status: "in_progress" as const,
          resultJson: null,
          error: null,
          startedAt: new Date().toISOString(),
          finishedAt: null,
        })),
        getModelProfileByName: vi.fn(async () => null),
        getDefaultModelProfile: vi.fn(async () => null),
        getLatestCompletedInteractionForCodeReview: vi.fn(async () => null),
        listPriorReviewFindings: vi.fn(async () => [...priorFindings]),
        completeInteractionRun: vi.fn(async () => {}),
        replaceReviewFindings: vi.fn(async () => {}),
        updateReviewFindingStatus,
        upsertDiscussionMapping,
        markJobCompleted: vi.fn(async () => {}),
        failInteractionRun: vi.fn(async () => {}),
        markJobQueued: vi.fn(async () => {}),
        markJobFailed: vi.fn(async () => {}),
      } as never,
      tenantRegistry: {
        getResolvedTenantById: vi.fn(async () => ({ tenant, connection })),
      } as never,
      reviewRuntimeFactory: createReviewRuntimeFactory({
        loadRoutingContext: vi.fn(async () => routingContext),
        hydrate: vi.fn(async () => routingContext),
        cleanupWorkspace: vi.fn(async () => {}),
      }),
      reviewProviderFactory: {
        createProvider: vi.fn(() => ({
          name: "copilot-sdk",
          review,
        })),
      },
      chatterRunnerFactory: {
        createRunner: vi.fn(() => ({
          run: vi.fn(async () => ({
            memory: {
              status: "skipped" as const,
              summary: "No durable memory detected.",
            },
            replies: [],
          })),
          sessionPaths: {
            memory: ["copilot", "chatter", "memory"],
            reply: ["copilot", "chatter", "reply"],
          },
        })),
      } as never,
      reconciler: {
        reconcile: vi.fn(async () => ({
          created: 0,
          updated: 0,
          replied: 0,
          resolved: 0,
          kept: 0,
          summaryCommentAction: null,
        })),
      } as never,
      logger: createLogger("silent"),
      runLogDir: join("tmp", "run-logs"),
      maxJobRetries: 3,
      retryBackoffMs: 5000,
    });

    await expect(worker.processJob("job_4")).resolves.toBeUndefined();

    expect(upsertDiscussionMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "map_1",
        platformDiscussionId: "disc_1",
        status: "resolved",
      }),
    );
    expect(updateReviewFindingStatus).toHaveBeenCalledWith(
      tenant.id,
      7,
      "identity_old",
      "resolved",
      {
        currentStatuses: ["open", "resolved"],
      },
    );
    const reviewContext = review.mock.calls[0]?.[0];
    expect(reviewContext).toBeDefined();
    if (!reviewContext) {
      throw new Error("expected review context");
    }
    expect(reviewContext.scope.priorFindings[0]?.status).toBe("resolved");
    expect(
      updateReviewFindingStatus.mock.invocationCallOrder[0] ?? 0,
    ).toBeLessThan(
      review.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );

    globalThis.fetch = originalFetch;
  });

  it("preserves dismissed findings during pre-review status sync", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const requestUrl = getRequestUrl(input);
        if (init?.method === "GET") {
          return createFreshTriggerNoteResponse({ requestUrl, commentId: 59 });
        }

        if (requestUrl.includes("/award_emoji")) {
          return new Response(
            JSON.stringify({
              id: 1,
              name: "white_check_mark",
              user: {
                id: 999,
                username: "review-bot",
                name: "Review Bot",
              },
              created_at: new Date().toISOString(),
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        return new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      },
    );

    const job = {
      id: "job_5",
      tenantId: tenant.id,
      dedupeKey: "dedupe-5",
      projectId: tenant.projectId,
      codeReviewId: 7,
      commentId: 59,
      headSha: "abc123",
      status: "queued" as const,
      payloadJson: JSON.stringify({
        ...payload,
        object_attributes: {
          ...payload.object_attributes,
          id: 59,
          note: "@review-bot please review again",
        },
      }),
      retryCount: 0,
      lastError: null,
      enqueuedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    const mappings = [
      {
        id: "map_2",
        tenantId: tenant.id,
        projectId: tenant.projectId,
        codeReviewId: 7,
        identityKey: "identity_dismissed",
        findingFingerprint: "fingerprint_dismissed",
        title: "Accepted risk finding",
        severity: "medium",
        category: "bug",
        body: "**Accepted risk finding**\n\nOld body",
        platformDiscussionId: "disc_2",
        platformCommentId: 11,
        anchorJson: null,
        positionJson: null,
        botDiscussion: true,
        botComment: true,
        commentAuthorId: 999,
        commentAuthorUsername: "review-bot",
        status: "resolved" as const,
        lastInteractionRunId: "run_old",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    const priorFindings: Array<{
      findingId: string;
      identityKey: string;
      status: "open" | "resolved" | "dismissed";
      title: string;
      body: string;
      severity: string;
      category: string;
      anchor: null;
      suggestion: null;
      interactionRunId: string;
      reviewedAt: string;
      headSha: string;
    }> = [
      {
        findingId: "finding_2",
        identityKey: "identity_dismissed",
        status: "dismissed",
        title: "Accepted risk finding",
        body: "Old body",
        severity: "medium",
        category: "bug",
        anchor: null,
        suggestion: null,
        interactionRunId: "run_old",
        reviewedAt: new Date().toISOString(),
        headSha: "abc123",
      },
    ];
    const updateReviewFindingStatus = vi.fn(
      async (
        _tenantId: string,
        _codeReviewId: number,
        identityKey: string,
        status: "open" | "resolved",
        options?: {
          currentStatuses?: ReadonlyArray<"open" | "resolved" | "dismissed">;
        },
      ) => {
        const allowedStatuses = options?.currentStatuses;
        let updated = false;
        for (const finding of priorFindings) {
          if (finding.identityKey !== identityKey) {
            continue;
          }
          if (allowedStatuses && !allowedStatuses.includes(finding.status)) {
            continue;
          }
          finding.status = status;
          updated = true;
        }
        return updated;
      },
    );
    const upsertDiscussionMapping = vi.fn(async (input) => {
      mappings[0] = {
        ...mappings[0],
        ...input,
        createdAt: mappings[0]?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return mappings[0];
    });
    const review = vi.fn(
      async (_context: {
        scope: { priorFindings: Array<{ status: string }> };
      }) => ({
        overview: {
          summary: "No further issues found",
          overallSeverity: "low" as const,
        },
        findings: [],
        priorDispositions: [],
      }),
    );

    const routingContext = wrapGitLabPlatformContext({
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
          name: "Dev User",
        },
      },
      changes: [],
      notes: [
        {
          id: 59,
          body: "@review-bot please review again",
          author: {
            id: 42,
            username: "developer",
            name: "Dev User",
          },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          system: false,
        },
      ],
      discussions: [
        {
          id: "disc_2",
          individual_note: false,
          notes: [
            {
              id: 11,
              body: "**Accepted risk finding**\n\nOld body",
              author: {
                id: 999,
                username: "review-bot",
                name: "Review Bot",
              },
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              system: false,
              resolved: false,
            },
          ],
        },
      ],
      workspace: {
        rootPath: join("tmp", "workspace-routing"),
        cleanupRoot: join("tmp", "cleanup-routing"),
        strategy: "git" as const,
        instructionFiles: [],
      },
      projectMemory: {
        enabled: true,
        page: null,
        entries: [],
      },
    });

    const worker = new ReviewWorker({
      storage: {
        stores: {
          interactionJobs: {
            get: vi.fn(async () => job),
          },
          discussionMappings: {
            list: vi.fn(async () => mappings),
          },
          modelProfiles: {
            get: vi.fn(async () => null),
            find: vi.fn(async () => null),
          },
        },
        getInteractionJobById: vi.fn(async () => job),
        markJobInProgress: vi.fn(async () => {}),
        createInteractionRun: vi.fn(async () => ({
          id: "run_5",
          interactionJobId: job.id,
          tenantId: tenant.id,
          provider: "copilot-sdk",
          model: null,
          modelProfileName: null,
          providerBaseUrl: null,
          providerType: null,
          textGenerationModel: null,
          status: "in_progress" as const,
          resultJson: null,
          error: null,
          startedAt: new Date().toISOString(),
          finishedAt: null,
        })),
        getModelProfileByName: vi.fn(async () => null),
        getDefaultModelProfile: vi.fn(async () => null),
        getLatestCompletedInteractionForCodeReview: vi.fn(async () => null),
        listPriorReviewFindings: vi.fn(async () => [...priorFindings]),
        completeInteractionRun: vi.fn(async () => {}),
        replaceReviewFindings: vi.fn(async () => {}),
        updateReviewFindingStatus,
        upsertDiscussionMapping,
        markJobCompleted: vi.fn(async () => {}),
        failInteractionRun: vi.fn(async () => {}),
        markJobQueued: vi.fn(async () => {}),
        markJobFailed: vi.fn(async () => {}),
      } as never,
      tenantRegistry: {
        getResolvedTenantById: vi.fn(async () => ({ tenant, connection })),
      } as never,
      reviewRuntimeFactory: createReviewRuntimeFactory({
        loadRoutingContext: vi.fn(async () => routingContext),
        hydrate: vi.fn(async () => routingContext),
        cleanupWorkspace: vi.fn(async () => {}),
      }),
      reviewProviderFactory: {
        createProvider: vi.fn(() => ({
          name: "copilot-sdk",
          review,
        })),
      },
      chatterRunnerFactory: {
        createRunner: vi.fn(() => ({
          run: vi.fn(async () => ({
            memory: {
              status: "skipped" as const,
              summary: "No durable memory detected.",
            },
            replies: [],
          })),
          sessionPaths: {
            memory: ["copilot", "chatter", "memory"],
            reply: ["copilot", "chatter", "reply"],
          },
        })),
      } as never,
      reconciler: {
        reconcile: vi.fn(async () => ({
          created: 0,
          updated: 0,
          replied: 0,
          resolved: 0,
          kept: 0,
          summaryCommentAction: null,
        })),
      } as never,
      logger: createLogger("silent"),
      runLogDir: join("tmp", "run-logs"),
      maxJobRetries: 3,
      retryBackoffMs: 5000,
    });

    await expect(worker.processJob("job_5")).resolves.toBeUndefined();

    expect(updateReviewFindingStatus).toHaveBeenCalledWith(
      tenant.id,
      7,
      "identity_dismissed",
      "open",
      {
        currentStatuses: ["open", "resolved"],
      },
    );
    expect(priorFindings[0]?.status).toBe("dismissed");
    const reviewContext = review.mock.calls[0]?.[0];
    expect(reviewContext).toBeDefined();
    if (!reviewContext) {
      throw new Error("expected review context");
    }
    expect(reviewContext.scope.priorFindings[0]?.status).toBe("dismissed");

    globalThis.fetch = originalFetch;
  });
});
