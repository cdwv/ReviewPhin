import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StorageBackedJobRunner } from "../src/jobs/storage-backed-job-runner.js";
import { createLogger } from "../src/logger.js";
import type { InteractionJobRecord } from "../src/storage/contract/index.js";
import { openSqliteTestStorage, type TestStorage } from "./helpers/storage.js";
import { createGitLabTenantInput } from "./helpers/gitlab-tenant.js";

const logger = createLogger("silent");

async function databaseFile(): Promise<string> {
  return join(
    await mkdtemp(join(tmpdir(), "reviewphin-runner-")),
    "storage.sqlite",
  );
}

function makeJob(
  tenantId: string,
  overrides: Partial<InteractionJobRecord> & { id: string; dedupeKey: string },
): InteractionJobRecord {
  const now = new Date().toISOString();
  return {
    tenantId,
    codeReviewId: 7,
    commentId: 1,
    triggerJson: '{"kind":"comment","commentId":1}',
    headSha: "abc123",
    status: "queued",
    payloadJson: "{}",
    retryCount: 0,
    lastError: null,
    enqueuedAt: now,
    availableAt: now,
    startedAt: null,
    finishedAt: null,
    claimToken: null,
    claimedBy: null,
    claimExpiresAt: null,
    latestInteractionRunId: null,
    ...overrides,
  };
}

function makeRun(
  storage: TestStorage,
  jobId: string,
  tenantId: string,
  claimToken: string,
) {
  return {
    interactionJobId: jobId,
    tenantId,
    provider: "copilot-sdk",
    model: null,
    modelProfileName: null,
    providerBaseUrl: null,
    providerType: null,
    textGenerationModel: null,
    interactionJobClaimToken: claimToken,
    reviewReasoningEffort: null,
    textGenerationReasoningEffort: null,
  };
}

interface RunnerHarness {
  storage: TestStorage;
  tenantId: string;
}

describe("StorageBackedJobRunner (sqlite)", () => {
  let harness: RunnerHarness;

  beforeEach(async () => {
    const storage = await openSqliteTestStorage(await databaseFile());
    const tenant = await storage.upsertTenant(createGitLabTenantInput());
    harness = { storage, tenantId: tenant.id };
  });

  afterEach(async () => {
    await harness.storage.close();
  });

  function completingWorker(processed: InteractionJobRecord[]) {
    return {
      processClaimedJob: vi.fn(
        async (job: InteractionJobRecord, context) => {
          processed.push(job);
          await harness.storage.stores.interactionJobs.transitionClaim({
            jobId: context.jobId,
            claimToken: context.claimToken,
            status: "completed",
            retryCount: job.retryCount,
            lastError: null,
            availableAt: job.availableAt,
            finishedAt: new Date().toISOString(),
          });
        },
      ),
      reconcileOrphanLifecycle: vi.fn(async () => {}),
      reconcileTriggerLifecycle: vi.fn(async () => {}),
    };
  }

  function createRunner(worker: unknown, overrides?: Record<string, number>) {
    return new StorageBackedJobRunner({
      storage: harness.storage,
      worker: worker as never,
      logger,
      pollIntervalMs: 2_000,
      maxQueuedJobAgeMs: 21_600_000,
      leaseMs: 120_000,
      maxJobRetries: 3,
      workerId: "worker-fixed",
      ...overrides,
    });
  }

  it("discovers a newly persisted job, claims and processes it", async () => {
    await harness.storage.stores.interactionJobs.upsert(
      makeJob(harness.tenantId, { id: "job-a", dedupeKey: "a" }),
    );
    const processed: InteractionJobRecord[] = [];
    const runner = createRunner(completingWorker(processed));

    await runner.runOnce();

    expect(processed.map((job) => job.id)).toEqual(["job-a"]);
    const job = await harness.storage.stores.interactionJobs.get("job-a");
    expect(job?.status).toBe("completed");
  });

  it("does not claim a job whose availableAt is in the future", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    await harness.storage.stores.interactionJobs.upsert(
      makeJob(harness.tenantId, {
        id: "job-future",
        dedupeKey: "future",
        availableAt: future,
      }),
    );
    const processed: InteractionJobRecord[] = [];
    const runner = createRunner(completingWorker(processed));

    await runner.runOnce();

    expect(processed).toHaveLength(0);
    const job = await harness.storage.stores.interactionJobs.get("job-future");
    expect(job?.status).toBe("queued");
  });

  it("expires stale queued jobs by original enqueue time without processing", async () => {
    const old = "2020-01-01T00:00:00.000Z";
    await harness.storage.stores.interactionJobs.upsert(
      makeJob(harness.tenantId, {
        id: "job-old",
        dedupeKey: "old",
        enqueuedAt: old,
        availableAt: old,
      }),
    );
    const processed: InteractionJobRecord[] = [];
    const worker = completingWorker(processed);
    const runner = createRunner(worker);

    await runner.runOnce();

    expect(processed).toHaveLength(0);
    const job = await harness.storage.stores.interactionJobs.get("job-old");
    expect(job?.status).toBe("expired");
    expect(job?.lastError).toContain("maximum age");
    expect(worker.reconcileTriggerLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-old", status: "expired" }),
    );
  });

  it("reconciles orphaned runs even when no new job can be claimed", async () => {
    await harness.storage.stores.interactionJobs.upsert(
      makeJob(harness.tenantId, { id: "job-orphan", dedupeKey: "orphan" }),
    );
    const claimed = await harness.storage.stores.interactionJobs.claimNext({
      workerId: "worker-a",
      claimToken: "token-a",
      now: new Date().toISOString(),
      claimExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      queuedAfter: "2020-01-01T00:00:00.000Z",
      maxJobRetries: 3,
    });
    expect(claimed?.id).toBe("job-orphan");
    const run =
      await harness.storage.stores.interactionJobs.createInteractionRunForClaim(
        {
          jobId: "job-orphan",
          claimToken: "token-a",
          run: makeRun(harness.storage, "job-orphan", harness.tenantId, "token-a"),
        },
      );
    expect(run).not.toBeNull();
    // Terminate the job under its own token, leaving the run orphaned.
    await harness.storage.stores.interactionJobs.transitionClaim({
      jobId: "job-orphan",
      claimToken: "token-a",
      status: "failed",
      retryCount: 1,
      lastError: "boom",
      availableAt: claimed!.availableAt,
      finishedAt: new Date().toISOString(),
    });

    const processed: InteractionJobRecord[] = [];
    const worker = completingWorker(processed);
    const runner = createRunner(worker);

    await runner.runOnce();

    expect(processed).toHaveLength(0);
    expect(worker.reconcileOrphanLifecycle).toHaveBeenCalledTimes(1);
    const reconciledRun = await harness.storage.stores.interactionRuns.get(
      run!.id,
    );
    expect(reconciledRun?.status).toBe("failed");
  });

  it("respects a persisted retry availableAt instead of an in-memory timer", async () => {
    await harness.storage.stores.interactionJobs.upsert(
      makeJob(harness.tenantId, { id: "job-retry", dedupeKey: "retry" }),
    );
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const retryingWorker = {
      processClaimedJob: vi.fn(
        async (job: InteractionJobRecord, context) => {
          await harness.storage.stores.interactionJobs.transitionClaim({
            jobId: context.jobId,
            claimToken: context.claimToken,
            status: "queued",
            retryCount: job.retryCount + 1,
            lastError: "retry me",
            availableAt: future,
            finishedAt: null,
          });
        },
      ),
      reconcileOrphanLifecycle: vi.fn(async () => {}),
    };
    const runner = createRunner(retryingWorker);

    await runner.runOnce();
    expect(retryingWorker.processClaimedJob).toHaveBeenCalledTimes(1);
    const afterRetry =
      await harness.storage.stores.interactionJobs.get("job-retry");
    expect(afterRetry?.status).toBe("queued");
    expect(afterRetry?.availableAt).toBe(future);
    expect(afterRetry?.retryCount).toBe(1);

    // A second tick at "now" must not reclaim the future-scheduled job.
    await runner.runOnce();
    expect(retryingWorker.processClaimedJob).toHaveBeenCalledTimes(1);
  });
});

describe("StorageBackedJobRunner heartbeat and lifecycle", () => {
  function fakeStore(overrides: Record<string, unknown>) {
    return {
      expireQueued: vi.fn(async () => 0),
      claimNext: vi.fn(async () => null),
      reconcileOrphanedInteractionRuns: vi.fn(async () => []),
      renewClaim: vi.fn(async () => true),
      transitionClaim: vi.fn(async () => true),
      ...overrides,
    };
  }

  it("reconciles orphaned runs before claiming so a claim starts with no maintenance gap", async () => {
    const job = { id: "job-order", retryCount: 0, availableAt: "x" };
    const reconcileOrphanedInteractionRuns = vi.fn(async () => []);
    const claimNext = vi
      .fn()
      .mockResolvedValueOnce(job)
      .mockResolvedValue(null);
    const store = fakeStore({ reconcileOrphanedInteractionRuns, claimNext });
    const processClaimedJob = vi.fn(async () => {});
    const worker = {
      processClaimedJob,
      reconcileOrphanLifecycle: vi.fn(),
    };
    const runner = new StorageBackedJobRunner({
      storage: { stores: { interactionJobs: store } } as never,
      worker: worker as never,
      logger,
      pollIntervalMs: 2_000,
      maxQueuedJobAgeMs: 21_600_000,
      leaseMs: 120_000,
      maxJobRetries: 3,
    });

    await runner.runOnce();

    expect(reconcileOrphanedInteractionRuns).toHaveBeenCalledTimes(1);
    expect(claimNext).toHaveBeenCalledTimes(1);
    expect(
      reconcileOrphanedInteractionRuns.mock.invocationCallOrder[0] ?? 0,
    ).toBeLessThan(claimNext.mock.invocationCallOrder[0] ?? 0);
    expect(processClaimedJob).toHaveBeenCalledTimes(1);
  });

  it("does not delay job claiming while expired trigger feedback is pending", async () => {
    const expiredJob = { id: "job-expired", status: "expired" };
    const claimNext = vi.fn(async () => null);
    const store = fakeStore({
      expireQueued: vi.fn(async () => 1),
      list: vi.fn(async () => [expiredJob]),
      claimNext,
    });
    const worker = {
      processClaimedJob: vi.fn(),
      reconcileOrphanLifecycle: vi.fn(),
      reconcileTriggerLifecycle: vi.fn(
        () => new Promise<void>(() => {}),
      ),
    };
    const runner = new StorageBackedJobRunner({
      storage: { stores: { interactionJobs: store } } as never,
      worker: worker as never,
      logger,
      pollIntervalMs: 2_000,
      maxQueuedJobAgeMs: 21_600_000,
      leaseMs: 120_000,
      maxJobRetries: 3,
    });

    await runner.runOnce();

    expect(worker.reconcileTriggerLifecycle).toHaveBeenCalledWith(expiredJob);
    expect(claimNext).toHaveBeenCalledTimes(1);
  });

  it("bounds shutdown while expired trigger feedback is pending", async () => {
    vi.useFakeTimers();
    try {
      const expiredJob = { id: "job-expired", status: "expired" };
      const store = fakeStore({
        expireQueued: vi.fn(async () => 1),
        list: vi.fn(async () => [expiredJob]),
      });
      const worker = {
        processClaimedJob: vi.fn(),
        reconcileOrphanLifecycle: vi.fn(),
        reconcileTriggerLifecycle: vi.fn(
          () => new Promise<void>(() => {}),
        ),
      };
      const runner = new StorageBackedJobRunner({
        storage: { stores: { interactionJobs: store } } as never,
        worker: worker as never,
        logger,
        pollIntervalMs: 2_000,
        maxQueuedJobAgeMs: 21_600_000,
        leaseMs: 120_000,
        maxJobRetries: 3,
        triggerLifecycleShutdownGraceMs: 50,
      });

      await runner.runOnce();
      const stopPromise = runner.stop();
      await vi.advanceTimersByTimeAsync(49);
      let stopped = false;
      void stopPromise.then(() => {
        stopped = true;
      });
      expect(stopped).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await stopPromise;
      expect(stopped).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a hung renewal at the local lease deadline without overlapping renewals", async () => {
    vi.useFakeTimers();
    try {
      const job = { id: "job-hung", retryCount: 0, availableAt: "x" };
      let capturedAborted: boolean | null = null;
      const renewClaim = vi.fn(
        () => new Promise<boolean>(() => {}),
      );
      const store = fakeStore({
        claimNext: vi.fn().mockResolvedValueOnce(job).mockResolvedValue(null),
        renewClaim,
      });
      const worker = {
        processClaimedJob: vi.fn(
          (_job: unknown, context: { signal: AbortSignal }) =>
            new Promise<void>((resolve) => {
              context.signal.addEventListener("abort", () => {
                capturedAborted = context.signal.aborted;
                resolve();
              });
            }),
        ),
        reconcileOrphanLifecycle: vi.fn(),
      };
      const runner = new StorageBackedJobRunner({
        storage: { stores: { interactionJobs: store } } as never,
        worker: worker as never,
        logger,
        pollIntervalMs: 2_000,
        maxQueuedJobAgeMs: 21_600_000,
        leaseMs: 3_000,
        maxJobRetries: 3,
      });

      const tick = runner.runOnce();
      // First beat fires a renewal that never settles.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(renewClaim).toHaveBeenCalledTimes(1);
      // Reaching the local lease deadline must abort the claim even though the
      // renewal is still in flight.
      await vi.advanceTimersByTimeAsync(2_000);
      await tick;
      expect(capturedAborted).toBe(true);
      // A serialized loop never issues a second (overlapping) renewal.
      expect(renewClaim).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not revive a lease when renewal resolves after its prior deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    try {
      const job = { id: "job-late-renewal", retryCount: 0, availableAt: "x" };
      let resolveRenewal: (renewed: boolean) => void = () => {};
      const renewClaim = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolveRenewal = resolve;
          }),
      );
      const store = fakeStore({
        claimNext: vi.fn().mockResolvedValueOnce(job).mockResolvedValue(null),
        renewClaim,
      });
      let capturedContext:
        | { assertOwned(): void; signal: AbortSignal }
        | undefined;
      const worker = {
        processClaimedJob: vi.fn(
          (_job: unknown, context: { assertOwned(): void; signal: AbortSignal }) =>
            new Promise<void>((resolve) => {
              capturedContext = context;
              context.signal.addEventListener("abort", () => resolve());
            }),
        ),
        reconcileOrphanLifecycle: vi.fn(),
      };
      const runner = new StorageBackedJobRunner({
        storage: { stores: { interactionJobs: store } } as never,
        worker: worker as never,
        logger,
        pollIntervalMs: 2_000,
        maxQueuedJobAgeMs: 21_600_000,
        leaseMs: 3_000,
        maxJobRetries: 3,
      });

      const tick = runner.runOnce();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(renewClaim).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date("2026-06-01T00:00:04.000Z"));
      resolveRenewal(true);
      await tick;

      expect(capturedContext?.signal.aborted).toBe(true);
      expect(() => capturedContext?.assertOwned()).toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not claim new work when stop begins during maintenance", async () => {
    const claimNext = vi.fn(async () => null);
    let runnerRef: StorageBackedJobRunner | null = null;
    const reconcileOrphanedInteractionRuns = vi.fn(async () => {
      void runnerRef?.stop();
      return [];
    });
    const store = fakeStore({ claimNext, reconcileOrphanedInteractionRuns });
    const worker = {
      processClaimedJob: vi.fn(),
      reconcileOrphanLifecycle: vi.fn(),
    };
    const runner = new StorageBackedJobRunner({
      storage: { stores: { interactionJobs: store } } as never,
      worker: worker as never,
      logger,
      pollIntervalMs: 2_000,
      maxQueuedJobAgeMs: 21_600_000,
      leaseMs: 3_000,
      maxJobRetries: 3,
    });
    runnerRef = runner;

    await runner.runOnce();

    expect(claimNext).not.toHaveBeenCalled();
    expect(worker.processClaimedJob).not.toHaveBeenCalled();
  });

  it("releases a race-won claim without incrementing retries when stop wins the race", async () => {
    const job = {
      id: "job-race",
      retryCount: 2,
      availableAt: "avail-1",
      lastError: null,
    };
    let runnerRef: StorageBackedJobRunner | null = null;
    const claimNext = vi.fn(async () => {
      // A stop that began while the claim was in flight must not process the
      // returned job.
      void runnerRef?.stop();
      return job;
    });
    const transitionClaim = vi.fn(async () => true);
    const store = fakeStore({ claimNext, transitionClaim });
    const processClaimedJob = vi.fn();
    const worker = {
      processClaimedJob,
      reconcileOrphanLifecycle: vi.fn(),
    };
    const runner = new StorageBackedJobRunner({
      storage: { stores: { interactionJobs: store } } as never,
      worker: worker as never,
      logger,
      pollIntervalMs: 2_000,
      maxQueuedJobAgeMs: 21_600_000,
      leaseMs: 3_000,
      maxJobRetries: 3,
    });
    runnerRef = runner;

    await runner.runOnce();

    expect(processClaimedJob).not.toHaveBeenCalled();
    expect(transitionClaim).toHaveBeenCalledTimes(1);
    expect(transitionClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-race",
        status: "queued",
        retryCount: 2,
        availableAt: "avail-1",
        finishedAt: null,
      }),
    );
  });

  it("aborts the claim context when heartbeat renewal reports lease loss", async () => {
    vi.useFakeTimers();
    try {
      const job = { id: "job-hb", retryCount: 0, availableAt: "x" };
      let capturedAborted: boolean | null = null;
      const renewClaim = vi.fn(async () => false);
      const store = fakeStore({
        claimNext: vi
          .fn()
          .mockResolvedValueOnce(job)
          .mockResolvedValue(null),
        renewClaim,
      });
      const worker = {
        processClaimedJob: vi.fn(
          (_job: unknown, context: { signal: AbortSignal }) =>
            new Promise<void>((resolve) => {
              context.signal.addEventListener("abort", () => {
                capturedAborted = context.signal.aborted;
                resolve();
              });
            }),
        ),
        reconcileOrphanLifecycle: vi.fn(),
      };
      const runner = new StorageBackedJobRunner({
        storage: { stores: { interactionJobs: store } } as never,
        worker: worker as never,
        logger,
        pollIntervalMs: 2_000,
        maxQueuedJobAgeMs: 21_600_000,
        leaseMs: 3_000,
        maxJobRetries: 3,
      });

      const tick = runner.runOnce();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(renewClaim).toHaveBeenCalledTimes(1);
      await tick;
      expect(capturedAborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop waits for the active attempt to settle", async () => {
    const job = { id: "job-stop", retryCount: 0, availableAt: "x" };
    let releaseWorker: () => void = () => {};
    const store = fakeStore({
      claimNext: vi.fn().mockResolvedValueOnce(job).mockResolvedValue(null),
    });
    const worker = {
      processClaimedJob: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseWorker = resolve;
          }),
      ),
      reconcileOrphanLifecycle: vi.fn(),
    };
    const runner = new StorageBackedJobRunner({
      storage: { stores: { interactionJobs: store } } as never,
      worker: worker as never,
      logger,
      pollIntervalMs: 2_000,
      maxQueuedJobAgeMs: 21_600_000,
      leaseMs: 3_000,
      maxJobRetries: 3,
    });

    runner.start();
    await vi.waitFor(() =>
      expect(worker.processClaimedJob).toHaveBeenCalledTimes(1),
    );

    let stopped = false;
    const stopPromise = runner.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);

    releaseWorker();
    await stopPromise;
    expect(stopped).toBe(true);
  });

  it("start and stop are idempotent", async () => {
    const store = fakeStore({});
    const runner = new StorageBackedJobRunner({
      storage: { stores: { interactionJobs: store } } as never,
      worker: {
        processClaimedJob: vi.fn(),
        reconcileOrphanLifecycle: vi.fn(),
      } as never,
      logger,
      pollIntervalMs: 2_000,
      maxQueuedJobAgeMs: 21_600_000,
      leaseMs: 3_000,
      maxJobRetries: 3,
    });
    runner.start();
    runner.start();
    await runner.stop();
    await runner.stop();
    expect(true).toBe(true);
  });
});
