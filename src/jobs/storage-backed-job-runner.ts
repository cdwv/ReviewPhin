import type { Logger } from "pino";

import type { InteractionJobRecord } from "../storage/contract/index.js";
import {
  type JobClaimContext,
  LeaseLostError,
  type StorageHelpers,
} from "../storage/storage-helpers.js";
import { createId, createUlid } from "../utils/ids.js";
import type { ReviewWorker } from "./review-worker.js";

export interface StorageBackedJobRunnerOptions {
  storage: StorageHelpers;
  worker: ReviewWorker;
  logger: Logger;
  pollIntervalMs: number;
  maxQueuedJobAgeMs: number;
  leaseMs: number;
  maxJobRetries: number;
  workerId?: string | undefined;
  expireBatchLimit?: number | undefined;
  orphanReconcileLimit?: number | undefined;
  triggerLifecycleShutdownGraceMs?: number | undefined;
}

const DEFAULT_EXPIRE_BATCH_LIMIT = 100;
const DEFAULT_ORPHAN_RECONCILE_LIMIT = 100;
const DEFAULT_TRIGGER_LIFECYCLE_SHUTDOWN_GRACE_MS = 5_000;

/**
 * Polls the claim-aware interaction-job store and drives the {@link ReviewWorker}
 * through storage-backed leases. The runner owns one stable `workerId` per
 * process and mints a fresh claim token per attempt. It processes at most one
 * claimed job at a time, renews the active claim on a lease-derived heartbeat,
 * aborts the claim context when a heartbeat reports lease loss, expires stale
 * queued jobs, and reconciles orphaned runs on every tick.
 */
export class StorageBackedJobRunner {
  private readonly storage: StorageHelpers;
  private readonly worker: ReviewWorker;
  private readonly logger: Logger;
  private readonly pollIntervalMs: number;
  private readonly maxQueuedJobAgeMs: number;
  private readonly leaseMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly maxJobRetries: number;
  private readonly expireBatchLimit: number;
  private readonly orphanReconcileLimit: number;
  private readonly triggerLifecycleShutdownGraceMs: number;

  public readonly workerId: string;

  private started = false;
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private triggerLifecycleReconciliation: Promise<void> = Promise.resolve();
  private triggerLifecycleReconciliationGeneration = 0;

  public constructor(options: StorageBackedJobRunnerOptions) {
    this.storage = options.storage;
    this.worker = options.worker;
    this.logger = options.logger;
    this.pollIntervalMs = options.pollIntervalMs;
    this.maxQueuedJobAgeMs = options.maxQueuedJobAgeMs;
    this.leaseMs = options.leaseMs;
    this.heartbeatIntervalMs = Math.max(1, Math.floor(options.leaseMs / 3));
    this.maxJobRetries = options.maxJobRetries;
    this.expireBatchLimit =
      options.expireBatchLimit ?? DEFAULT_EXPIRE_BATCH_LIMIT;
    this.orphanReconcileLimit =
      options.orphanReconcileLimit ?? DEFAULT_ORPHAN_RECONCILE_LIMIT;
    this.triggerLifecycleShutdownGraceMs =
      options.triggerLifecycleShutdownGraceMs ??
      DEFAULT_TRIGGER_LIFECYCLE_SHUTDOWN_GRACE_MS;
    this.workerId = options.workerId ?? createId("worker");
  }

  /** Idempotently begins polling for claimable jobs. */
  public start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.stopping = false;
    this.scheduleNext(0);
  }

  /**
   * Idempotently stops accepting new claims, clears the poll timer, and waits for
   * the active attempt to settle while its heartbeat continues, so storage can be
   * closed safely afterwards.
   */
  public async stop(): Promise<void> {
    this.stopping = true;
    this.triggerLifecycleReconciliationGeneration += 1;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.inFlight.catch(() => undefined);
    await this.waitForTriggerLifecycleReconciliation();
    this.started = false;
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopping) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inFlight = this.loop();
      void this.inFlight;
    }, delayMs);
  }

  private async loop(): Promise<void> {
    if (this.stopping) {
      return;
    }
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error({ err: error }, "job runner tick failed");
    }
    this.scheduleNext(this.pollIntervalMs);
  }

  /**
   * Package-internal single maintenance-and-claim tick. Exposed for deterministic
   * tests and reused by the polling loop. Expires stale queued jobs and
   * reconciles orphaned runs *before* attempting a claim so a freshly claimed job
   * starts its heartbeat with no maintenance gap eating into its lease. Claim
   * timestamps are recomputed after maintenance so the persisted lease reflects
   * the moment the claim is taken. When a claim is returned, the heartbeat begins
   * immediately as the job is processed.
   */
  public async runOnce(): Promise<void> {
    const maintenanceNowMs = Date.now();
    const maintenanceNow = new Date(maintenanceNowMs).toISOString();
    const queuedBefore = new Date(
      maintenanceNowMs - this.maxQueuedJobAgeMs,
    ).toISOString();

    const expiredCount = await this.storage.stores.interactionJobs.expireQueued(
      {
        now: maintenanceNow,
        queuedBefore,
        reason: `Queued job expired after exceeding the maximum age of ${this.maxQueuedJobAgeMs}ms.`,
        limit: this.expireBatchLimit,
      },
    );
    if (expiredCount > 0) {
      const expiredJobs = await this.storage.stores.interactionJobs.list({
        filters: {
          status: { eq: "expired" },
          finishedAt: { eq: maintenanceNow },
        },
        order: [{ field: "id", direction: "asc" }],
        page: 1,
        pageSize: this.expireBatchLimit,
      });
      this.queueTriggerLifecycleReconciliation(expiredJobs);
    }

    await this.reconcileOrphans();

    // Recheck stopping immediately before claiming so a stop() that began during
    // maintenance never takes on new work.
    if (this.stopping) {
      return;
    }

    // Recompute claim timestamps after maintenance so the persisted lease window
    // starts when the claim is actually taken, not before the (possibly slow)
    // expire/reconcile pass.
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const queuedAfter = new Date(
      nowMs - this.maxQueuedJobAgeMs,
    ).toISOString();
    const claimToken = createUlid();
    const claimExpiresAt = new Date(nowMs + this.leaseMs).toISOString();
    const job = await this.storage.stores.interactionJobs.claimNext({
      workerId: this.workerId,
      claimToken,
      now,
      claimExpiresAt,
      queuedAfter,
      maxJobRetries: this.maxJobRetries,
    });

    if (!job) {
      return;
    }

    // A stop() may have begun while claimNext was in flight. Rather than
    // processing new work or abandoning the claim until its lease expires, safely
    // release the still-owned claim back to the queue without incrementing
    // retries so another worker (or the next start) can pick it up immediately.
    if (this.stopping) {
      await this.releaseClaim(job, claimToken);
      return;
    }

    await this.processClaimed(job, claimToken, claimExpiresAt);
  }

  /**
   * Returns a still-owned claim to the queue without incrementing its retry
   * count, leaving it immediately eligible for another attempt. Used when a stop
   * races a successful claim.
   */
  private async releaseClaim(
    job: InteractionJobRecord,
    claimToken: string,
  ): Promise<void> {
    try {
      await this.storage.stores.interactionJobs.transitionClaim({
        jobId: job.id,
        claimToken,
        status: "queued",
        retryCount: job.retryCount,
        lastError: job.lastError,
        availableAt: job.availableAt,
        finishedAt: null,
      });
    } catch (error) {
      this.logger.warn(
        { err: error, interactionJobId: job.id },
        "failed to release claim after stop raced a successful claim",
      );
    }
  }

  private async reconcileOrphans(): Promise<void> {
    const runs =
      await this.storage.stores.interactionJobs.reconcileOrphanedInteractionRuns(
        {
          now: new Date().toISOString(),
          limit: this.orphanReconcileLimit,
        },
      );
    for (const run of runs) {
      await this.worker.reconcileOrphanLifecycle(run);
    }
  }

  private queueTriggerLifecycleReconciliation(
    jobs: readonly InteractionJobRecord[],
  ): void {
    if (this.stopping) {
      return;
    }
    const generation = this.triggerLifecycleReconciliationGeneration;
    this.triggerLifecycleReconciliation = this.triggerLifecycleReconciliation
      .then(async () => {
        for (const job of jobs) {
          if (generation !== this.triggerLifecycleReconciliationGeneration) {
            return;
          }
          await this.worker.reconcileTriggerLifecycle(job);
        }
      })
      .catch((error: unknown) => {
        this.logger.warn(
          { err: error },
          "failed to reconcile expired job trigger lifecycle",
        );
      });
  }

  private async waitForTriggerLifecycleReconciliation(): Promise<void> {
    let timeout: NodeJS.Timeout | null = null;
    const completed = await Promise.race([
      this.triggerLifecycleReconciliation.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(
          () => resolve(false),
          this.triggerLifecycleShutdownGraceMs,
        );
      }),
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }
    if (!completed) {
      this.logger.warn(
        { graceMs: this.triggerLifecycleShutdownGraceMs },
        "stopped waiting for best-effort trigger lifecycle reconciliation",
      );
      this.triggerLifecycleReconciliation = Promise.resolve();
    }
  }

  private async processClaimed(
    job: InteractionJobRecord,
    claimToken: string,
    claimExpiresAt: string,
  ): Promise<void> {
    const controller = new AbortController();
    const heartbeat = this.startHeartbeat(
      job.id,
      claimToken,
      claimExpiresAt,
      controller,
    );
    const context: JobClaimContext = {
      jobId: job.id,
      claimToken,
      signal: controller.signal,
      interactionRunId: null,
      assertOwned: () => {
        heartbeat.assertOwned();
      },
    };

    try {
      await this.worker.processClaimedJob(job, context);
    } catch (error) {
      this.logger.error(
        { err: error, interactionJobId: job.id },
        "interaction job processing raised an unexpected error",
      );
    } finally {
      heartbeat.stop();
    }
  }

  /**
   * Starts a serialized heartbeat that renews the active claim on a lease-derived
   * cadence. Only one renewal is ever in flight (no overlapping calls). An
   * independent local lease-deadline timer aborts the claim no later than the
   * deadline even if a renewal never settles, so a hung storage call cannot leave
   * a stale attempt running past its lease. Transient renewal errors are retried
   * on the next beat while time remains before the deadline. The loop continues
   * while the worker drains and stops once {@link stop} is called after the
   * attempt settles.
   */
  private startHeartbeat(
    jobId: string,
    claimToken: string,
    initialClaimExpiresAt: string,
    controller: AbortController,
  ): { assertOwned: () => void; stop: () => void } {
    let stopped = false;
    let leaseDeadline = new Date(initialClaimExpiresAt).getTime();
    let deadlineTimer: NodeJS.Timeout | null = null;

    const clearDeadline = (): void => {
      if (deadlineTimer) {
        clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
    };

    const armDeadline = (): void => {
      clearDeadline();
      const remaining = Math.max(0, leaseDeadline - Date.now());
      deadlineTimer = setTimeout(() => {
        // The lease deadline elapsed without a successful renewal (for example a
        // renewal that never settles). Fence the attempt immediately.
        if (!stopped) {
          controller.abort();
        }
      }, remaining);
      deadlineTimer.unref?.();
    };

    const wait = (ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      });

    const runLoop = async (): Promise<void> => {
      while (!stopped && !controller.signal.aborted) {
        await wait(this.heartbeatIntervalMs);
        if (stopped || controller.signal.aborted) {
          return;
        }
        try {
          const renewalNowMs = Date.now();
          const renewedClaimExpiresAt = new Date(
            renewalNowMs + this.leaseMs,
          ).toISOString();
          const renewed = await this.storage.stores.interactionJobs.renewClaim({
            jobId,
            claimToken,
            now: new Date(renewalNowMs).toISOString(),
            claimExpiresAt: renewedClaimExpiresAt,
          });
          if (stopped) {
            return;
          }
          if (Date.now() >= leaseDeadline) {
            controller.abort();
            return;
          }
          if (renewed) {
            leaseDeadline = new Date(renewedClaimExpiresAt).getTime();
            armDeadline();
            continue;
          }
          // The ownership predicate failed: the job was reclaimed by another
          // attempt. Fence the current attempt immediately.
          controller.abort();
          return;
        } catch (error) {
          // Transient contention (for example SQLITE_BUSY). Retry on the next
          // beat while time remains before the local lease deadline; the
          // independent deadline timer handles a never-settling renewal.
          if (Date.now() >= leaseDeadline) {
            controller.abort();
            return;
          }
          this.logger.warn(
            { err: error, interactionJobId: jobId },
            "heartbeat renewal failed; will retry until lease deadline",
          );
        }
      }
    };

    armDeadline();
    void runLoop();

    return {
      assertOwned: () => {
        if (controller.signal.aborted || Date.now() >= leaseDeadline) {
          controller.abort();
          throw new LeaseLostError();
        }
      },
      stop: () => {
        stopped = true;
        clearDeadline();
      },
    };
  }
}
