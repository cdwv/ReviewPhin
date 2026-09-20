import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewWorker } from "../src/jobs/review-worker.js";
import { createLogger } from "../src/logger.js";
import type {
  IPlatform,
  PlatformReviewRoutingContext,
  PlatformReviewRuntime,
} from "../src/platforms/IPlatform.js";
import { buildScopedReviewContext } from "../src/review/review-scope.js";
import type { ChatterRunContext } from "../src/review/harness-chatter.js";
import type {
  ChatterBatchResult,
  ReviewResult,
  ReviewContext,
} from "../src/review/types.js";
import { listAll } from "../src/storage/storage-helpers.js";
import { openSqliteTestStorage, type TestStorage } from "./helpers/storage.js";
import {
  createGitLabConnectionRecord,
  createGitLabTenantInput,
} from "./helpers/gitlab-tenant.js";
import { createClaimContext } from "./helpers/claim.js";
import { batchRequest } from "./helpers/batch-request.js";
import { batchCheckpointSchema } from "../src/review/batch-checkpoint.js";
import type { RoutingInput } from "../src/review/interaction-router.js";

const cleanup: Array<{ root: string; storage: TestStorage }> = [];
afterEach(async () => {
  for (const { root, storage } of cleanup.splice(0)) {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
const reviewResult: ReviewResult = {
  overview: {
    summary: "Reviewed the collected requests",
    overallSeverity: "low",
    overallAssessment: "No issues found",
    mergeReadiness: { status: "ready", confidence: "high", summary: "Ready" },
  },
  findings: [],
  priorDispositions: [],
};

async function setup(
  options: {
    review?: boolean;
    reviewScope?: "incremental" | "full";
    previousReview?: boolean;
    memory?: boolean;
    failReplyOnce?: boolean;
    missingAnswer?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "reviewphin-batch-worker-"));
  let now = "2026-09-19T10:00:00.000Z";
  const storage = await openSqliteTestStorage(join(root, "db.sqlite"), {
    now: () => now,
  });
  cleanup.push({ root, storage });
  const tenant = await storage.upsertTenant(createGitLabTenantInput());
  if (options.previousReview) {
    vi.spyOn(
      storage,
      "getLatestCompletedInteractionForCodeReview",
    ).mockResolvedValue({
      interactionRunId: "previous-run",
      interactionJobId: "previous-job",
      finishedAt: "2026-09-18T10:00:00.000Z",
      headSha: "previous-head",
      resultJson: JSON.stringify(reviewResult),
      snapshot: { changesJson: "[]" },
    } as never);
  }
  const events: string[] = [];
  const lifecycle = {
    queued: vi.fn(async () => {}),
    inProgress: vi.fn(async () => {}),
    completed: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    failed: vi.fn(async () => {}),
  };
  const platform = {
    createTriggerLifecycle: () => lifecycle,
    buildHarnessTenantContext: () => ({
      id: tenant.id,
      memoryEnabled: true,
      projectMemoryBackend: {},
    }),
    getPlatformInfo: () => ({ slug: "gitlab" }),
  } as unknown as IPlatform;
  const base: PlatformReviewRoutingContext = {
    codeReviewId: 7,
    summaryContext: {
      codeReview: {
        id: 7,
        title: "Feature",
        description: "",
        webUrl: "https://example.test/pr/7",
        sourceBranch: "feature",
        targetBranch: "main",
        authorUsername: "dev",
      },
      changes: [],
    },
    workspace: {
      rootPath: join(root, "checkout"),
      cleanupRoot: root,
      strategy: "test",
    },
    projectMemory: { enabled: true, page: null, entries: [] },
    changedFileCount: 0,
    commentCount: 2,
    discussionCount: 0,
    platformContext: {},
  };
  const published: number[] = [];
  let failed = false;
  const runtime: PlatformReviewRuntime = {
    getCurrentHead: vi.fn(async () => "head-current"),
    loadRoutingContext: vi.fn(async (job) => {
      events.push("checkout");
      expect(job.headSha).toBe("head-current");
      return base;
    }),
    refreshProjectMemory: vi.fn(async (_job, context) => {
      events.push("refresh-memory");
      return context;
    }),
    hydrate: vi.fn(async () => {
      events.push("snapshot");
      return base;
    }),
    buildProviderDiscussions: () => [],
    buildReviewTriggerContext: ({ payload }) =>
      (payload as ReturnType<typeof batchRequest>).trigger,
    locateTriggerCommentReference: ({ commentId }) => ({
      kind: "code-review-comment",
      commentId,
    }),
    resolveTriggerCommentReference: async ({ commentId }) => ({
      kind: "code-review-comment",
      commentId,
    }),
    buildPromptContext: (input) =>
      buildScopedReviewContext({
        ...base.summaryContext,
        changes: [],
        comments: [],
        discussions: [],
        workspacePath: base.workspace.rootPath,
        projectMemory: input.context.projectMemory,
        trigger: input.trigger,
        requests: input.requests,
        reviewScope: input.reviewScope,
        priorDiscussions: [],
        previousReview: input.previousInteraction
          ? {
              reviewRunId: input.previousInteraction.interactionRunId,
              finishedAt: input.previousInteraction.finishedAt,
              headSha: input.previousInteraction.headSha,
              resultJson: input.previousInteraction.resultJson,
              changesJson: input.previousInteraction.snapshot.changesJson,
            }
          : null,
      }),
    syncDiscussionFindingStatuses: async () => [],
    createReviewPublicationAdapter: () => ({}) as never,
    materializeAttachments: async () => ({
      attachments: [],
      breadcrumbs: [],
      issues: [],
    }),
    publishChatterReplies: vi.fn(
      async (
        input: Parameters<PlatformReviewRuntime["publishChatterReplies"]>[0],
      ) => {
        const reply = input.result.replies[0]!;
        const target = input.plannedTargets.find(
          (t) => t.commentId === reply.target.commentId,
        )!;
        if (options.failReplyOnce && target.commentId === 2 && !failed) {
          failed = true;
          events.push("reply-2-failed");
          return [
            { target, status: "failed" as const, error: "simulated outage" },
          ];
        }
        events.push(`reply-${target.commentId}`);
        published.push(target.commentId);
        return [
          {
            target,
            status: "published" as const,
            commentId: 100 + target.commentId,
          },
        ];
      },
    ),
    buildTriggerOutcome: () => undefined,
    cleanupWorkspace: vi.fn(async () => {
      events.push("cleanup");
    }),
  };
  const route = vi.fn(async (input: RoutingInput) => {
    events.push("route");
    return {
      source: "model" as const,
      decisions: input.requests.map((r) => ({
        requestId: r.id,
        review:
          options.review === false
            ? ("none" as const)
            : (options.reviewScope ?? ("incremental" as const)),
        memory: options.memory ?? true,
        reply: true,
        reason: "fixture decision",
      })),
    };
  });
  const review = vi.fn(async (_context: ReviewContext) => {
    events.push("review");
    return reviewResult;
  });
  const chatterRun = vi.fn(
    async (input: ChatterRunContext): Promise<ChatterBatchResult> => {
      expect(input.reviewContext?.workspacePath).toBe(base.workspace.rootPath);
      events.push(input.phase);
      if (input.phase === "memory")
        return {
          memory: { status: "written", summary: "Updated" },
          replies: [],
        };
      const requests = options.missingAnswer
        ? input.requests!.slice(0, 1)
        : input.requests!;
      return {
        memory: null,
        replies: requests.map((r) => ({
          target: r.trigger.responseTarget,
          replyBody: `Answer to ${r.trigger.commentId}`,
          coveredRequestIds: [r.id],
        })),
      };
    },
  );
  const reconcile = vi.fn(async () => {
    events.push("publish-review");
    return {
      created: 0,
      updated: 0,
      resolved: 0,
      replied: 0,
      skipped: 0,
      links: [],
    };
  });
  const worker = new ReviewWorker({
    storage,
    tenantRegistry: {
      getResolvedTenantById: async () => ({
        tenant,
        connection: createGitLabConnectionRecord(),
      }),
    } as never,
    reviewProviderFactory: {
      createProvider: () => ({ name: "fixture", review }),
    },
    chatterRunnerFactory: {
      createRunner: () => ({ run: chatterRun }),
    } as never,
    interactionRouter: { route },
    reconciler: { reconcile } as never,
    logger: createLogger("silent"),
    runLogDir: join(root, "logs"),
    maxJobRetries: 3,
    retryBackoffMs: 0,
    platformResolver: () => platform,
    reviewRuntimeFactory: () => runtime,
  });
  const admissions = [];
  for (const id of [1, 2]) {
    admissions.push(
      await storage.stores.interactionJobs.admitInteractionTrigger({
        request: {
          tenantId: tenant.id,
          codeReviewId: 7,
          commentId: id,
          dedupeKey: `comment-${id}`,
          triggerJson: JSON.stringify({ kind: "direct-mention" }),
          payloadJson: JSON.stringify(
            batchRequest(id, `Please review and answer question ${id}?`),
          ),
          headSha: "head-webhook",
        },
        now: new Date(Date.parse(now) + id).toISOString(),
        debounceMs: 15000,
      }),
    );
  }
  const jobId = admissions[0]!.job.id;
  const process = async (attempt: number) => {
    now = new Date(Date.now() + attempt * 10000).toISOString();
    const job = await storage.stores.interactionJobs.claimNext({
      now,
      queuedAfter: "2020-01-01T00:00:00.000Z",
      workerId: "worker",
      claimToken: `claim-${attempt}`,
      claimExpiresAt: new Date(Date.now() + 3600000).toISOString(),
      maxJobRetries: 3,
    });
    expect(job?.id).toBe(jobId);
    await worker.processClaimedJob(
      job!,
      createClaimContext(jobId, `claim-${attempt}`),
    );
    return storage.stores.interactionJobs.get(jobId);
  };
  return {
    storage,
    worker,
    jobId,
    events,
    published,
    route,
    review,
    chatterRun,
    reconcile,
    runtime,
    lifecycle,
    process,
  };
}

describe("collected request execution with real SQLite", () => {
  it.each([
    ["incremental", false, "first-pass-full"],
    ["incremental", true, "incremental-rereview"],
    ["full", true, "first-pass-full"],
  ] as const)(
    "delivers routed %s scope to the reviewer (history: %s)",
    async (reviewScope, previousReview, mode) => {
      const test = await setup({ reviewScope, previousReview });
      expect((await test.process(1))?.status).toBe("completed");
      expect(test.review).toHaveBeenCalledTimes(1);
      expect(test.review.mock.calls[0]?.[0].scope.mode).toBe(mode);
      expect(test.route.mock.calls[0]?.[0].previousReviewExists).toBe(
        previousReview,
      );
    },
  );
  it("retries failed model classification without running review, memory, or replies", async () => {
    const test = await setup();
    test.route.mockRejectedValueOnce(new Error("Routing models unavailable"));
    const job = await test.process(1);
    expect(job?.status).toBe("queued");
    expect(job?.lastError).toContain("Routing models unavailable");
    expect(test.review).not.toHaveBeenCalled();
    expect(test.chatterRun).not.toHaveBeenCalled();
    expect(test.reconcile).not.toHaveBeenCalled();
    expect(test.published).toEqual([]);
    expect((await test.process(2))?.status).toBe("completed");
    expect(test.route).toHaveBeenCalledTimes(2);
  });

  it("runs one checkout, one memory phase, one review, and answers both comments", async () => {
    const test = await setup();
    expect((await test.process(1))?.status).toBe("completed");
    expect(test.events).toEqual([
      "checkout",
      "route",
      "memory",
      "refresh-memory",
      "snapshot",
      "review",
      "publish-review",
      "reply",
      "reply-1",
      "reply-2",
      "cleanup",
    ]);
    expect(test.route).toHaveBeenCalledTimes(1);
    expect(test.review).toHaveBeenCalledTimes(1);
    expect(test.lifecycle.inProgress).toHaveBeenCalledTimes(2);
    expect(test.lifecycle.completed).toHaveBeenCalledTimes(2);
    expect(test.published).toEqual([1, 2]);
    const runs = await listAll(test.storage.stores.interactionRuns);
    expect(runs).toHaveLength(1);
    expect(JSON.parse(runs[0]!.repliesJson!).publishedReplyKeys).toHaveLength(
      2,
    );
    expect(JSON.parse(runs[0]!.resultJson!).overview.summary).toBe(
      reviewResult.overview.summary,
    );
  });

  it("still prepares one checkout for a reply-only batch", async () => {
    const test = await setup({ review: false, memory: false });
    expect((await test.process(1))?.status).toBe("completed");
    expect(test.runtime.loadRoutingContext).toHaveBeenCalledTimes(1);
    expect(test.runtime.hydrate).not.toHaveBeenCalled();
    expect(test.review).not.toHaveBeenCalled();
    expect(test.published).toEqual([1, 2]);
  });

  it.each([1, 2])(
    "resumes checkpoint v%s without repeating completed work",
    async (version) => {
      const test = await setup({ failReplyOnce: true });
      expect((await test.process(1))?.status).toBe("queued");
      expect(test.published).toEqual([1]);
      const [failedRun] = await listAll(test.storage.stores.interactionRuns);
      if (version === 1) {
        const checkpoint = batchCheckpointSchema.parse(
          JSON.parse(failedRun!.repliesJson!),
        );
        await test.storage.stores.interactionRuns.replace({
          ...failedRun!,
          repliesJson: JSON.stringify({
            ...checkpoint,
            version: 1,
            routing: {
              ...checkpoint.routing,
              decisions: checkpoint.routing.decisions.map((d) => ({
                ...d,
                review: d.review !== "none",
              })),
            },
          }),
        });
      }
      expect((await test.process(2))?.status).toBe("completed");
      expect(test.published).toEqual([1, 2]);
      expect(test.route).toHaveBeenCalledTimes(1);
      expect(test.review).toHaveBeenCalledTimes(1);
      expect(test.reconcile).toHaveBeenCalledTimes(1);
      expect(test.chatterRun).toHaveBeenCalledTimes(2);
      expect(test.runtime.loadRoutingContext).toHaveBeenCalledTimes(2);
      const runs = await listAll(test.storage.stores.interactionRuns);
      expect(runs.map((r) => r.status).sort()).toEqual(["completed", "failed"]);
      expect(
        JSON.parse(runs.find((r) => r.status === "completed")!.repliesJson!)
          .version,
      ).toBe(2);
    },
  );

  it("rejects incomplete answer coverage before publishing any reply", async () => {
    const test = await setup({
      review: false,
      memory: false,
      missingAnswer: true,
    });
    const job = await test.process(1);
    expect(job?.status).toBe("queued");
    expect(job?.lastError).toContain("every planned request");
    expect(test.published).toEqual([]);
    expect(test.lifecycle.completed).not.toHaveBeenCalled();
  });

  it("does not publish stale review output after the branch moves", async () => {
    const test = await setup();
    vi.mocked(test.runtime.getCurrentHead!)
      .mockResolvedValueOnce("head-current")
      .mockResolvedValue("head-newer");
    const job = await test.process(1);
    expect(job?.status).toBe("queued");
    expect(job?.lastError).toContain("head changed");
    expect(test.reconcile).not.toHaveBeenCalled();
    expect(test.published).toEqual([]);
  });
});
