import { describe, expect, it, vi } from "vitest";

import { ReviewWorker } from "../src/jobs/review-worker.js";
import { createLogger } from "../src/logger.js";
import type {
  IPlatform,
  PlatformTriggerLifecycle,
} from "../src/platforms/IPlatform.js";
import type { WebhookReviewTrigger } from "../src/review/types.js";
import { createClaimContext } from "./helpers/claim.js";

describe("ReviewWorker provider trigger lifecycle", () => {
  const duplicateWebhookCases: Array<{
    source: string;
    commentId: number | null;
    triggerJson: string;
    trigger: WebhookReviewTrigger;
  }> = [
    {
      source: "comment",
      commentId: 555,
      triggerJson: '{"kind":"github-comment"}',
      trigger: {
        kind: "direct-mention",
        comment: { kind: "code-review-comment", commentId: 555 },
      },
    },
    {
      source: "check run",
      commentId: null,
      triggerJson: JSON.stringify({
        kind: "github-check-run",
        deliveryId: "delivery-1",
        checkRunId: 1357,
        actionIdentifier: "run_review",
        repositoryId: 2468,
      }),
      trigger: {
        kind: "check-run-requested-action",
        checkRunId: 1357,
        actionIdentifier: "run_review",
      },
    },
  ];

  it.each(duplicateWebhookCases)(
    "reapplies the terminal lifecycle when a duplicate $source webhook finds a completed job",
    async ({ commentId, triggerJson, trigger }) => {
      const lifecycle: PlatformTriggerLifecycle = {
        queued: vi.fn(async () => {}),
        inProgress: vi.fn(async () => {}),
        completed: vi.fn(async () => {}),
        retry: vi.fn(async () => {}),
        failed: vi.fn(async () => {}),
      };
      const job = {
        id: "job-duplicate",
        tenantId: "tenant-github",
        dedupeKey: "dedupe-comment",
        codeReviewId: 42,
        commentId,
        triggerJson,
        headSha: "abc123",
        status: "completed" as const,
        payloadJson: "{}",
        retryCount: 0,
        lastError: null,
        enqueuedAt: "2026-06-11T00:00:00.000Z",
        availableAt: "2026-06-11T00:00:00.000Z",
        startedAt: "2026-06-11T00:00:01.000Z",
        finishedAt: "2026-06-11T00:01:00.000Z",
        claimToken: null,
        claimedBy: null,
        claimExpiresAt: null,
        latestInteractionRunId: "run-1",
      };
      const platform = {
        createInteractionJob: vi.fn(async () => ({
          dedupeKey: job.dedupeKey,
          codeReviewId: job.codeReviewId,
          commentId: job.commentId,
          triggerJson: job.triggerJson,
          headSha: job.headSha,
          payloadJson: job.payloadJson,
        })),
        createTriggerLifecycle: vi.fn(() => lifecycle),
      } as unknown as IPlatform;
      const worker = new ReviewWorker({
        storage: {
          createOrGetInteractionJob: vi.fn(async () => ({
            job,
            created: false,
          })),
        } as never,
        tenantRegistry: {} as never,
        reviewProviderFactory: {} as never,
        chatterRunnerFactory: {} as never,
        reconciler: {} as never,
        logger: createLogger("silent"),
        runLogDir: "tmp/test-trigger-lifecycle",
        maxJobRetries: 3,
        retryBackoffMs: 1000,
        platformResolver: () => platform,
      });

      await worker.createInteractionJobFromWebhook(
        {},
        {
          tenant: { id: job.tenantId, platform: "github" } as never,
          connection: { id: "connection-github" } as never,
        },
        trigger,
      );

      expect(lifecycle.completed).toHaveBeenCalledTimes(1);
      expect(lifecycle.queued).not.toHaveBeenCalled();
    },
  );

  it("processes commentless jobs and keeps lifecycle failures out of job retry logic", async () => {
    const lifecycle: PlatformTriggerLifecycle = {
      queued: vi.fn(async () => {}),
      inProgress: vi.fn(async () => {
        throw new Error("status API unavailable");
      }),
      completed: vi.fn(async () => {}),
      retry: vi.fn(async () => {}),
      failed: vi.fn(async () => {}),
    };
    const loadRoutingContext = vi.fn(async () => {
      throw new Error("runtime boundary reached");
    });
    const job = {
      id: "job-github",
      tenantId: "tenant-github",
      dedupeKey: "dedupe",
      codeReviewId: 42,
      commentId: null,
      triggerJson: JSON.stringify({
        kind: "github-check-run",
        deliveryId: "delivery-1",
        checkRunId: 1357,
        actionIdentifier: "run_review",
        repositoryId: 2468,
      }),
      headSha: "abc123",
      status: "queued" as const,
      payloadJson: "{}",
      retryCount: 0,
      lastError: null,
      enqueuedAt: "2026-06-11T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
    };
    const tenant = {
      id: "tenant-github",
      key: "https://api.github.com::2468",
      platform: "github",
      platformConnectionId: "connection-github",
      platformConfigJson: JSON.stringify({
        repositoryId: 2468,
        repositoryFullName: "octo-org/reviewphin",
      }),
      modelProfileName: null,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
    };
    const connection = {
      id: "connection-github",
      name: "github-main",
      platform: "github",
      status: "ready" as const,
      platformConnectionConfigJson: "{}",
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
    };
    const transitionClaim = vi.fn(async () => true);
    const platform = {
      createTriggerLifecycle: vi.fn(() => lifecycle),
    } as unknown as IPlatform;
    const worker = new ReviewWorker({
      storage: {
        stores: {
          interactionJobs: {
            get: vi.fn(async () => job),
            transitionClaim,
          },
        },
      } as never,
      tenantRegistry: {
        getResolvedTenantById: vi.fn(async () => ({ tenant, connection })),
      } as never,
      reviewProviderFactory: {} as never,
      chatterRunnerFactory: {} as never,
      reconciler: {} as never,
      logger: createLogger("silent"),
      runLogDir: "tmp/test-trigger-lifecycle",
      maxJobRetries: 0,
      retryBackoffMs: 1000,
      platformResolver: () => platform,
      reviewRuntimeFactory: () =>
        ({
          loadRoutingContext,
        }) as never,
    });

    const context = createClaimContext(job.id);
    await expect(
      worker.processClaimedJob(job as never, context),
    ).resolves.toBeUndefined();
    expect(loadRoutingContext).toHaveBeenCalledWith(job);
    expect(lifecycle.inProgress).toHaveBeenCalledTimes(1);
    expect(transitionClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: job.id,
        status: "failed",
        retryCount: 1,
        lastError: "runtime boundary reached",
      }),
    );
    expect(lifecycle.failed).toHaveBeenCalledWith("runtime boundary reached");
  });

  it("does not publish the failure lifecycle or transition the job after the lease is lost", async () => {
    const lifecycle: PlatformTriggerLifecycle = {
      queued: vi.fn(async () => {}),
      inProgress: vi.fn(async () => {}),
      completed: vi.fn(async () => {}),
      retry: vi.fn(async () => {}),
      failed: vi.fn(async () => {}),
    };
    const context = createClaimContext("job-lease-lost");
    // Simulate lease loss mid-processing: the claim is fenced before the failure
    // path reaches the terminal lifecycle and job transition.
    const loadRoutingContext = vi.fn(async () => {
      context.controller.abort();
      throw new Error("runtime boundary reached");
    });
    const job = {
      id: "job-lease-lost",
      tenantId: "tenant-github",
      dedupeKey: "dedupe",
      codeReviewId: 42,
      commentId: null,
      triggerJson: JSON.stringify({
        kind: "github-check-run",
        deliveryId: "delivery-2",
        checkRunId: 1357,
        actionIdentifier: "run_review",
        repositoryId: 2468,
      }),
      headSha: "abc123",
      status: "queued" as const,
      payloadJson: "{}",
      retryCount: 0,
      lastError: null,
      enqueuedAt: "2026-06-11T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
    };
    const tenant = {
      id: "tenant-github",
      key: "https://api.github.com::2468",
      platform: "github",
      platformConnectionId: "connection-github",
      platformConfigJson: JSON.stringify({
        repositoryId: 2468,
        repositoryFullName: "octo-org/reviewphin",
      }),
      modelProfileName: null,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
    };
    const connection = {
      id: "connection-github",
      name: "github-main",
      platform: "github",
      status: "ready" as const,
      platformConnectionConfigJson: "{}",
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
    };
    const transitionClaim = vi.fn(async () => true);
    const platform = {
      createTriggerLifecycle: vi.fn(() => lifecycle),
    } as unknown as IPlatform;
    const worker = new ReviewWorker({
      storage: {
        stores: {
          interactionJobs: {
            get: vi.fn(async () => job),
            transitionClaim,
          },
        },
      } as never,
      tenantRegistry: {
        getResolvedTenantById: vi.fn(async () => ({ tenant, connection })),
      } as never,
      reviewProviderFactory: {} as never,
      chatterRunnerFactory: {} as never,
      reconciler: {} as never,
      logger: createLogger("silent"),
      runLogDir: "tmp/test-trigger-lifecycle",
      maxJobRetries: 3,
      retryBackoffMs: 1000,
      platformResolver: () => platform,
      reviewRuntimeFactory: () =>
        ({
          loadRoutingContext,
        }) as never,
    });

    await expect(
      worker.processClaimedJob(job as never, context),
    ).resolves.toBeUndefined();
    expect(lifecycle.inProgress).toHaveBeenCalledTimes(1);
    // The lease was lost, so neither the terminal lifecycle nor the job
    // transition may run.
    expect(lifecycle.failed).not.toHaveBeenCalled();
    expect(lifecycle.retry).not.toHaveBeenCalled();
    expect(transitionClaim).not.toHaveBeenCalled();
  });

  it("does not overwrite lifecycle state owned by a replacement claim", async () => {
    const lifecycle: PlatformTriggerLifecycle = {
      queued: vi.fn(async () => {}),
      inProgress: vi.fn(async () => {}),
      completed: vi.fn(async () => {}),
      retry: vi.fn(async () => {}),
      failed: vi.fn(async () => {}),
    };
    const job = {
      id: "job-reclaimed",
      tenantId: "tenant-github",
      status: "in_progress",
      claimToken: "replacement-claim",
      lastError: "Previous attempt lost its lease.",
    };
    const tenant = {
      id: "tenant-github",
      platform: "github",
    };
    const connection = {
      id: "connection-github",
    };
    const platform = {
      createTriggerLifecycle: vi.fn(() => lifecycle),
    } as unknown as IPlatform;
    const worker = new ReviewWorker({
      storage: {
        stores: {
          interactionJobs: {
            get: vi.fn(async () => job),
          },
        },
      } as never,
      tenantRegistry: {
        getResolvedTenantById: vi.fn(async () => ({ tenant, connection })),
      } as never,
      reviewProviderFactory: {} as never,
      chatterRunnerFactory: {} as never,
      reconciler: {} as never,
      logger: createLogger("silent"),
      runLogDir: "tmp/test-trigger-lifecycle",
      maxJobRetries: 3,
      retryBackoffMs: 1000,
      platformResolver: () => platform,
    });

    await worker.reconcileOrphanLifecycle({
      id: "run-stale",
      interactionJobId: job.id,
      interactionJobClaimToken: "stale-claim",
    } as never);

    expect(lifecycle.retry).not.toHaveBeenCalled();
    expect(lifecycle.failed).not.toHaveBeenCalled();
  });
});
