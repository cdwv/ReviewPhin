import type {
  CreateInteractionJobInput,
  EntityStore,
  InteractionJobFilters,
  InteractionJobOrderField,
  InteractionRunFilters,
  InteractionRunOrderField,
  ModelProfileFilters,
  ModelProfileOrderField,
  InteractionJobRecord as PreviousJob,
  InteractionJobStore as PreviousJobStore,
  InteractionRunRecord as PreviousRun,
  ModelProfileRecord as PreviousProfile,
  ModelReasoningEffort,
  StorageStores as PreviousStores,
  StoreFilters,
  UpsertModelProfileInput as PreviousProfileInput,
} from "./storage-v006.js";

export * from "./storage-v006.js";

export interface InteractionRequestRecord {
  id: string;
  tenantId: string;
  codeReviewId: number;
  dedupeKey: string;
  interactionJobId: string | null;
  commentId: number | null;
  triggerJson: string;
  payloadJson: string;
  headSha: string;
  receivedAt: string;
  admittedAt: string | null;
  /** Original admission settings also survive an interrupted remote write. */
  debounceMs: number;
}
export type InteractionRequestQueryField = keyof InteractionRequestRecord;
export type InteractionRequestFilters = StoreFilters<
  InteractionRequestRecord,
  InteractionRequestQueryField
>;
export type InteractionRequestStore = EntityStore<
  InteractionRequestRecord,
  InteractionRequestFilters,
  InteractionRequestQueryField
>;

export interface InteractionJobRecord extends PreviousJob {
  batchKind: "comment" | null;
}
export interface InteractionRunRecord extends PreviousRun {
  repliesJson: string | null;
}
export interface ModelProfileRecord extends PreviousProfile {
  routingModel: string | null;
  routingReasoningEffort: ModelReasoningEffort | null;
}
export type UpsertModelProfileInput = PreviousProfileInput & {
  routingModel?: string | null;
  routingReasoningEffort?: ModelReasoningEffort | null;
};

export interface AdmitInteractionInput {
  request: CreateInteractionJobInput;
  now: string;
  debounceMs: number;
}
export interface AdmitInteractionResult {
  job: InteractionJobRecord;
  request: InteractionRequestRecord;
  outcome: "created" | "appended" | "duplicate";
}
export interface InteractionJobStore
  extends
    Omit<
      PreviousJobStore,
      | "get"
      | "getMany"
      | "find"
      | "list"
      | "upsert"
      | "upsertMany"
      | "replace"
      | "replaceMany"
      | "update"
      | "updateMany"
      | "patch"
      | "patchMany"
      | "claimNext"
      | "createInteractionRunForClaim"
      | "reconcileOrphanedInteractionRuns"
    >,
    EntityStore<
      InteractionJobRecord,
      InteractionJobFilters,
      InteractionJobOrderField
    > {
  claimNext(
    input: Parameters<PreviousJobStore["claimNext"]>[0],
  ): Promise<InteractionJobRecord | null>;
  createInteractionRunForClaim(
    input: Parameters<PreviousJobStore["createInteractionRunForClaim"]>[0],
  ): Promise<InteractionRunRecord | null>;
  reconcileOrphanedInteractionRuns(
    input: Parameters<PreviousJobStore["reconcileOrphanedInteractionRuns"]>[0],
  ): Promise<InteractionRunRecord[]>;
  admitInteractionTrigger(
    input: AdmitInteractionInput,
  ): Promise<AdmitInteractionResult>;
  setInteractionJobHeadForClaim(input: {
    jobId: string;
    claimToken: string;
    headSha: string;
  }): Promise<boolean>;
  saveInteractionRunRepliesForClaim(input: {
    jobId: string;
    claimToken: string;
    interactionRunId: string;
    repliesJson: string;
  }): Promise<boolean>;
}

export type InteractionRunStore = EntityStore<
  InteractionRunRecord,
  InteractionRunFilters,
  InteractionRunOrderField
>;
export type ModelProfileStore = EntityStore<
  ModelProfileRecord,
  ModelProfileFilters,
  ModelProfileOrderField
>;

export interface StorageStores extends Omit<
  PreviousStores,
  "interactionJobs" | "interactionRuns" | "modelProfiles"
> {
  readonly interactionJobs: InteractionJobStore;
  readonly interactionRequests: InteractionRequestStore;
  readonly interactionRuns: InteractionRunStore;
  readonly modelProfiles: ModelProfileStore;
}
