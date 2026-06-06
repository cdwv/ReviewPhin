import { createId } from "../utils/ids.js";
import type {
  CreateInteractionJobInput,
  CreateInteractionRunInput,
  CreateCodeReviewSnapshotInput,
  CreateReviewFindingInput,
  DiscussionMappingRecord,
  EntityStore,
  InteractionJobRecord,
  InteractionRunMetricsRecord,
  InteractionRunRecord,
  CodeReviewSnapshotRecord,
  ModelProfileRecord,
  PlatformConnectionRecord,
  PlatformConnectionStatus,
  PreviousCompletedInteractionRecord,
  PriorReviewFindingRecord,
  ReviewAnchor,
  ReviewFindingRecord,
  ReviewFindingStatus,
  ReviewSuggestion,
  StorageTenantInput,
  StorageStores,
  StoreListOrder,
  TenantDeletionSummary,
  TenantRecord,
  UpsertDiscussionMappingInput,
  UpsertInteractionRunMetricsInput,
  UpsertModelProfileInput,
} from "./contract/index.js";

const DEFAULT_PAGE_SIZE = 200;

function resolveDefined<T>(value: T | undefined, fallback: T): T {
  if (value === undefined) {
    return fallback;
  }

  return value;
}

export interface StorageHelpers {
  readonly stores: StorageStores;
  upsertModelProfile(
    input: UpsertModelProfileInput,
  ): Promise<ModelProfileRecord>;
  setDefaultModelProfile(
    name: string | null,
  ): Promise<ModelProfileRecord | null>;
  deleteModelProfile(name: string): Promise<ModelProfileRecord | null>;
  createPlatformConnection(input: {
    name: string;
    platform: string;
    status: PlatformConnectionStatus;
    platformConnectionConfigJson: string;
  }): Promise<PlatformConnectionRecord>;
  resolvePlatformConnection(
    reference: string,
  ): Promise<PlatformConnectionRecord | null>;
  updatePlatformConnection(input: {
    reference: string;
    status: PlatformConnectionStatus;
    platformConnectionConfigJson: string;
  }): Promise<PlatformConnectionRecord>;
  deletePlatformConnection(
    reference: string,
  ): Promise<PlatformConnectionRecord | null>;
  upsertTenant(tenant: StorageTenantInput): Promise<TenantRecord>;
  setTenantModelProfile(
    tenantKey: string,
    modelProfileName: string | null,
  ): Promise<TenantRecord>;
  getTenantDeletionSummary(
    tenantKey: string,
  ): Promise<TenantDeletionSummary | null>;
  deleteTenantWithSummary(
    tenantKey: string,
  ): Promise<TenantDeletionSummary | null>;
  createOrGetInteractionJob(
    input: CreateInteractionJobInput,
  ): Promise<{ job: InteractionJobRecord; created: boolean }>;
  markJobInProgress(jobId: string): Promise<void>;
  markJobCompleted(jobId: string): Promise<void>;
  markJobQueued(
    jobId: string,
    retryCount: number,
    error: string,
  ): Promise<void>;
  markJobFailed(
    jobId: string,
    retryCount: number,
    error: string,
  ): Promise<void>;
  markJobCancelled(
    jobId: string,
    retryCount: number,
    reason: string,
  ): Promise<void>;
  createCodeReviewSnapshot(
    input: CreateCodeReviewSnapshotInput,
  ): Promise<CodeReviewSnapshotRecord>;
  createInteractionRun(
    input: CreateInteractionRunInput,
  ): Promise<InteractionRunRecord>;
  getLatestCompletedInteractionForCodeReview(
    tenantId: string,
    codeReviewId: number,
    currentInteractionJobId: string,
  ): Promise<PreviousCompletedInteractionRecord | null>;
  completeInteractionRun(
    interactionRunId: string,
    resultJson: string | null,
  ): Promise<void>;
  failInteractionRun(interactionRunId: string, error: string): Promise<void>;
  cancelInteractionRun(interactionRunId: string, reason: string): Promise<void>;
  upsertInteractionRunMetrics(
    input: UpsertInteractionRunMetricsInput,
  ): Promise<InteractionRunMetricsRecord>;
  replaceReviewFindings(
    interactionRunId: string,
    findings: CreateReviewFindingInput[],
  ): Promise<void>;
  listPriorReviewFindings(
    tenantId: string,
    codeReviewId: number,
    currentInteractionJobId: string,
  ): Promise<PriorReviewFindingRecord[]>;
  listLatestReviewFindings(
    tenantId: string,
    codeReviewId: number,
  ): Promise<PriorReviewFindingRecord[]>;
  updateReviewFindingStatus(
    tenantId: string,
    codeReviewId: number,
    identityKey: string,
    status: ReviewFindingStatus,
    options?: {
      currentStatuses?: readonly ReviewFindingStatus[] | undefined;
    },
  ): Promise<boolean>;
  upsertDiscussionMapping(
    input: UpsertDiscussionMappingInput,
  ): Promise<DiscussionMappingRecord>;
}

export function createStorageHelpers(stores: StorageStores): StorageHelpers {
  return new StoreBackedStorage(stores);
}

export class StoreBackedStorage implements StorageHelpers {
  public constructor(public readonly stores: StorageStores) {}

  public async upsertModelProfile(
    input: UpsertModelProfileInput,
  ): Promise<ModelProfileRecord> {
    const existing = await this.stores.modelProfiles.get(input.name);
    const resolved = resolveModelProfileUpsertInput(existing, input);
    const now = new Date().toISOString();

    if (resolved.isDefault) {
      const currentDefault = await this.stores.modelProfiles.find({
        isDefault: { eq: true },
      });
      if (currentDefault && currentDefault.name !== input.name) {
        await this.stores.modelProfiles.patch({
          id: currentDefault.name,
          value: { isDefault: false, updatedAt: now },
        });
      }
    }

    await this.stores.modelProfiles.upsert({
      name: input.name,
      providerBaseUrl: resolved.providerBaseUrl,
      providerType: resolved.providerType,
      wireApi: resolved.wireApi,
      authToken: resolved.authToken,
      reviewModel: resolved.reviewModel,
      textGenerationModel: resolved.textGenerationModel,
      isDefault: resolved.isDefault,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });

    return getRequiredRecord(
      this.stores.modelProfiles,
      input.name,
      `Failed to persist model profile ${input.name}`,
    );
  }

  public async setDefaultModelProfile(
    name: string | null,
  ): Promise<ModelProfileRecord | null> {
    const now = new Date().toISOString();
    const currentDefault = await this.stores.modelProfiles.find({
      isDefault: { eq: true },
    });
    if (currentDefault && currentDefault.name !== name) {
      await this.stores.modelProfiles.patch({
        id: currentDefault.name,
        value: { isDefault: false, updatedAt: now },
      });
    }

    if (name === null) {
      return null;
    }

    const target = await this.stores.modelProfiles.get(name);
    if (!target) {
      throw new Error(`Unknown model profile ${name}`);
    }

    await this.stores.modelProfiles.patch({
      id: name,
      value: { isDefault: true, updatedAt: now },
    });

    return getRequiredRecord(
      this.stores.modelProfiles,
      name,
      `Failed to update model profile ${name}`,
    );
  }

  public async deleteModelProfile(
    name: string,
  ): Promise<ModelProfileRecord | null> {
    const existing = await this.stores.modelProfiles.get(name);
    if (!existing) {
      return null;
    }

    const tenants = await listAll(this.stores.tenants, {
      filters: { modelProfileName: { eq: name } },
    });
    if (tenants.length > 0) {
      throw new Error(
        `Cannot delete model profile "${name}" because ${tenants.length} tenant(s) still reference it`,
      );
    }

    await this.stores.modelProfiles.delete(name);
    return existing;
  }

  public async upsertTenant(tenant: StorageTenantInput): Promise<TenantRecord> {
    const existing = await this.stores.tenants.find({
      key: { eq: tenant.key },
    });
    const resolvedModelProfileName =
      tenant.modelProfileName === undefined
        ? (existing?.modelProfileName ?? null)
        : tenant.modelProfileName;
    const platformConnection = await this.stores.platformConnections.get(
      existing?.platformConnectionId ?? tenant.platformConnectionId,
    );
    if (!platformConnection) {
      throw new Error(
        `Unknown platform connection ${tenant.platformConnectionId}`,
      );
    }
    if (platformConnection.platform !== tenant.platform) {
      throw new Error(
        `Platform connection ${platformConnection.name} uses ${platformConnection.platform}, expected ${tenant.platform}`,
      );
    }

    if (resolvedModelProfileName) {
      const modelProfile = await this.stores.modelProfiles.get(
        resolvedModelProfileName,
      );
      if (!modelProfile) {
        throw new Error(`Unknown model profile ${resolvedModelProfileName}`);
      }
    }

    const now = new Date().toISOString();
    const tenantId = existing?.id ?? createId("tenant");
    await this.stores.tenants.upsert({
      id: tenantId,
      key: tenant.key,
      platform: tenant.platform,
      platformConnectionId:
        existing?.platformConnectionId ?? tenant.platformConnectionId,
      platformConfigJson: tenant.platformConfigJson,
      modelProfileName: resolvedModelProfileName,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });

    return getRequiredRecord(
      this.stores.tenants,
      tenantId,
      `Failed to persist tenant ${tenant.key}`,
    );
  }

  public async createPlatformConnection(input: {
    name: string;
    platform: string;
    status: PlatformConnectionStatus;
    platformConnectionConfigJson: string;
  }): Promise<PlatformConnectionRecord> {
    if (
      await this.stores.platformConnections.find({ name: { eq: input.name } })
    ) {
      throw new Error(
        `Platform connection name "${input.name}" already exists`,
      );
    }
    const now = new Date().toISOString();
    const connection: PlatformConnectionRecord = {
      id: createId("connection"),
      ...input,
      createdAt: now,
      updatedAt: now,
    };
    await this.stores.platformConnections.upsert(connection);
    return getRequiredRecord(
      this.stores.platformConnections,
      connection.id,
      `Failed to create platform connection ${input.name}`,
    );
  }

  public async resolvePlatformConnection(
    reference: string,
  ): Promise<PlatformConnectionRecord | null> {
    return (
      (await this.stores.platformConnections.get(reference)) ??
      this.stores.platformConnections.find({ name: { eq: reference } })
    );
  }

  public async updatePlatformConnection(input: {
    reference: string;
    status: PlatformConnectionStatus;
    platformConnectionConfigJson: string;
  }): Promise<PlatformConnectionRecord> {
    const existing = await this.resolvePlatformConnection(input.reference);
    if (!existing) {
      throw new Error(`Platform connection ${input.reference} not found`);
    }
    await this.stores.platformConnections.patch({
      id: existing.id,
      value: {
        status: input.status,
        platformConnectionConfigJson: input.platformConnectionConfigJson,
        updatedAt: new Date().toISOString(),
      },
    });
    return getRequiredRecord(
      this.stores.platformConnections,
      existing.id,
      `Failed to update platform connection ${existing.name}`,
    );
  }

  public async deletePlatformConnection(
    reference: string,
  ): Promise<PlatformConnectionRecord | null> {
    const existing = await this.resolvePlatformConnection(reference);
    if (!existing) {
      return null;
    }
    const tenants = await listAll(this.stores.tenants, {
      filters: { platformConnectionId: { eq: existing.id } },
      order: [{ field: "key", direction: "asc" }],
    });
    if (tenants.length > 0) {
      throw new Error(
        `Cannot delete platform connection "${existing.name}"; used by tenants: ${tenants.map((tenant) => tenant.key).join(", ")}`,
      );
    }
    await this.stores.platformConnections.delete(existing.id);
    return existing;
  }

  public async setTenantModelProfile(
    tenantKey: string,
    modelProfileName: string | null,
  ): Promise<TenantRecord> {
    const tenant = await this.stores.tenants.find({
      key: { eq: tenantKey },
    });
    if (!tenant) {
      throw new Error(`Tenant not found for ${tenantKey}`);
    }

    if (modelProfileName) {
      const modelProfile =
        await this.stores.modelProfiles.get(modelProfileName);
      if (!modelProfile) {
        throw new Error(`Unknown model profile ${modelProfileName}`);
      }
    }

    await this.stores.tenants.patch({
      id: tenant.id,
      value: {
        modelProfileName,
        updatedAt: new Date().toISOString(),
      },
    });

    return getRequiredRecord(
      this.stores.tenants,
      tenant.id,
      `Failed to update tenant ${tenant.id}`,
    );
  }

  public async getTenantDeletionSummary(
    tenantKey: string,
  ): Promise<TenantDeletionSummary | null> {
    const tenant = await this.stores.tenants.find({
      key: { eq: tenantKey },
    });
    if (!tenant) {
      return null;
    }

    return this.buildTenantDeletionSummary(tenant);
  }

  public async deleteTenantWithSummary(
    tenantKey: string,
  ): Promise<TenantDeletionSummary | null> {
    const tenant = await this.stores.tenants.find({
      key: { eq: tenantKey },
    });
    if (!tenant) {
      return null;
    }

    const summary = await this.buildTenantDeletionSummary(tenant);

    await this.stores.discussionMappings.deleteMany(
      (
        await listAll(this.stores.discussionMappings, {
          filters: { tenantId: { eq: tenant.id } },
        })
      ).map((mapping) => mapping.id),
    );

    if (summary.interactionRunIds.length > 0) {
      await this.stores.interactionRunMetrics.deleteMany(
        (
          await listAll(this.stores.interactionRunMetrics, {
            filters: { interactionRunId: { in: summary.interactionRunIds } },
          })
        ).map((metrics) => metrics.id),
      );

      await this.stores.reviewFindings.deleteMany(
        (
          await listAll(this.stores.reviewFindings, {
            filters: { interactionRunId: { in: summary.interactionRunIds } },
          })
        ).map((finding) => finding.id),
      );
    }

    await this.stores.codeReviewSnapshots.deleteMany(
      (
        await listAll(this.stores.codeReviewSnapshots, {
          filters: { tenantId: { eq: tenant.id } },
        })
      ).map((snapshot) => snapshot.id),
    );
    await this.stores.interactionRuns.deleteMany(summary.interactionRunIds);
    await this.stores.interactionJobs.deleteMany(summary.interactionJobIds);
    await this.stores.tenants.delete(tenant.id);

    return summary;
  }

  public async createOrGetInteractionJob(
    input: CreateInteractionJobInput,
  ): Promise<{ job: InteractionJobRecord; created: boolean }> {
    const existing = await this.stores.interactionJobs.find({
      dedupeKey: { eq: input.dedupeKey },
    });
    if (existing) {
      return { job: existing, created: false };
    }

    const now = new Date().toISOString();
    const expectedId = createId("job");
    await this.stores.interactionJobs.upsert({
      id: expectedId,
      tenantId: input.tenantId,
      dedupeKey: input.dedupeKey,
      codeReviewId: input.codeReviewId,
      commentId: input.commentId,
      headSha: input.headSha,
      status: "queued",
      payloadJson: input.payloadJson,
      retryCount: 0,
      lastError: null,
      enqueuedAt: now,
      startedAt: null,
      finishedAt: null,
    });

    const job = await this.stores.interactionJobs.get(expectedId);

    if (!job) {
      throw new Error("Failed to create interaction job");
    }

    return {
      job,
      created: job.id === expectedId,
    };
  }

  public async markJobInProgress(jobId: string): Promise<void> {
    await this.stores.interactionJobs.patch({
      id: jobId,
      value: {
        status: "in_progress",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        lastError: null,
      },
    });
  }

  public async markJobCompleted(jobId: string): Promise<void> {
    await this.stores.interactionJobs.patch({
      id: jobId,
      value: {
        status: "completed",
        finishedAt: new Date().toISOString(),
        lastError: null,
      },
    });
  }

  public async markJobQueued(
    jobId: string,
    retryCount: number,
    error: string,
  ): Promise<void> {
    await this.stores.interactionJobs.patch({
      id: jobId,
      value: {
        status: "queued",
        retryCount,
        lastError: error,
        finishedAt: null,
      },
    });
  }

  public async markJobFailed(
    jobId: string,
    retryCount: number,
    error: string,
  ): Promise<void> {
    await this.stores.interactionJobs.patch({
      id: jobId,
      value: {
        status: "failed",
        retryCount,
        lastError: error,
        finishedAt: new Date().toISOString(),
      },
    });
  }

  public async markJobCancelled(
    jobId: string,
    retryCount: number,
    reason: string,
  ): Promise<void> {
    await this.stores.interactionJobs.patch({
      id: jobId,
      value: {
        status: "cancelled",
        retryCount,
        lastError: reason,
        finishedAt: new Date().toISOString(),
      },
    });
  }

  public async createCodeReviewSnapshot(
    input: CreateCodeReviewSnapshotInput,
  ): Promise<CodeReviewSnapshotRecord> {
    const now = new Date().toISOString();
    const snapshotId = createId("snapshot");
    await this.stores.codeReviewSnapshots.upsert({
      id: snapshotId,
      interactionJobId: input.interactionJobId,
      tenantId: input.tenantId,
      codeReviewId: input.codeReviewId,
      headSha: input.headSha,
      codeReviewJson: input.codeReviewJson,
      versionsJson: input.versionsJson,
      changesJson: input.changesJson,
      commentsJson: input.commentsJson,
      discussionsJson: input.discussionsJson,
      instructionsJson: input.instructionsJson,
      projectMemoryJson: input.projectMemoryJson,
      workspaceStrategy: input.workspaceStrategy,
      createdAt: now,
    });

    return getRequiredRecord(
      this.stores.codeReviewSnapshots,
      snapshotId,
      `Failed to create code review snapshot ${snapshotId}`,
    );
  }

  public async createInteractionRun(
    input: CreateInteractionRunInput,
  ): Promise<InteractionRunRecord> {
    const now = new Date().toISOString();
    const runId = createId("run");
    await this.stores.interactionRuns.upsert({
      id: runId,
      interactionJobId: input.interactionJobId,
      tenantId: input.tenantId,
      provider: input.provider,
      model: input.model,
      modelProfileName: input.modelProfileName,
      providerBaseUrl: input.providerBaseUrl,
      providerType: input.providerType,
      textGenerationModel: input.textGenerationModel,
      status: "in_progress",
      resultJson: null,
      error: null,
      startedAt: now,
      finishedAt: null,
    });

    return getRequiredRecord(
      this.stores.interactionRuns,
      runId,
      `Failed to create interaction run ${runId}`,
    );
  }

  public async getLatestCompletedInteractionForCodeReview(
    tenantId: string,
    codeReviewId: number,
    currentInteractionJobId: string,
  ): Promise<PreviousCompletedInteractionRecord | null> {
    const interactionJobs = (
      await listAll(this.stores.interactionJobs, {
        filters: {
          tenantId: { eq: tenantId },
          codeReviewId: { eq: codeReviewId },
        },
        order: [
          { field: "enqueuedAt", direction: "desc" },
          { field: "id", direction: "desc" },
        ],
      })
    ).filter((job) => job.id !== currentInteractionJobId);

    if (interactionJobs.length === 0) {
      return null;
    }

    const jobIds = interactionJobs.map((job) => job.id);
    const [interactionRuns, snapshots] = await Promise.all([
      listAll(this.stores.interactionRuns, {
        filters: {
          interactionJobId: { in: jobIds },
          status: { eq: "completed" },
          resultJson: { isNull: false },
        },
      }),
      listAll(this.stores.codeReviewSnapshots, {
        filters: { interactionJobId: { in: jobIds } },
        order: [{ field: "createdAt", direction: "desc" }],
      }),
    ]);

    const latestSnapshotByJobId = new Map<string, CodeReviewSnapshotRecord>();
    for (const snapshot of snapshots) {
      const existing = latestSnapshotByJobId.get(snapshot.interactionJobId);
      if (
        !existing ||
        compareIsoDesc(existing.createdAt, snapshot.createdAt) < 0
      ) {
        latestSnapshotByJobId.set(snapshot.interactionJobId, snapshot);
      }
    }

    const jobById = new Map(interactionJobs.map((job) => [job.id, job]));
    const bestRun = interactionRuns
      .filter((run) => latestSnapshotByJobId.has(run.interactionJobId))
      .toSorted((left, right) => {
        const timestampComparison = compareIsoDesc(
          left.finishedAt ?? left.startedAt,
          right.finishedAt ?? right.startedAt,
        );
        if (timestampComparison !== 0) {
          return timestampComparison;
        }

        const leftSnapshot = latestSnapshotByJobId.get(left.interactionJobId)!;
        const rightSnapshot = latestSnapshotByJobId.get(
          right.interactionJobId,
        )!;
        return compareIsoDesc(leftSnapshot.createdAt, rightSnapshot.createdAt);
      })[0];

    if (!bestRun?.finishedAt || bestRun.resultJson === null) {
      return null;
    }

    const interactionJob = jobById.get(bestRun.interactionJobId);
    const snapshot = latestSnapshotByJobId.get(bestRun.interactionJobId);
    if (!interactionJob || !snapshot) {
      return null;
    }

    return {
      interactionRunId: bestRun.id,
      interactionJobId: interactionJob.id,
      finishedAt: bestRun.finishedAt,
      headSha: interactionJob.headSha,
      resultJson: bestRun.resultJson,
      snapshot,
    };
  }

  public async completeInteractionRun(
    interactionRunId: string,
    resultJson: string | null,
  ): Promise<void> {
    await this.stores.interactionRuns.patch({
      id: interactionRunId,
      value: {
        status: "completed",
        resultJson,
        error: null,
        finishedAt: new Date().toISOString(),
      },
    });
  }

  public async failInteractionRun(
    interactionRunId: string,
    error: string,
  ): Promise<void> {
    await this.clearInteractionRunFindings(interactionRunId);
    await this.stores.interactionRuns.patch({
      id: interactionRunId,
      value: {
        status: "failed",
        error,
        finishedAt: new Date().toISOString(),
      },
    });
  }

  public async cancelInteractionRun(
    interactionRunId: string,
    reason: string,
  ): Promise<void> {
    await this.clearInteractionRunFindings(interactionRunId);
    await this.stores.interactionRuns.patch({
      id: interactionRunId,
      value: {
        status: "cancelled",
        error: reason,
        finishedAt: new Date().toISOString(),
      },
    });
  }

  public async upsertInteractionRunMetrics(
    input: UpsertInteractionRunMetricsInput,
  ): Promise<InteractionRunMetricsRecord> {
    const existing = await this.stores.interactionRunMetrics.find({
      interactionRunId: { eq: input.interactionRunId },
    });
    const now = new Date().toISOString();
    const metricsId = existing?.id ?? createId("metrics");

    await this.stores.interactionRunMetrics.upsert({
      id: metricsId,
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

    const metrics = await this.stores.interactionRunMetrics.find({
      interactionRunId: { eq: input.interactionRunId },
    });
    if (!metrics) {
      throw new Error(`Failed to persist interaction run metrics ${metricsId}`);
    }

    return metrics;
  }

  public async replaceReviewFindings(
    interactionRunId: string,
    findings: CreateReviewFindingInput[],
  ): Promise<void> {
    const existing = await listAll(this.stores.reviewFindings, {
      filters: { interactionRunId: { eq: interactionRunId } },
    });
    await this.stores.reviewFindings.deleteMany(
      existing.map((finding) => finding.id),
    );

    const now = new Date().toISOString();
    const latestFindingsByIdentity = new Map<
      string,
      CreateReviewFindingInput
    >();
    for (const finding of findings) {
      latestFindingsByIdentity.set(finding.identityKey, finding);
    }

    for (const finding of latestFindingsByIdentity.values()) {
      await this.stores.reviewFindings.upsert({
        id: createId("finding"),
        interactionRunId,
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
  }

  public async listPriorReviewFindings(
    tenantId: string,
    codeReviewId: number,
    currentInteractionJobId: string,
  ): Promise<PriorReviewFindingRecord[]> {
    return this.listLatestFindingsForCodeReview(
      tenantId,
      codeReviewId,
      currentInteractionJobId,
    );
  }

  public async listLatestReviewFindings(
    tenantId: string,
    codeReviewId: number,
  ): Promise<PriorReviewFindingRecord[]> {
    return this.listLatestFindingsForCodeReview(tenantId, codeReviewId);
  }

  public async updateReviewFindingStatus(
    tenantId: string,
    codeReviewId: number,
    identityKey: string,
    status: ReviewFindingStatus,
    options?: {
      currentStatuses?: readonly ReviewFindingStatus[] | undefined;
    },
  ): Promise<boolean> {
    const interactionJobs = await listAll(this.stores.interactionJobs, {
      filters: {
        tenantId: { eq: tenantId },
        codeReviewId: { eq: codeReviewId },
      },
    });
    if (interactionJobs.length === 0) {
      return false;
    }

    const interactionRuns = await listAll(this.stores.interactionRuns, {
      filters: {
        interactionJobId: { in: interactionJobs.map((job) => job.id) },
        status: { eq: "completed" },
      },
    });
    if (interactionRuns.length === 0) {
      return false;
    }

    const currentStatuses = options?.currentStatuses;
    const findings = await listAll(this.stores.reviewFindings, {
      filters: {
        interactionRunId: { in: interactionRuns.map((run) => run.id) },
        identityKey: { eq: identityKey },
        ...(currentStatuses && currentStatuses.length > 0
          ? {
              status: { in: currentStatuses },
            }
          : {}),
      },
    });
    if (findings.length === 0) {
      return false;
    }

    for (const finding of findings) {
      await this.stores.reviewFindings.patch({
        id: finding.id,
        value: { status },
      });
    }

    return true;
  }

  public async upsertDiscussionMapping(
    input: UpsertDiscussionMappingInput,
  ): Promise<DiscussionMappingRecord> {
    const existing = await this.stores.discussionMappings.find({
      tenantId: { eq: input.tenantId },
      codeReviewId: { eq: input.codeReviewId },
      platformDiscussionId: { eq: input.platformDiscussionId },
    });
    const now = new Date().toISOString();
    const mappingId = existing?.id ?? input.id ?? createId("mapping");

    await this.stores.discussionMappings.upsert({
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

    return getRequiredRecord(
      this.stores.discussionMappings,
      mappingId,
      `Failed to persist discussion mapping ${mappingId}`,
    );
  }

  private async clearInteractionRunFindings(
    interactionRunId: string,
  ): Promise<void> {
    const findings = await listAll(this.stores.reviewFindings, {
      filters: { interactionRunId: { eq: interactionRunId } },
    });
    await this.stores.reviewFindings.deleteMany(
      findings.map((finding) => finding.id),
    );
  }

  private async buildTenantDeletionSummary(
    tenant: TenantRecord,
  ): Promise<TenantDeletionSummary> {
    const [
      interactionJobs,
      codeReviewSnapshots,
      interactionRuns,
      discussionMappings,
    ] = await Promise.all([
      listAll(this.stores.interactionJobs, {
        filters: { tenantId: { eq: tenant.id } },
      }),
      listAll(this.stores.codeReviewSnapshots, {
        filters: { tenantId: { eq: tenant.id } },
      }),
      listAll(this.stores.interactionRuns, {
        filters: { tenantId: { eq: tenant.id } },
      }),
      listAll(this.stores.discussionMappings, {
        filters: { tenantId: { eq: tenant.id } },
      }),
    ]);

    const interactionRunIds = interactionRuns.map((run) => run.id);
    const [reviewFindings, interactionRunMetrics] =
      interactionRunIds.length === 0
        ? ([[], []] as const)
        : await Promise.all([
            listAll(this.stores.reviewFindings, {
              filters: { interactionRunId: { in: interactionRunIds } },
            }),
            listAll(this.stores.interactionRunMetrics, {
              filters: { interactionRunId: { in: interactionRunIds } },
            }),
          ]);

    return {
      tenant,
      interactionJobCount: interactionJobs.length,
      codeReviewSnapshotCount: codeReviewSnapshots.length,
      interactionRunCount: interactionRuns.length,
      reviewFindingCount: reviewFindings.length,
      interactionRunMetricCount: interactionRunMetrics.length,
      discussionMappingCount: discussionMappings.length,
      interactionJobIds: interactionJobs.map((job) => job.id),
      interactionRunIds,
    };
  }

  private async listLatestFindingsForCodeReview(
    tenantId: string,
    codeReviewId: number,
    excludeInteractionJobId?: string,
  ): Promise<PriorReviewFindingRecord[]> {
    const interactionJobs = (
      await listAll(this.stores.interactionJobs, {
        filters: {
          tenantId: { eq: tenantId },
          codeReviewId: { eq: codeReviewId },
        },
        order: [
          { field: "enqueuedAt", direction: "desc" },
          { field: "id", direction: "desc" },
        ],
      })
    ).filter((job) => job.id !== excludeInteractionJobId);

    if (interactionJobs.length === 0) {
      return [];
    }

    const interactionRuns = await listAll(this.stores.interactionRuns, {
      filters: {
        interactionJobId: { in: interactionJobs.map((job) => job.id) },
        status: { eq: "completed" },
      },
    });
    if (interactionRuns.length === 0) {
      return [];
    }

    const findings = await listAll(this.stores.reviewFindings, {
      filters: {
        interactionRunId: { in: interactionRuns.map((run) => run.id) },
      },
    });
    const runById = new Map(interactionRuns.map((run) => [run.id, run]));
    const jobById = new Map(interactionJobs.map((job) => [job.id, job]));

    const latestByIdentity = new Map<
      string,
      { finding: ReviewFindingRecord; reviewedAt: string; headSha: string }
    >();
    for (const finding of findings) {
      const run = runById.get(finding.interactionRunId);
      if (!run) {
        continue;
      }

      const job = jobById.get(run.interactionJobId);
      if (!job) {
        continue;
      }

      const reviewedAt = run.finishedAt ?? run.startedAt;
      const current = latestByIdentity.get(finding.identityKey);
      if (
        !current ||
        compareFindingPreference({ finding, reviewedAt }, current) < 0
      ) {
        latestByIdentity.set(finding.identityKey, {
          finding,
          reviewedAt,
          headSha: job.headSha,
        });
      }
    }

    return [...latestByIdentity.values()]
      .map(({ finding, reviewedAt, headSha }) => ({
        findingId: finding.id,
        identityKey: finding.identityKey,
        status: finding.status,
        title: finding.title,
        body: finding.body,
        severity: finding.severity,
        category: finding.category,
        anchor: parseJson<ReviewAnchor>(finding.anchorJson),
        suggestion: parseJson<ReviewSuggestion>(finding.suggestionJson),
        interactionRunId: finding.interactionRunId,
        reviewedAt,
        headSha,
      }))
      .toSorted((left, right) => {
        const statusComparison = compareFinalFindingStatus(
          left.status,
          right.status,
        );
        if (statusComparison !== 0) {
          return statusComparison;
        }

        const reviewedAtComparison = compareIsoDesc(
          left.reviewedAt,
          right.reviewedAt,
        );
        if (reviewedAtComparison !== 0) {
          return reviewedAtComparison;
        }

        return left.findingId.localeCompare(right.findingId);
      });
  }
}

export async function listAll<TEntity, TFilters, TOrder extends string>(
  store: EntityStore<TEntity, TFilters, TOrder>,
  input?: {
    filters?: TFilters;
    order?: readonly StoreListOrder<TOrder>[];
  },
): Promise<TEntity[]> {
  const results: TEntity[] = [];
  for (let page = 1; ; page += 1) {
    const batch = await store.list({
      ...(input?.filters ? { filters: input.filters } : {}),
      ...(input?.order ? { order: input.order } : {}),
      page,
      pageSize: DEFAULT_PAGE_SIZE,
    });
    results.push(...batch);

    if (batch.length < DEFAULT_PAGE_SIZE) {
      return results;
    }
  }
}

async function getRequiredRecord<TEntity, TFilters, TOrder extends string>(
  store: EntityStore<TEntity, TFilters, TOrder>,
  id: string,
  errorMessage: string,
): Promise<TEntity> {
  const record = await store.get(id);
  if (!record) {
    throw new Error(errorMessage);
  }

  return record;
}

function parseJson<T>(value: string | null): T | null {
  if (!value) {
    return null;
  }

  return JSON.parse(value) as T;
}

function compareFindingPreference(
  left: { finding: ReviewFindingRecord; reviewedAt: string },
  right: { finding: ReviewFindingRecord; reviewedAt: string },
): number {
  const reviewedAtComparison = compareIsoDesc(
    left.reviewedAt,
    right.reviewedAt,
  );
  if (reviewedAtComparison !== 0) {
    return reviewedAtComparison;
  }

  const statusComparison = comparePreferredLatestStatus(
    left.finding.status,
    right.finding.status,
  );
  if (statusComparison !== 0) {
    return statusComparison;
  }

  const createdAtComparison = compareIsoDesc(
    left.finding.createdAt,
    right.finding.createdAt,
  );
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  return left.finding.id.localeCompare(right.finding.id);
}

function comparePreferredLatestStatus(
  left: ReviewFindingStatus,
  right: ReviewFindingStatus,
): number {
  return statusRankForLatest(left) - statusRankForLatest(right);
}

function compareFinalFindingStatus(
  left: ReviewFindingStatus,
  right: ReviewFindingStatus,
): number {
  return statusRankForResult(left) - statusRankForResult(right);
}

function statusRankForLatest(status: ReviewFindingStatus): number {
  switch (status) {
    case "dismissed":
      return 0;
    case "resolved":
      return 1;
    default:
      return 2;
  }
}

function statusRankForResult(status: ReviewFindingStatus): number {
  switch (status) {
    case "open":
      return 0;
    case "dismissed":
      return 1;
    default:
      return 2;
  }
}

function compareIsoDesc(left: string, right: string): number {
  return new Date(right).getTime() - new Date(left).getTime();
}

function resolveModelProfileUpsertInput(
  existing: ModelProfileRecord | null,
  input: UpsertModelProfileInput,
): {
  name: string;
  providerBaseUrl: string | null;
  providerType: "openai" | "azure" | "anthropic" | null;
  wireApi: "completions" | "responses" | null;
  authToken: string | null;
  reviewModel: string | null;
  textGenerationModel: string | null;
  isDefault: boolean;
} {
  const providerBaseUrl = resolveDefined(
    input.providerBaseUrl,
    existing?.providerBaseUrl ?? null,
  );
  let providerType = resolveDefined(
    input.providerType,
    existing?.providerType ?? null,
  );

  if (providerBaseUrl === null && input.providerType === undefined) {
    providerType = null;
  }

  const resolved = {
    name: input.name,
    providerBaseUrl,
    providerType,
    wireApi: resolveDefined(input.wireApi, existing?.wireApi ?? null),
    authToken: resolveDefined(input.authToken, existing?.authToken ?? null),
    reviewModel: resolveDefined(
      input.reviewModel,
      existing?.reviewModel ?? null,
    ),
    textGenerationModel: resolveDefined(
      input.textGenerationModel,
      existing?.textGenerationModel ?? null,
    ),
    isDefault: resolveDefined(input.isDefault, existing?.isDefault ?? false),
  };

  if (!resolved.providerBaseUrl && resolved.providerType) {
    throw new Error("provider type requires --base-url");
  }

  if (!resolved.providerBaseUrl && resolved.wireApi) {
    throw new Error("wire api requires --base-url");
  }

  if (resolved.providerBaseUrl && !resolved.reviewModel) {
    throw new Error("custom providers require --review-model");
  }

  return resolved;
}
