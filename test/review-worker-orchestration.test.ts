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
  modelProfileName: null,
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
    note: "@review-bot what changed here?",
    noteable_type: "MergeRequest"
  },
  user: {
    id: 42,
    username: "developer",
    name: "Dev User"
  }
};

describe("ReviewWorker orchestration", () => {
  it("skips full hydration for chatter-only replies", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const requestUrl = String(input);
      if (init?.method === "GET") {
        return new Response("[]", {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
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
      }

      return new Response(
        JSON.stringify({
          id: 500,
          body: "Here is what changed.",
          author: {
            id: 999,
            username: "review-bot",
            name: "Review Bot"
          },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          system: false
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }) as typeof globalThis.fetch;

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
    const completeInteractionRun = vi.fn(async () => {});
    const hydrate = vi.fn(async () => {
      throw new Error("full hydration should be skipped");
    });
    const chatterRun = vi.fn(async () => ({
      memory: {
        status: "skipped" as const,
        summary: "No durable memory detected."
      },
      replies: [
        {
          target: {
            kind: "merge-request-note" as const,
            noteId: 55
          },
          replyBody: "Here is what changed."
        }
      ]
    }));

    const worker = new ReviewWorker({
      storage: {
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
          finishedAt: null
        })),
        getModelProfileByName: vi.fn(async () => null),
        getDefaultModelProfile: vi.fn(async () => null),
        getLatestCompletedInteractionForMergeRequest: vi.fn(async () => null),
        listPriorReviewFindings: vi.fn(async () => []),
        completeInteractionRun,
        replaceReviewFindings: vi.fn(async () => {}),
        markJobCompleted: vi.fn(async () => {}),
        failInteractionRun: vi.fn(async () => {}),
        markJobQueued: vi.fn(async () => {}),
        markJobFailed: vi.fn(async () => {})
      } as never,
      tenantRegistry: {
        getTenantById: vi.fn(async () => tenant)
      } as never,
      hydrator: {
        loadRoutingContext: vi.fn(async () => ({
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
          changes: [],
          notes: [],
          discussions: [],
          workspace: {
            rootPath: join("tmp", "workspace-routing"),
            cleanupRoot: join("tmp", "cleanup-routing"),
            strategy: "git",
            instructionFiles: []
          },
          projectMemory: {
            enabled: true,
            page: null,
            entries: []
          }
        })),
        hydrate
      } as never,
      workspaceMaterializer: {
        cleanup: vi.fn(async () => {})
      } as never,
      reviewProviderFactory: {
        createProvider: vi.fn(() => ({
          name: "copilot-sdk",
          review: vi.fn()
        }))
      },
      chatterRunnerFactory: {
        createRunner: vi.fn(() => ({
          run: chatterRun,
          sessionPaths: {
            memory: ["copilot", "chatter", "memory"],
            reply: ["copilot", "chatter", "reply"]
          }
        }))
      } as never,
      reconciler: {
        reconcile: vi.fn()
      } as never,
      logger: createLogger("silent"),
      runLogDir: join("tmp", "run-logs"),
      maxJobRetries: 3,
      retryBackoffMs: 5000
    });

    await expect(worker.processJob("job_1")).resolves.toBeUndefined();

    expect(hydrate).not.toHaveBeenCalled();
    expect(chatterRun).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "reply",
        reviewContext: expect.objectContaining({
          workspacePath: join("tmp", "workspace-routing"),
          mergeRequest: expect.objectContaining({
            iid: 7
          })
        }),
        responseTargets: [
          expect.objectContaining({
            kind: "merge-request-note",
            noteId: 55
          })
        ]
      }),
      expect.any(Object)
    );
    expect(completeInteractionRun).toHaveBeenCalledWith("run_1", null);

    globalThis.fetch = originalFetch;
  });

  it("completes the run even when chatter reply publishing fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const requestUrl = String(input);
      if (init?.method === "GET") {
        return new Response("[]", {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
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
      }

      return new Response("boom", {
        status: 500,
        headers: {
          "content-type": "text/plain"
        }
      });
    }) as typeof globalThis.fetch;

    const job = {
      id: "job_2",
      tenantId: tenant.id,
      dedupeKey: "dedupe-2",
      projectId: tenant.projectId,
      mergeRequestIid: 7,
      noteId: 56,
      headSha: "abc123",
      status: "queued" as const,
      payloadJson: JSON.stringify({
        ...payload,
        object_attributes: {
          ...payload.object_attributes,
          id: 56,
          note: "@review-bot what changed here?"
        }
      }),
      retryCount: 0,
      lastError: null,
      enqueuedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null
    };
    const completeInteractionRun = vi.fn(async () => {});
    const markJobCompleted = vi.fn(async () => {});

    const worker = new ReviewWorker({
      storage: {
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
          finishedAt: null
        })),
        getModelProfileByName: vi.fn(async () => null),
        getDefaultModelProfile: vi.fn(async () => null),
        getLatestCompletedInteractionForMergeRequest: vi.fn(async () => null),
        listPriorReviewFindings: vi.fn(async () => []),
        completeInteractionRun,
        replaceReviewFindings: vi.fn(async () => {}),
        markJobCompleted,
        failInteractionRun: vi.fn(async () => {}),
        markJobQueued: vi.fn(async () => {}),
        markJobFailed: vi.fn(async () => {})
      } as never,
      tenantRegistry: {
        getTenantById: vi.fn(async () => tenant)
      } as never,
      hydrator: {
        loadRoutingContext: vi.fn(async () => ({
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
          changes: [],
          notes: [],
          discussions: [],
          workspace: {
            rootPath: join("tmp", "workspace-routing"),
            cleanupRoot: join("tmp", "cleanup-routing"),
            strategy: "git",
            instructionFiles: []
          },
          projectMemory: {
            enabled: true,
            page: null,
            entries: []
          }
        })),
        hydrate: vi.fn(async () => {
          throw new Error("full hydration should be skipped");
        })
      } as never,
      workspaceMaterializer: {
        cleanup: vi.fn(async () => {})
      } as never,
      reviewProviderFactory: {
        createProvider: vi.fn(() => ({
          name: "copilot-sdk",
          review: vi.fn()
        }))
      },
      chatterRunnerFactory: {
        createRunner: vi.fn(() => ({
          run: vi.fn(async () => ({
            memory: {
              status: "skipped" as const,
              summary: "No durable memory detected."
            },
            replies: [
              {
                target: {
                  kind: "merge-request-note" as const,
                  noteId: 56
                },
                replyBody: "Here is what changed."
              }
            ]
          })),
          sessionPaths: {
            memory: ["copilot", "chatter", "memory"],
            reply: ["copilot", "chatter", "reply"]
          }
        }))
      } as never,
      reconciler: {
        reconcile: vi.fn()
      } as never,
      logger: createLogger("silent"),
      runLogDir: join("tmp", "run-logs"),
      maxJobRetries: 3,
      retryBackoffMs: 5000
    });

    await expect(worker.processJob("job_2")).resolves.toBeUndefined();

    expect(completeInteractionRun).toHaveBeenCalledWith("run_2", null);
    expect(markJobCompleted).toHaveBeenCalledTimes(1);

    globalThis.fetch = originalFetch;
  });

  it("publishes chatter replies into the existing discussion when the trigger note is threaded", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const requestUrl = String(input);
      if (init?.method === "GET") {
        return new Response("[]", {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
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
      }

      return new Response(
        JSON.stringify({
          id: 501,
          body: "Here is the explanation.",
          author: {
            id: 999,
            username: "review-bot",
            name: "Review Bot"
          },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          system: false
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

    const threadedPayload = {
      ...payload,
      object_attributes: {
        ...payload.object_attributes,
        id: 77,
        note: "@review-bot can you explain this change?"
      }
    };
    const job = {
      id: "job_3",
      tenantId: tenant.id,
      dedupeKey: "dedupe-3",
      projectId: tenant.projectId,
      mergeRequestIid: 7,
      noteId: 77,
      headSha: "abc123",
      status: "queued" as const,
      payloadJson: JSON.stringify(threadedPayload),
      retryCount: 0,
      lastError: null,
      enqueuedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null
    };

    const worker = new ReviewWorker({
      storage: {
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
          finishedAt: null
        })),
        getModelProfileByName: vi.fn(async () => null),
        getDefaultModelProfile: vi.fn(async () => null),
        getLatestCompletedInteractionForMergeRequest: vi.fn(async () => null),
        listPriorReviewFindings: vi.fn(async () => []),
        completeInteractionRun: vi.fn(async () => {}),
        replaceReviewFindings: vi.fn(async () => {}),
        markJobCompleted: vi.fn(async () => {}),
        failInteractionRun: vi.fn(async () => {}),
        markJobQueued: vi.fn(async () => {}),
        markJobFailed: vi.fn(async () => {})
      } as never,
      tenantRegistry: {
        getTenantById: vi.fn(async () => tenant)
      } as never,
      hydrator: {
        loadRoutingContext: vi.fn(async () => ({
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
                    name: "Dev User"
                  },
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  system: false
                }
              ]
            }
          ],
          workspace: {
            rootPath: join("tmp", "workspace-routing"),
            cleanupRoot: join("tmp", "cleanup-routing"),
            strategy: "git",
            instructionFiles: []
          },
          projectMemory: {
            enabled: true,
            page: null,
            entries: []
          }
        })),
        hydrate: vi.fn(async () => {
          throw new Error("full hydration should be skipped");
        })
      } as never,
      workspaceMaterializer: {
        cleanup: vi.fn(async () => {})
      } as never,
      reviewProviderFactory: {
        createProvider: vi.fn(() => ({
          name: "copilot-sdk",
          review: vi.fn()
        }))
      },
      chatterRunnerFactory: {
        createRunner: vi.fn(() => ({
          run: vi.fn(async () => ({
            memory: {
              status: "skipped" as const,
              summary: "No durable memory detected."
            },
            replies: [
              {
                target: {
                  kind: "discussion-reply" as const,
                  noteId: 77,
                  discussionId: "disc_individual"
                },
                replyBody: "Here is the explanation."
              }
            ]
          })),
          sessionPaths: {
            memory: ["copilot", "chatter", "memory"],
            reply: ["copilot", "chatter", "reply"]
          }
        }))
      } as never,
      reconciler: {
        reconcile: vi.fn()
      } as never,
      logger: createLogger("silent"),
      runLogDir: join("tmp", "run-logs"),
      maxJobRetries: 3,
      retryBackoffMs: 5000
    });

    await expect(worker.processJob("job_3")).resolves.toBeUndefined();

    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          init?.method === "POST" &&
          String(input).includes("/merge_requests/7/discussions/disc_individual/notes")
      )
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          init?.method === "POST" &&
          String(input).includes("/merge_requests/7/notes") &&
          !String(input).includes("/discussions/") &&
          !String(input).includes("/award_emoji")
      )
    ).toBe(false);

    globalThis.fetch = originalFetch;
  });
});
