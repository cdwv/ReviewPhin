export interface ReviewAnchor {
  path: string;
  oldPath?: string | undefined;
  startLine: number;
  endLine: number;
  side: "new" | "old";
}

export interface ReviewSuggestion {
  replacement: string;
  startLine: number;
  endLine: number;
}

export interface TenantRecord {
  id: string;
  key: string;
  platform: string;
  platformConfigJson: string;
  modelProfileName: string | null;
  createdAt: string;
  updatedAt: string;
}

export type StorageTenantInput = Pick<
  TenantRecord,
  "key" | "platform" | "platformConfigJson"
> & {
  modelProfileName?: string | null;
};

export interface ModelProfileRecord {
  name: string;
  providerBaseUrl: string | null;
  providerType: "openai" | "azure" | "anthropic" | null;
  wireApi: "completions" | "responses" | null;
  authToken: string | null;
  reviewModel: string | null;
  textGenerationModel: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export type UpsertModelProfileInput = Pick<ModelProfileRecord, "name"> &
  Partial<
    Pick<
      ModelProfileRecord,
      | "providerBaseUrl"
      | "providerType"
      | "wireApi"
      | "authToken"
      | "reviewModel"
      | "textGenerationModel"
      | "isDefault"
    >
  >;

export interface TenantDeletionSummary {
  tenant: TenantRecord;
  interactionJobCount: number;
  codeReviewSnapshotCount: number;
  interactionRunCount: number;
  reviewFindingCount: number;
  interactionRunMetricCount: number;
  discussionMappingCount: number;
  interactionJobIds: string[];
  interactionRunIds: string[];
}

export type InteractionJobStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export interface InteractionJobRecord {
  id: string;
  tenantId: string;
  dedupeKey: string;
  codeReviewId: number;
  noteId: number;
  headSha: string;
  status: InteractionJobStatus;
  payloadJson: string;
  retryCount: number;
  lastError: string | null;
  enqueuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type CreateInteractionJobInput = Omit<
  InteractionJobRecord,
  | "id"
  | "status"
  | "retryCount"
  | "lastError"
  | "enqueuedAt"
  | "startedAt"
  | "finishedAt"
>;

export interface CodeReviewSnapshotRecord {
  id: string;
  interactionJobId: string;
  tenantId: string;
  codeReviewId: number;
  headSha: string;
  codeReviewJson: string;
  versionsJson: string;
  changesJson: string;
  notesJson: string;
  discussionsJson: string;
  instructionsJson: string;
  projectMemoryJson: string | null;
  workspaceStrategy: string;
  createdAt: string;
}

export type CreateCodeReviewSnapshotInput = Omit<
  CodeReviewSnapshotRecord,
  "id" | "createdAt"
>;

export type InteractionRunStatus =
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export interface InteractionRunRecord {
  id: string;
  interactionJobId: string;
  tenantId: string;
  provider: string;
  model: string | null;
  modelProfileName: string | null;
  providerBaseUrl: string | null;
  providerType: "openai" | "azure" | "anthropic" | null;
  textGenerationModel: string | null;
  status: InteractionRunStatus;
  resultJson: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export type CreateInteractionRunInput = Omit<
  InteractionRunRecord,
  "id" | "status" | "resultJson" | "error" | "startedAt" | "finishedAt"
>;

export interface InteractionRunMetricsRecord {
  id: string;
  interactionRunId: string;
  triggerKind: string | null;
  promptMode: string | null;
  promptChars: number;
  promptContextChangedFiles: number;
  promptContextPriorThreads: number;
  promptContextNotes: number;
  assistantTurns: number;
  assistantCalls: number;
  toolExecutions: number;
  viewToolCalls: number;
  globToolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  apiDurationMs: number;
  premiumRequests: number;
  repeatedViewReads: number;
  repeatedViewPathsJson: string;
  createdAt: string;
  updatedAt: string;
}

export type UpsertInteractionRunMetricsInput = Omit<
  InteractionRunMetricsRecord,
  "id" | "createdAt" | "updatedAt"
>;

export type ReviewFindingStatus = "open" | "resolved" | "dismissed";

export interface ReviewFindingRecord {
  id: string;
  interactionRunId: string;
  identityKey: string;
  severity: string;
  category: string;
  title: string;
  body: string;
  anchorJson: string | null;
  suggestionJson: string | null;
  status: ReviewFindingStatus;
  createdAt: string;
}

export type CreateReviewFindingInput = Omit<
  ReviewFindingRecord,
  "id" | "createdAt"
>;

export interface PriorReviewFindingRecord {
  findingId: string;
  identityKey: string;
  status: ReviewFindingStatus;
  title: string;
  body: string;
  severity: string;
  category: string;
  anchor: ReviewAnchor | null;
  suggestion: ReviewSuggestion | null;
  interactionRunId: string;
  reviewedAt: string;
  headSha: string;
}

export interface PreviousCompletedInteractionRecord {
  interactionRunId: string;
  interactionJobId: string;
  finishedAt: string;
  headSha: string;
  resultJson: string;
  snapshot: CodeReviewSnapshotRecord;
}

export type DiscussionMappingStatus = "open" | "resolved";

export interface DiscussionMappingRecord {
  id: string;
  tenantId: string;
  codeReviewId: number;
  identityKey: string;
  findingFingerprint: string;
  title: string;
  severity: string;
  category: string;
  body: string;
  platformThreadId: string;
  platformCommentId: number;
  anchorJson: string | null;
  positionJson: string | null;
  botDiscussion: boolean;
  botNote: boolean;
  noteAuthorId: number | null;
  noteAuthorUsername: string | null;
  status: DiscussionMappingStatus;
  lastInteractionRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type UpsertDiscussionMappingInput = Partial<
  Pick<DiscussionMappingRecord, "id">
> &
  Omit<DiscussionMappingRecord, "id" | "createdAt" | "updatedAt">;

export type SortDirection = "asc" | "desc";

export interface StoreValueFilter<TValue> {
  eq?: TValue;
  neq?: TValue;
  in?: readonly TValue[];
  notIn?: readonly TValue[];
  isNull?: boolean;
}

export type StoreFilters<TEntity, TKeys extends keyof TEntity> = Partial<{
  [TKey in TKeys]: StoreValueFilter<TEntity[TKey]>;
}>;

export interface StoreListOrder<TField extends string> {
  readonly field: TField;
  readonly direction: SortDirection;
}

export interface StoreListInput<TFilters, TOrder extends string> {
  readonly filters?: TFilters;
  readonly order?: readonly StoreListOrder<TOrder>[];
  readonly page: number;
  readonly pageSize: number;
}

export interface StoreUpdateInput<TEntity> {
  readonly id: string;
  readonly value: TEntity;
}

export interface StorePatchInput<TEntity> {
  readonly id: string;
  readonly value: Partial<TEntity>;
}

export interface EntityStore<TEntity, TFilters, TOrder extends string> {
  get(id: string): Promise<TEntity | null>;
  getMany(ids: string[]): Promise<TEntity[]>;
  find(filters: TFilters): Promise<TEntity | null>;
  list(input: StoreListInput<TFilters, TOrder>): Promise<TEntity[]>;
  upsert(entity: TEntity): Promise<void>;
  upsertMany(entities: TEntity[]): Promise<void>;
  replace(entity: TEntity): Promise<void>;
  replaceMany(entities: TEntity[]): Promise<void>;
  update(input: StoreUpdateInput<TEntity>): Promise<void>;
  updateMany(inputs: StoreUpdateInput<TEntity>[]): Promise<void>;
  patch(input: StorePatchInput<TEntity>): Promise<void>;
  patchMany(inputs: StorePatchInput<TEntity>[]): Promise<void>;
  delete(id: string): Promise<void>;
  deleteMany(ids: string[]): Promise<void>;
}

export type ModelProfileQueryField =
  | "name"
  | "isDefault"
  | "createdAt"
  | "updatedAt";

export type ModelProfileFilters = StoreFilters<
  ModelProfileRecord,
  ModelProfileQueryField
>;

export type ModelProfileOrderField = ModelProfileQueryField;

export type TenantQueryField =
  | "id"
  | "key"
  | "platform"
  | "modelProfileName"
  | "createdAt"
  | "updatedAt";

export type TenantFilters = StoreFilters<TenantRecord, TenantQueryField>;

export type TenantOrderField = TenantQueryField;

export type InteractionJobQueryField =
  | "id"
  | "tenantId"
  | "dedupeKey"
  | "codeReviewId"
  | "status"
  | "enqueuedAt"
  | "startedAt"
  | "finishedAt";

export type InteractionJobFilters = StoreFilters<
  InteractionJobRecord,
  InteractionJobQueryField
>;

export type InteractionJobOrderField = InteractionJobQueryField;

export type CodeReviewSnapshotQueryField =
  | "id"
  | "interactionJobId"
  | "tenantId"
  | "codeReviewId"
  | "createdAt";

export type CodeReviewSnapshotFilters = StoreFilters<
  CodeReviewSnapshotRecord,
  CodeReviewSnapshotQueryField
>;

export type CodeReviewSnapshotOrderField = CodeReviewSnapshotQueryField;

export type InteractionRunQueryField =
  | "id"
  | "interactionJobId"
  | "tenantId"
  | "status"
  | "resultJson"
  | "startedAt"
  | "finishedAt";

export type InteractionRunFilters = StoreFilters<
  InteractionRunRecord,
  InteractionRunQueryField
>;

export type InteractionRunOrderField = InteractionRunQueryField;

export type InteractionRunMetricsQueryField =
  | "id"
  | "interactionRunId"
  | "createdAt"
  | "updatedAt";

export type InteractionRunMetricsFilters = StoreFilters<
  InteractionRunMetricsRecord,
  InteractionRunMetricsQueryField
>;

export type InteractionRunMetricsOrderField = InteractionRunMetricsQueryField;

export type ReviewFindingQueryField =
  | "id"
  | "interactionRunId"
  | "identityKey"
  | "status"
  | "createdAt";

export type ReviewFindingFilters = StoreFilters<
  ReviewFindingRecord,
  ReviewFindingQueryField
>;

export type ReviewFindingOrderField = ReviewFindingQueryField;

export type DiscussionMappingQueryField =
  | "id"
  | "tenantId"
  | "codeReviewId"
  | "platformThreadId"
  | "identityKey"
  | "status"
  | "updatedAt"
  | "createdAt";

export type DiscussionMappingFilters = StoreFilters<
  DiscussionMappingRecord,
  DiscussionMappingQueryField
>;

export type DiscussionMappingOrderField = DiscussionMappingQueryField;

export type ModelProfileStore = EntityStore<
  ModelProfileRecord,
  ModelProfileFilters,
  ModelProfileOrderField
>;
export type TenantStore = EntityStore<
  TenantRecord,
  TenantFilters,
  TenantOrderField
>;
export type InteractionJobStore = EntityStore<
  InteractionJobRecord,
  InteractionJobFilters,
  InteractionJobOrderField
>;
export type CodeReviewSnapshotStore = EntityStore<
  CodeReviewSnapshotRecord,
  CodeReviewSnapshotFilters,
  CodeReviewSnapshotOrderField
>;
export type InteractionRunStore = EntityStore<
  InteractionRunRecord,
  InteractionRunFilters,
  InteractionRunOrderField
>;
export type InteractionRunMetricsStore = EntityStore<
  InteractionRunMetricsRecord,
  InteractionRunMetricsFilters,
  InteractionRunMetricsOrderField
>;
export type ReviewFindingStore = EntityStore<
  ReviewFindingRecord,
  ReviewFindingFilters,
  ReviewFindingOrderField
>;
export type DiscussionMappingStore = EntityStore<
  DiscussionMappingRecord,
  DiscussionMappingFilters,
  DiscussionMappingOrderField
>;

export interface StorageStores {
  readonly modelProfiles: ModelProfileStore;
  readonly tenants: TenantStore;
  readonly interactionJobs: InteractionJobStore;
  readonly codeReviewSnapshots: CodeReviewSnapshotStore;
  readonly interactionRuns: InteractionRunStore;
  readonly interactionRunMetrics: InteractionRunMetricsStore;
  readonly reviewFindings: ReviewFindingStore;
  readonly discussionMappings: DiscussionMappingStore;
}
