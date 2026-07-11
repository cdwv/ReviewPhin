import { createId } from "../../utils/ids.js";
import type {
  CodeReviewSnapshotFilters,
  CodeReviewSnapshotOrderField,
  CodeReviewSnapshotRecord,
  CreateReviewFindingInput,
  DiscussionMappingFilters,
  DiscussionMappingOrderField,
  DiscussionMappingRecord,
  EntityStore,
  InteractionJobFilters,
  InteractionJobOrderField,
  InteractionJobRecord,
  InteractionJobStore,
  InteractionRunFilters,
  InteractionRunMetricsFilters,
  InteractionRunMetricsOrderField,
  InteractionRunMetricsRecord,
  InteractionRunOrderField,
  InteractionRunRecord,
  ReviewFindingFilters,
  ReviewFindingOrderField,
  ReviewFindingRecord,
  StoreListOrder,
  UpsertDiscussionMappingInput,
  UpsertInteractionRunMetricsInput,
} from "../contract/index.js";

type JobStore = EntityStore<
  InteractionJobRecord,
  InteractionJobFilters,
  InteractionJobOrderField
>;
type RunStore = EntityStore<
  InteractionRunRecord,
  InteractionRunFilters,
  InteractionRunOrderField
>;
type FindingStore = EntityStore<
  ReviewFindingRecord,
  ReviewFindingFilters,
  ReviewFindingOrderField
>;
type MetricsStore = EntityStore<
  InteractionRunMetricsRecord,
  InteractionRunMetricsFilters,
  InteractionRunMetricsOrderField
>;
type SnapshotStore = EntityStore<
  CodeReviewSnapshotRecord,
  CodeReviewSnapshotFilters,
  CodeReviewSnapshotOrderField
>;
type MappingStore = EntityStore<
  DiscussionMappingRecord,
  DiscussionMappingFilters,
  DiscussionMappingOrderField
>;

export interface SingleWorkerInteractionJobStoreOptions {
  readonly jobs: JobStore;
  readonly runs: RunStore;
  readonly reviewFindings: FindingStore;
  readonly interactionRunMetrics: MetricsStore;
  readonly codeReviewSnapshots: SnapshotStore;
  readonly discussionMappings: MappingStore;
  readonly pageSize?: number;
  readonly now?: () => string;
}

const DEFAULT_PAGE_SIZE = 200;
const LEASE_EXPIRED_FAILURE_MESSAGE =
  "Interaction job lease expired and exceeded the maximum retry budget.";
const RUN_ABANDONED_MESSAGE =
  "Interaction run abandoned after its owning claim was lost.";
const RUN_COMPLETION_UNCONFIRMED_MESSAGE =
  "Interaction run completion could not be confirmed because its owning job did not complete under the same claim.";

/**
 * Reusable claim-aware interaction-job store for adapters that cannot perform an
 * atomic compare-and-set across selection and update. It exhaustively pages
 * candidate jobs, filters and sorts in memory, and confirms every claim with a
 * read-back of the persisted claim token. It reports `claimMode: "single-worker"`
 * and only guarantees single-review execution when exactly one process runs the
 * job runner.
 *
 * The provided stores must be raw (unguarded) stores so internal claim writes do
 * not trip the public mutation guards this helper adds to the returned store.
 */
export function createSingleWorkerInteractionJobStore(
  options: SingleWorkerInteractionJobStoreOptions,
): InteractionJobStore {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const now = options.now ?? (() => new Date().toISOString());
  const { jobs, runs } = options;
  let jobMutationTail: Promise<void> = Promise.resolve();
  let completedReconciliationPage = 1;

  function serializeJobMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = jobMutationTail.then(operation, operation);
    jobMutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function listAllJobs(
    filters?: InteractionJobFilters,
  ): Promise<InteractionJobRecord[]> {
    const results: InteractionJobRecord[] = [];
    const order: StoreListOrder<InteractionJobOrderField>[] = [
      { field: "id", direction: "asc" },
    ];
    for (let page = 1; ; page += 1) {
      const batch = await jobs.list({
        ...(filters ? { filters } : {}),
        order,
        page,
        pageSize,
      });
      results.push(...batch);
      if (batch.length < pageSize) {
        break;
      }
    }
    return results;
  }

  async function listAllRuns(
    filters?: InteractionRunFilters,
  ): Promise<InteractionRunRecord[]> {
    const results: InteractionRunRecord[] = [];
    const order: StoreListOrder<InteractionRunOrderField>[] = [
      { field: "id", direction: "asc" },
    ];
    for (let page = 1; ; page += 1) {
      const batch = await runs.list({
        ...(filters ? { filters } : {}),
        order,
        page,
        pageSize,
      });
      results.push(...batch);
      if (batch.length < pageSize) {
        break;
      }
    }
    return results;
  }

  function compareEligible(
    left: InteractionJobRecord,
    right: InteractionJobRecord,
  ): number {
    if (left.availableAt !== right.availableAt) {
      return left.availableAt < right.availableAt ? -1 : 1;
    }
    if (left.enqueuedAt !== right.enqueuedAt) {
      return left.enqueuedAt < right.enqueuedAt ? -1 : 1;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  }

  function isLeaseExpired(job: InteractionJobRecord, now: string): boolean {
    return (
      job.claimToken === null ||
      job.claimExpiresAt === null ||
      job.claimExpiresAt <= now
    );
  }

  async function isJobOwned(
    jobId: string,
    claimToken: string,
  ): Promise<InteractionJobRecord | null> {
    const job = await jobs.get(jobId);
    if (
      job &&
      job.status === "in_progress" &&
      job.claimToken === claimToken &&
      !isLeaseExpired(job, now())
    ) {
      return job;
    }
    return null;
  }

  async function isRunOwnedInProgress(
    interactionRunId: string,
    claimToken: string,
  ): Promise<InteractionRunRecord | null> {
    const run = await runs.get(interactionRunId);
    if (
      run &&
      run.status === "in_progress" &&
      run.interactionJobClaimToken === claimToken &&
      (await isJobOwned(run.interactionJobId, claimToken))
    ) {
      return run;
    }
    return null;
  }

  function assertMutable(job: InteractionJobRecord | null, id: string): void {
    if (job && job.status === "in_progress") {
      throw new Error(
        `Cannot mutate in-progress interaction job ${id} without an owning claim`,
      );
    }
  }

  async function guardMutable(id: string): Promise<void> {
    assertMutable(await jobs.get(id), id);
  }

  return {
    get: (id) => jobs.get(id),
    getMany: (ids) => jobs.getMany(ids),
    find: (filters) => jobs.find(filters),
    list: (input) => jobs.list(input),
    upsert: (entity) =>
      serializeJobMutation(async () => {
        await guardMutable(entity.id);
        await jobs.upsert(entity);
      }),
    upsertMany: (entities) =>
      serializeJobMutation(async () => {
        for (const entity of entities) {
          await guardMutable(entity.id);
        }
        await jobs.upsertMany(entities);
      }),
    replace: (entity) =>
      serializeJobMutation(async () => {
        await guardMutable(entity.id);
        await jobs.replace(entity);
      }),
    replaceMany: (entities) =>
      serializeJobMutation(async () => {
        for (const entity of entities) {
          await guardMutable(entity.id);
        }
        await jobs.replaceMany(entities);
      }),
    update: (input) =>
      serializeJobMutation(async () => {
        await guardMutable(input.value.id);
        await jobs.update(input);
      }),
    updateMany: (inputs) =>
      serializeJobMutation(async () => {
        for (const input of inputs) {
          await guardMutable(input.value.id);
        }
        await jobs.updateMany(inputs);
      }),
    patch: (input) =>
      serializeJobMutation(async () => {
        await guardMutable(input.id);
        await jobs.patch(input);
      }),
    patchMany: (inputs) =>
      serializeJobMutation(async () => {
        for (const input of inputs) {
          await guardMutable(input.id);
        }
        await jobs.patchMany(inputs);
      }),
    delete: (id) =>
      serializeJobMutation(async () => {
        await guardMutable(id);
        await jobs.delete(id);
      }),
    deleteMany: (ids) =>
      serializeJobMutation(async () => {
        for (const id of ids) {
          await guardMutable(id);
        }
        await jobs.deleteMany(ids);
      }),

    claimMode: "single-worker",

    claimNext(input) {
      return serializeJobMutation(async () => {
      const inProgress = await listAllJobs({
        status: { eq: "in_progress" },
      });

      for (const job of inProgress) {
        if (!isLeaseExpired(job, input.now)) {
          continue;
        }
        const nextRetryCount = job.retryCount + 1;
        if (nextRetryCount <= input.maxJobRetries) {
          await jobs.upsert({
            ...job,
            status: "queued",
            retryCount: nextRetryCount,
            availableAt: input.now,
            claimToken: null,
            claimedBy: null,
            claimExpiresAt: null,
            finishedAt: null,
          });
        } else {
          await jobs.upsert({
            ...job,
            status: "failed",
            retryCount: nextRetryCount,
            finishedAt: input.now,
            lastError: LEASE_EXPIRED_FAILURE_MESSAGE,
            claimToken: null,
            claimedBy: null,
            claimExpiresAt: null,
          });
        }
      }

      const activeLeases = await listAllJobs({ status: { eq: "in_progress" } });
      if (
        activeLeases.some(
          (job) => job.claimExpiresAt !== null && job.claimExpiresAt > input.now,
        )
      ) {
        return null;
      }

      const queued = await listAllJobs({ status: { eq: "queued" } });
      const eligible = queued
        .filter(
          (job) =>
            job.enqueuedAt >= input.queuedAfter && job.availableAt <= input.now,
        )
        .sort(compareEligible);
      const candidate = eligible[0];
      if (!candidate) {
        return null;
      }

      await jobs.upsert({
        ...candidate,
        status: "in_progress",
        startedAt: input.now,
        claimToken: input.claimToken,
        claimedBy: input.workerId,
        claimExpiresAt: input.claimExpiresAt,
        finishedAt: null,
        lastError: null,
      });

      const readBack = await jobs.get(candidate.id);
      if (
        !readBack ||
        readBack.claimToken !== input.claimToken ||
        readBack.status !== "in_progress"
      ) {
        return null;
      }
      return readBack;
      });
    },

    expireQueued(input) {
      return serializeJobMutation(async () => {
      const queued = await listAllJobs({ status: { eq: "queued" } });
      const expirable = queued
        .filter((job) => job.enqueuedAt < input.queuedBefore)
        .sort((left, right) =>
          left.enqueuedAt < right.enqueuedAt
            ? -1
            : left.enqueuedAt > right.enqueuedAt
              ? 1
              : left.id < right.id
                ? -1
                : left.id > right.id
                  ? 1
                  : 0,
        )
        .slice(0, input.limit);

      let expiredCount = 0;
      for (const job of expirable) {
        const current = await jobs.get(job.id);
        if (!current || current.status !== "queued") {
          continue;
        }
        await jobs.upsert({
          ...current,
          status: "expired",
          finishedAt: input.now,
          lastError: input.reason,
          claimToken: null,
          claimedBy: null,
          claimExpiresAt: null,
        });
        expiredCount += 1;
      }
      return expiredCount;
      });
    },

    renewClaim(input) {
      return serializeJobMutation(async () => {
      const job = await isJobOwned(input.jobId, input.claimToken);
      const renewalNow = now();
      if (
        !job ||
        job.claimExpiresAt === null ||
        job.claimExpiresAt <= input.now ||
        job.claimExpiresAt <= renewalNow
      ) {
        return false;
      }
      await jobs.upsert({
        ...job,
        claimExpiresAt: input.claimExpiresAt,
      });
      const readBack = await jobs.get(input.jobId);
      return (
        readBack !== null &&
        readBack.status === "in_progress" &&
        readBack.claimToken === input.claimToken
      );
      });
    },

    transitionClaim(input) {
      return serializeJobMutation(async () => {
      const job = await isJobOwned(input.jobId, input.claimToken);
      if (!job) {
        return false;
      }
      await jobs.upsert({
        ...job,
        status: input.status,
        retryCount: input.retryCount,
        lastError: input.lastError,
        availableAt: input.availableAt,
        finishedAt: input.finishedAt,
        claimToken: null,
        claimedBy: null,
        claimExpiresAt: null,
      });
      return true;
      });
    },

    createInteractionRunForClaim(input) {
      return serializeJobMutation(async () => {
      const job = await isJobOwned(input.jobId, input.claimToken);
      if (!job || input.run.interactionJobId !== input.jobId) {
        return null;
      }

      const now = new Date().toISOString();
      const runId = createId("run");
      const run: InteractionRunRecord = {
        id: runId,
        interactionJobId: input.run.interactionJobId,
        tenantId: input.run.tenantId,
        provider: input.run.provider,
        model: input.run.model,
        modelProfileName: input.run.modelProfileName,
        providerBaseUrl: input.run.providerBaseUrl,
        providerType: input.run.providerType,
        textGenerationModel: input.run.textGenerationModel,
        status: "in_progress",
        resultJson: null,
        error: null,
        startedAt: now,
        finishedAt: null,
        interactionJobClaimToken: input.claimToken,
        reviewReasoningEffort: input.run.reviewReasoningEffort ?? null,
        textGenerationReasoningEffort:
          input.run.textGenerationReasoningEffort ?? null,
      };
      await runs.upsert(run);
      await jobs.upsert({ ...job, latestInteractionRunId: runId });

      const created = await runs.get(runId);
      return created ?? run;
      });
    },

    async transitionInteractionRunForClaim(input) {
      const job = await isJobOwned(input.jobId, input.claimToken);
      if (!job) {
        return false;
      }
      const run = await isRunOwnedInProgress(
        input.interactionRunId,
        input.claimToken,
      );
      if (!run || run.interactionJobId !== input.jobId) {
        return false;
      }
      await runs.upsert({
        ...run,
        status: input.status,
        resultJson: input.resultJson,
        error: input.error,
        finishedAt: input.finishedAt,
      });
      return true;
    },

    async replaceReviewFindingsForClaim(input) {
      const job = await isJobOwned(input.jobId, input.claimToken);
      if (!job) {
        return false;
      }
      const run = await isRunOwnedInProgress(
        input.interactionRunId,
        input.claimToken,
      );
      if (!run || run.interactionJobId !== input.jobId) {
        return false;
      }

      const existing = await listAllFindings(input.interactionRunId);
      await options.reviewFindings.deleteMany(
        existing.map((finding) => finding.id),
      );

      const now = new Date().toISOString();
      const latestByIdentity = new Map<string, CreateReviewFindingInput>();
      for (const finding of input.findings) {
        latestByIdentity.set(finding.identityKey, finding);
      }
      for (const finding of latestByIdentity.values()) {
        await options.reviewFindings.upsert({
          id: createId("finding"),
          interactionRunId: input.interactionRunId,
          identityKey: finding.identityKey,
          severity: finding.severity,
          category: finding.category,
          title: finding.title,
          body: finding.body,
          anchorJson: finding.anchorJson,
          suggestionJson: finding.suggestionJson,
          status: finding.status,
          createdAt: now,
        });
      }
      return true;
    },

    async upsertInteractionRunMetricsForClaim(input) {
      const job = await isJobOwned(input.jobId, input.claimToken);
      if (!job) {
        return false;
      }
      const run = await isRunOwnedInProgress(
        input.interactionRunId,
        input.claimToken,
      );
      if (
        !run ||
        run.interactionJobId !== input.jobId ||
        input.metrics.interactionRunId !== input.interactionRunId
      ) {
        return false;
      }
      await upsertMetrics(input.metrics);
      return true;
    },

    async createCodeReviewSnapshotForClaim(input) {
      const job = await isJobOwned(input.jobId, input.claimToken);
      if (!job) {
        return null;
      }
      const run = await isRunOwnedInProgress(
        input.interactionRunId,
        input.claimToken,
      );
      if (
        !run ||
        run.interactionJobId !== input.jobId ||
        input.snapshot.interactionJobId !== input.jobId
      ) {
        return null;
      }

      const now = new Date().toISOString();
      const snapshotId = createId("snapshot");
      const snapshot: CodeReviewSnapshotRecord = {
        id: snapshotId,
        interactionJobId: input.snapshot.interactionJobId,
        tenantId: input.snapshot.tenantId,
        codeReviewId: input.snapshot.codeReviewId,
        headSha: input.snapshot.headSha,
        codeReviewJson: input.snapshot.codeReviewJson,
        versionsJson: input.snapshot.versionsJson,
        changesJson: input.snapshot.changesJson,
        commentsJson: input.snapshot.commentsJson,
        discussionsJson: input.snapshot.discussionsJson,
        instructionsJson: input.snapshot.instructionsJson,
        projectMemoryJson: input.snapshot.projectMemoryJson,
        workspaceStrategy: input.snapshot.workspaceStrategy,
        createdAt: now,
        interactionRunId: input.interactionRunId,
      };
      await options.codeReviewSnapshots.upsert(snapshot);
      const created = await options.codeReviewSnapshots.get(snapshotId);
      return created ?? snapshot;
    },

    async updateReviewFindingStatusForClaim(input) {
      const job = await isJobOwned(input.jobId, input.claimToken);
      if (!job) {
        return false;
      }
      const activeRun = await isRunOwnedInProgress(
        input.interactionRunId,
        input.claimToken,
      );
      if (!activeRun || activeRun.interactionJobId !== input.jobId) {
        return false;
      }

      // Ownership holds. A no-op (no historical finding matched) returns true so
      // callers can distinguish lease loss from a legitimate no-match.
      const relevantJobs = await listAllJobs({
        tenantId: { eq: input.tenantId },
        codeReviewId: { eq: input.codeReviewId },
      });
      if (relevantJobs.length === 0) {
        return true;
      }

      const completedRuns = await listAllRuns({
        interactionJobId: { in: relevantJobs.map((entry) => entry.id) },
        status: { eq: "completed" },
      });
      if (completedRuns.length === 0) {
        return true;
      }

      const runIds = new Set(completedRuns.map((run) => run.id));
      const findings: ReviewFindingRecord[] = [];
      for (const runId of runIds) {
        const runFindings = await listAllFindings(runId);
        for (const finding of runFindings) {
          if (finding.identityKey !== input.identityKey) {
            continue;
          }
          if (
            input.currentStatuses &&
            input.currentStatuses.length > 0 &&
            !input.currentStatuses.includes(finding.status)
          ) {
            continue;
          }
          findings.push(finding);
        }
      }
      if (findings.length === 0) {
        return true;
      }

      for (const finding of findings) {
        await options.reviewFindings.patch({
          id: finding.id,
          value: { status: input.status },
        });
      }
      return true;
    },

    async upsertDiscussionMappingForClaim(input) {
      const job = await isJobOwned(input.jobId, input.claimToken);
      if (!job) {
        return null;
      }
      return upsertDiscussionMapping(input.mapping);
    },

    async reconcileOrphanedInteractionRuns(input) {
      const reconciled: InteractionRunRecord[] = [];

      // 1. In-progress runs whose owning claim was lost.
      const inProgressRuns = await listAllRuns({
        status: { eq: "in_progress" },
      });
      for (const run of inProgressRuns) {
        const job = await jobs.get(run.interactionJobId);
        const orphaned =
          run.interactionJobClaimToken === null ||
          !job ||
          job.status !== "in_progress" ||
          job.claimToken === null ||
          job.claimToken !== run.interactionJobClaimToken;
        if (!orphaned) {
          continue;
        }
        const current = await runs.get(run.id);
        if (!current || current.status !== "in_progress") {
          continue;
        }
        await runs.upsert({
          ...current,
          status: "failed",
          error: RUN_ABANDONED_MESSAGE,
          finishedAt: input.now,
        });
        const updated = await runs.get(run.id);
        if (updated) {
          reconciled.push(updated);
        }
        if (reconciled.length >= input.limit) {
          return reconciled;
        }
      }

      // 2. Completed latest runs whose owning job never completed under that
      // attempt. Marking the run failed prevents a false completion from
      // lingering. The read-back guard keeps the update idempotent and prevents
      // a stale completion from overwriting a run that is already failed.
      const scannedJobs = await jobs.list({
        filters: { status: { neq: "completed" } },
        order: [{ field: "id", direction: "asc" }],
        page: completedReconciliationPage,
        pageSize,
      });
      completedReconciliationPage =
        scannedJobs.length < pageSize ? 1 : completedReconciliationPage + 1;
      const candidateJobs = scannedJobs.filter(
        (job) => job.latestInteractionRunId !== null,
      );
      if (candidateJobs.length > 0) {
        const jobBatch = candidateJobs;
        const runIds = jobBatch.map((job) => job.latestInteractionRunId!);
        const runsById = new Map(
          (await runs.getMany(runIds)).map((run) => [run.id, run]),
        );
        for (const job of jobBatch) {
          const run = runsById.get(job.latestInteractionRunId!);
          if (!run || run.status !== "completed") {
            continue;
          }
          const ownedByActiveAttempt =
            job.status === "in_progress" &&
            job.claimToken !== null &&
            job.claimToken === run.interactionJobClaimToken &&
            job.claimExpiresAt !== null &&
            job.claimExpiresAt > input.now;
          if (ownedByActiveAttempt) {
            continue;
          }
          const current = await runs.get(run.id);
          if (!current || current.status !== "completed") {
            continue;
          }
          await runs.upsert({
            ...current,
            status: "failed",
            error: RUN_COMPLETION_UNCONFIRMED_MESSAGE,
            finishedAt: input.now,
          });
          const updated = await runs.get(run.id);
          if (updated) {
            reconciled.push(updated);
          }
          if (reconciled.length >= input.limit) {
            return reconciled;
          }
        }
      }

      return reconciled;
    },
  };

  async function listAllFindings(
    interactionRunId: string,
  ): Promise<ReviewFindingRecord[]> {
    const results: ReviewFindingRecord[] = [];
    const filters: ReviewFindingFilters = {
      interactionRunId: { eq: interactionRunId },
    };
    const order: StoreListOrder<ReviewFindingOrderField>[] = [
      { field: "id", direction: "asc" },
    ];
    for (let page = 1; ; page += 1) {
      const batch = await options.reviewFindings.list({
        filters,
        order,
        page,
        pageSize,
      });
      results.push(...batch);
      if (batch.length < pageSize) {
        break;
      }
    }
    return results;
  }

  async function upsertMetrics(
    input: UpsertInteractionRunMetricsInput,
  ): Promise<void> {
    const existing = await options.interactionRunMetrics.find({
      interactionRunId: { eq: input.interactionRunId },
    });
    const now = new Date().toISOString();
    await options.interactionRunMetrics.upsert({
      id: existing?.id ?? createId("metrics"),
      interactionRunId: input.interactionRunId,
      triggerKind: input.triggerKind,
      promptMode: input.promptMode,
      promptChars: input.promptChars,
      promptContextChangedFiles: input.promptContextChangedFiles,
      promptContextPriorDiscussions: input.promptContextPriorDiscussions,
      promptContextComments: input.promptContextComments,
      assistantTurns: input.assistantTurns,
      assistantCalls: input.assistantCalls,
      toolExecutions: input.toolExecutions,
      viewToolCalls: input.viewToolCalls,
      globToolCalls: input.globToolCalls,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens,
      cacheWriteTokens: input.cacheWriteTokens,
      reasoningTokens: input.reasoningTokens,
      apiDurationMs: input.apiDurationMs,
      premiumRequests: input.premiumRequests,
      repeatedViewReads: input.repeatedViewReads,
      repeatedViewPathsJson: input.repeatedViewPathsJson,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async function upsertDiscussionMapping(
    input: UpsertDiscussionMappingInput,
  ): Promise<DiscussionMappingRecord> {
    const existing = await options.discussionMappings.find({
      tenantId: { eq: input.tenantId },
      codeReviewId: { eq: input.codeReviewId },
      platformDiscussionId: { eq: input.platformDiscussionId },
    });
    const now = new Date().toISOString();
    const mappingId = existing?.id ?? input.id ?? createId("mapping");
    await options.discussionMappings.upsert({
      id: mappingId,
      tenantId: input.tenantId,
      codeReviewId: input.codeReviewId,
      identityKey: input.identityKey,
      findingFingerprint: input.findingFingerprint,
      title: input.title,
      severity: input.severity,
      category: input.category,
      body: input.body,
      platformDiscussionId: input.platformDiscussionId,
      platformCommentId: input.platformCommentId,
      anchorJson: input.anchorJson,
      positionJson: input.positionJson,
      botDiscussion: input.botDiscussion,
      botComment: input.botComment,
      commentAuthorId: input.commentAuthorId,
      commentAuthorUsername: input.commentAuthorUsername,
      status: input.status,
      lastInteractionRunId: input.lastInteractionRunId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    const persisted = await options.discussionMappings.get(mappingId);
    if (!persisted) {
      throw new Error(`Failed to persist discussion mapping ${mappingId}`);
    }
    return persisted;
  }
}
