import type {
  CodeReviewSnapshotFilters,
  CodeReviewSnapshotOrderField,
  CodeReviewSnapshotRecord as V004CodeReviewSnapshotRecord,
  CreateCodeReviewSnapshotInput as V004CreateCodeReviewSnapshotInput,
  CreateInteractionJobInput as V004CreateInteractionJobInput,
  CreateInteractionRunInput as V004CreateInteractionRunInput,
  CreateReviewFindingInput,
  DiscussionMappingRecord,
  EntityStore,
  InteractionJobOrderField,
  InteractionJobQueryField,
  InteractionJobRecord as V004InteractionJobRecord,
  InteractionRunFilters,
  InteractionRunOrderField,
  InteractionRunRecord as V004InteractionRunRecord,
  ModelProfileFilters,
  ModelProfileOrderField,
  ModelProfileRecord as V004ModelProfileRecord,
  PreviousCompletedInteractionRecord as V004PreviousCompletedInteractionRecord,
  ReviewFindingStatus,
  StoreFilters,
  StorageStores as V004StorageStores,
  UpsertDiscussionMappingInput,
  UpsertInteractionRunMetricsInput,
  UpsertModelProfileInput as V004UpsertModelProfileInput,
} from "./storage-v004.js";

export * from "./storage-v004.js";

export type ModelReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type InteractionJobStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export interface InteractionJobRecord
  extends Omit<V004InteractionJobRecord, "status"> {
  status: InteractionJobStatus;
  availableAt: string;
  claimToken: string | null;
  claimedBy: string | null;
  claimExpiresAt: string | null;
  latestInteractionRunId: string | null;
}

export type CreateInteractionJobInput = V004CreateInteractionJobInput;

export type InteractionJobFilters = StoreFilters<
  InteractionJobRecord,
  InteractionJobQueryField
>;

export type InteractionJobClaimMode = "atomic" | "single-worker";

export interface InteractionJobStore
  extends EntityStore<
    InteractionJobRecord,
    InteractionJobFilters,
    InteractionJobOrderField
  > {
  readonly claimMode: InteractionJobClaimMode;

  claimNext(input: {
    workerId: string;
    claimToken: string;
    now: string;
    claimExpiresAt: string;
    queuedAfter: string;
    maxJobRetries: number;
  }): Promise<InteractionJobRecord | null>;

  expireQueued(input: {
    now: string;
    queuedBefore: string;
    reason: string;
    limit: number;
  }): Promise<number>;

  renewClaim(input: {
    jobId: string;
    claimToken: string;
    now: string;
    claimExpiresAt: string;
  }): Promise<boolean>;

  transitionClaim(input: {
    jobId: string;
    claimToken: string;
    status: "queued" | "completed" | "failed" | "cancelled";
    retryCount: number;
    lastError: string | null;
    availableAt: string;
    finishedAt: string | null;
  }): Promise<boolean>;

  createInteractionRunForClaim(input: {
    jobId: string;
    claimToken: string;
    run: CreateInteractionRunInput;
  }): Promise<InteractionRunRecord | null>;

  transitionInteractionRunForClaim(input: {
    jobId: string;
    claimToken: string;
    interactionRunId: string;
    status: "completed" | "failed" | "cancelled";
    resultJson: string | null;
    error: string | null;
    finishedAt: string;
  }): Promise<boolean>;

  replaceReviewFindingsForClaim(input: {
    jobId: string;
    claimToken: string;
    interactionRunId: string;
    findings: CreateReviewFindingInput[];
  }): Promise<boolean>;

  upsertInteractionRunMetricsForClaim(input: {
    jobId: string;
    claimToken: string;
    interactionRunId: string;
    metrics: UpsertInteractionRunMetricsInput;
  }): Promise<boolean>;

  createCodeReviewSnapshotForClaim(input: {
    jobId: string;
    claimToken: string;
    interactionRunId: string;
    snapshot: CreateCodeReviewSnapshotInput;
  }): Promise<CodeReviewSnapshotRecord | null>;

  updateReviewFindingStatusForClaim(input: {
    jobId: string;
    claimToken: string;
    interactionRunId: string;
    tenantId: string;
    codeReviewId: number;
    identityKey: string;
    status: ReviewFindingStatus;
    currentStatuses?: readonly ReviewFindingStatus[];
  }): Promise<boolean>;

  upsertDiscussionMappingForClaim(input: {
    jobId: string;
    claimToken: string;
    mapping: UpsertDiscussionMappingInput;
  }): Promise<DiscussionMappingRecord | null>;

  reconcileOrphanedInteractionRuns(input: {
    now: string;
    limit: number;
  }): Promise<InteractionRunRecord[]>;
}

export interface ModelProfileRecord extends V004ModelProfileRecord {
  reviewReasoningEffort: ModelReasoningEffort | null;
  textGenerationReasoningEffort: ModelReasoningEffort | null;
}

export type UpsertModelProfileInput = V004UpsertModelProfileInput & {
  reviewReasoningEffort?: ModelReasoningEffort | null;
  textGenerationReasoningEffort?: ModelReasoningEffort | null;
};

export interface InteractionRunRecord extends V004InteractionRunRecord {
  interactionJobClaimToken: string | null;
  reviewReasoningEffort: ModelReasoningEffort | null;
  textGenerationReasoningEffort: ModelReasoningEffort | null;
}

export type CreateInteractionRunInput = V004CreateInteractionRunInput & {
  interactionJobClaimToken?: string | null;
  reviewReasoningEffort?: ModelReasoningEffort | null;
  textGenerationReasoningEffort?: ModelReasoningEffort | null;
};

export interface CodeReviewSnapshotRecord
  extends V004CodeReviewSnapshotRecord {
  interactionRunId: string | null;
}

export type CreateCodeReviewSnapshotInput = V004CreateCodeReviewSnapshotInput & {
  interactionRunId?: string | null;
};

export interface PreviousCompletedInteractionRecord
  extends Omit<V004PreviousCompletedInteractionRecord, "snapshot"> {
  snapshot: CodeReviewSnapshotRecord;
}

export type ModelProfileStore = EntityStore<
  ModelProfileRecord,
  ModelProfileFilters,
  ModelProfileOrderField
>;

export type InteractionRunStore = EntityStore<
  InteractionRunRecord,
  InteractionRunFilters,
  InteractionRunOrderField
>;

export type CodeReviewSnapshotStore = EntityStore<
  CodeReviewSnapshotRecord,
  CodeReviewSnapshotFilters,
  CodeReviewSnapshotOrderField
>;

export interface StorageStores
  extends Omit<
    V004StorageStores,
    | "interactionJobs"
    | "modelProfiles"
    | "interactionRuns"
    | "codeReviewSnapshots"
  > {
  readonly interactionJobs: InteractionJobStore;
  readonly modelProfiles: ModelProfileStore;
  readonly interactionRuns: InteractionRunStore;
  readonly codeReviewSnapshots: CodeReviewSnapshotStore;
}
