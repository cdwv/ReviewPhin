import type { TenantConfig } from "../config.js";
import type { ReviewAnchor, ReviewSuggestion } from "../review/types.js";

export interface TenantRecord {
  id: string;
  key: string;
  baseUrl: string;
  projectId: number;
  apiToken: string;
  webhookSecret: string;
  botUserId: number | null;
  botUsername: string | null;
  modelProfileName: string | null;
  createdAt: string;
  updatedAt: string;
}

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

export interface UpsertModelProfileInput {
  name: string;
  providerBaseUrl?: string | null | undefined;
  providerType?: "openai" | "azure" | "anthropic" | null | undefined;
  wireApi?: "completions" | "responses" | null | undefined;
  authToken?: string | null | undefined;
  reviewModel?: string | null | undefined;
  textGenerationModel?: string | null | undefined;
  isDefault?: boolean | undefined;
}

export interface TenantDeletionSummary {
  tenant: TenantRecord;
  interactionJobCount: number;
  mergeRequestSnapshotCount: number;
  interactionRunCount: number;
  reviewFindingCount: number;
  interactionRunMetricCount: number;
  discussionMappingCount: number;
  interactionJobIds: string[];
  interactionRunIds: string[];
}

export type InteractionJobStatus = "queued" | "in_progress" | "completed" | "failed";

export interface InteractionJobRecord {
  id: string;
  tenantId: string;
  dedupeKey: string;
  projectId: number;
  mergeRequestIid: number;
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

export interface CreateInteractionJobInput {
  tenantId: string;
  dedupeKey: string;
  projectId: number;
  mergeRequestIid: number;
  noteId: number;
  headSha: string;
  payloadJson: string;
}

export interface MergeRequestSnapshotRecord {
  id: string;
  interactionJobId: string;
  tenantId: string;
  mergeRequestIid: number;
  headSha: string;
  mergeRequestJson: string;
  versionsJson: string;
  changesJson: string;
  notesJson: string;
  discussionsJson: string;
  instructionsJson: string;
  projectMemoryJson: string | null;
  workspaceStrategy: string;
  createdAt: string;
}

export interface CreateMergeRequestSnapshotInput {
  interactionJobId: string;
  tenantId: string;
  mergeRequestIid: number;
  headSha: string;
  mergeRequestJson: string;
  versionsJson: string;
  changesJson: string;
  notesJson: string;
  discussionsJson: string;
  instructionsJson: string;
  projectMemoryJson: string | null;
  workspaceStrategy: string;
}

export type InteractionRunStatus = "in_progress" | "completed" | "failed";

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

export interface CreateInteractionRunInput {
  interactionJobId: string;
  tenantId: string;
  provider: string;
  model: string | null;
  modelProfileName: string | null;
  providerBaseUrl: string | null;
  providerType: "openai" | "azure" | "anthropic" | null;
  textGenerationModel: string | null;
}

export interface UpsertInteractionRunMetricsInput {
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
}

export interface PreviousCompletedInteractionRecord {
  interactionRunId: string;
  interactionJobId: string;
  finishedAt: string;
  headSha: string;
  resultJson: string;
  snapshot: MergeRequestSnapshotRecord;
}

export type ReviewFindingStatus = "open" | "resolved" | "dismissed";

export interface CreateReviewFindingInput {
  interactionRunId: string;
  identityKey: string;
  severity: string;
  category: string;
  title: string;
  body: string;
  anchorJson: string | null;
  suggestionJson: string | null;
  status: ReviewFindingStatus;
}

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

export type DiscussionMappingStatus = "open" | "resolved";

export interface DiscussionMappingRecord {
  id: string;
  tenantId: string;
  projectId: number;
  mergeRequestIid: number;
  identityKey: string;
  findingFingerprint: string;
  title: string;
  severity: string;
  category: string;
  body: string;
  gitlabDiscussionId: string;
  gitlabNoteId: number;
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

export interface UpsertDiscussionMappingInput {
  id?: string;
  tenantId: string;
  projectId: number;
  mergeRequestIid: number;
  identityKey: string;
  findingFingerprint: string;
  title: string;
  severity: string;
  category: string;
  body: string;
  gitlabDiscussionId: string;
  gitlabNoteId: number;
  anchorJson: string | null;
  positionJson: string | null;
  botDiscussion: boolean;
  botNote: boolean;
  noteAuthorId: number | null;
  noteAuthorUsername: string | null;
  status: DiscussionMappingStatus;
  lastInteractionRunId: string | null;
}

export interface Storage {
  initialize(): Promise<void>;
  upsertModelProfile(input: UpsertModelProfileInput): Promise<ModelProfileRecord>;
  listModelProfiles(): Promise<ModelProfileRecord[]>;
  getModelProfileByName(name: string): Promise<ModelProfileRecord | null>;
  getDefaultModelProfile(): Promise<ModelProfileRecord | null>;
  setDefaultModelProfile(name: string | null): Promise<ModelProfileRecord | null>;
  deleteModelProfile(name: string): Promise<ModelProfileRecord | null>;
  upsertTenant(tenant: TenantConfig): Promise<TenantRecord>;
  listTenants(): Promise<TenantRecord[]>;
  listTenantsByProjectId(projectId: number): Promise<TenantRecord[]>;
  getTenantById(tenantId: string): Promise<TenantRecord | null>;
  setTenantModelProfile(baseUrl: string, projectId: number, modelProfileName: string | null): Promise<TenantRecord>;
  getTenantDeletionSummary(baseUrl: string, projectId: number): Promise<TenantDeletionSummary | null>;
  deleteTenantWithSummary(baseUrl: string, projectId: number): Promise<TenantDeletionSummary | null>;
  deleteTenant(baseUrl: string, projectId: number): Promise<TenantRecord | null>;
  createOrGetInteractionJob(input: CreateInteractionJobInput): Promise<{ job: InteractionJobRecord; created: boolean }>;
  getInteractionJobById(jobId: string): Promise<InteractionJobRecord | null>;
  listQueuedInteractionJobs(): Promise<InteractionJobRecord[]>;
  markJobInProgress(jobId: string): Promise<void>;
  markJobCompleted(jobId: string): Promise<void>;
  markJobQueued(jobId: string, retryCount: number, error: string): Promise<void>;
  markJobFailed(jobId: string, retryCount: number, error: string): Promise<void>;
  createMergeRequestSnapshot(input: CreateMergeRequestSnapshotInput): Promise<MergeRequestSnapshotRecord>;
  createInteractionRun(input: CreateInteractionRunInput): Promise<InteractionRunRecord>;
  getLatestCompletedInteractionForMergeRequest(
    tenantId: string,
    mergeRequestIid: number,
    currentInteractionJobId: string
  ): Promise<PreviousCompletedInteractionRecord | null>;
  completeInteractionRun(interactionRunId: string, resultJson: string): Promise<void>;
  failInteractionRun(interactionRunId: string, error: string): Promise<void>;
  upsertInteractionRunMetrics(input: UpsertInteractionRunMetricsInput): Promise<InteractionRunMetricsRecord>;
  replaceReviewFindings(interactionRunId: string, findings: CreateReviewFindingInput[]): Promise<void>;
  listPriorReviewFindings(
    tenantId: string,
    mergeRequestIid: number,
    currentInteractionJobId: string
  ): Promise<PriorReviewFindingRecord[]>;
  listLatestReviewFindings(tenantId: string, mergeRequestIid: number): Promise<PriorReviewFindingRecord[]>;
  updateReviewFindingStatus(
    tenantId: string,
    mergeRequestIid: number,
    identityKey: string,
    status: ReviewFindingStatus
  ): Promise<boolean>;
  listDiscussionMappings(tenantId: string, mergeRequestIid: number): Promise<DiscussionMappingRecord[]>;
  upsertDiscussionMapping(input: UpsertDiscussionMappingInput): Promise<DiscussionMappingRecord>;
}
