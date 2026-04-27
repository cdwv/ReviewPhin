import type { TenantConfig } from "../config.js";

export interface TenantRecord {
  id: string;
  key: string;
  baseUrl: string;
  projectId: number;
  apiToken: string;
  webhookSecret: string;
  botUserId: number | null;
  botUsername: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ReviewJobStatus = "queued" | "in_progress" | "completed" | "failed";

export interface ReviewJobRecord {
  id: string;
  tenantId: string;
  dedupeKey: string;
  projectId: number;
  mergeRequestIid: number;
  noteId: number;
  headSha: string;
  status: ReviewJobStatus;
  payloadJson: string;
  retryCount: number;
  lastError: string | null;
  enqueuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CreateReviewJobInput {
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
  reviewJobId: string;
  tenantId: string;
  mergeRequestIid: number;
  headSha: string;
  mergeRequestJson: string;
  versionsJson: string;
  changesJson: string;
  notesJson: string;
  discussionsJson: string;
  instructionsJson: string;
  workspaceStrategy: string;
  createdAt: string;
}

export interface CreateMergeRequestSnapshotInput {
  reviewJobId: string;
  tenantId: string;
  mergeRequestIid: number;
  headSha: string;
  mergeRequestJson: string;
  versionsJson: string;
  changesJson: string;
  notesJson: string;
  discussionsJson: string;
  instructionsJson: string;
  workspaceStrategy: string;
}

export type ReviewRunStatus = "in_progress" | "completed" | "failed";

export interface ReviewRunRecord {
  id: string;
  reviewJobId: string;
  tenantId: string;
  provider: string;
  model: string | null;
  status: ReviewRunStatus;
  resultJson: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ReviewRunMetricsRecord {
  id: string;
  reviewRunId: string;
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

export interface CreateReviewRunInput {
  reviewJobId: string;
  tenantId: string;
  provider: string;
  model: string | null;
}

export interface UpsertReviewRunMetricsInput {
  reviewRunId: string;
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

export interface PreviousCompletedReviewRecord {
  reviewRunId: string;
  reviewJobId: string;
  finishedAt: string;
  headSha: string;
  resultJson: string;
  snapshot: MergeRequestSnapshotRecord;
}

export interface ReviewFindingRecord {
  id: string;
  reviewRunId: string;
  identityKey: string;
  fingerprint: string;
  severity: string;
  category: string;
  title: string;
  body: string;
  filePath: string | null;
  startLine: number | null;
  endLine: number | null;
  side: string | null;
  suggestionJson: string | null;
  rawJson: string;
  createdAt: string;
}

export interface CreateReviewFindingInput {
  reviewRunId: string;
  identityKey: string;
  fingerprint: string;
  severity: string;
  category: string;
  title: string;
  body: string;
  filePath: string | null;
  startLine: number | null;
  endLine: number | null;
  side: string | null;
  suggestionJson: string | null;
  rawJson: string;
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
  lastReviewRunId: string | null;
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
  lastReviewRunId: string | null;
}

export interface Storage {
  initialize(): Promise<void>;
  upsertTenant(tenant: TenantConfig): Promise<TenantRecord>;
  listTenants(): Promise<TenantRecord[]>;
  listTenantsByProjectId(projectId: number): Promise<TenantRecord[]>;
  getTenantById(tenantId: string): Promise<TenantRecord | null>;
  createOrGetReviewJob(input: CreateReviewJobInput): Promise<{ job: ReviewJobRecord; created: boolean }>;
  getReviewJobById(jobId: string): Promise<ReviewJobRecord | null>;
  listQueuedReviewJobs(): Promise<ReviewJobRecord[]>;
  markJobInProgress(jobId: string): Promise<void>;
  markJobCompleted(jobId: string): Promise<void>;
  markJobQueued(jobId: string, retryCount: number, error: string): Promise<void>;
  markJobFailed(jobId: string, retryCount: number, error: string): Promise<void>;
  createMergeRequestSnapshot(input: CreateMergeRequestSnapshotInput): Promise<MergeRequestSnapshotRecord>;
  createReviewRun(input: CreateReviewRunInput): Promise<ReviewRunRecord>;
  getLatestCompletedReviewForMergeRequest(
    tenantId: string,
    mergeRequestIid: number,
    currentReviewJobId: string
  ): Promise<PreviousCompletedReviewRecord | null>;
  completeReviewRun(reviewRunId: string, resultJson: string): Promise<void>;
  failReviewRun(reviewRunId: string, error: string): Promise<void>;
  upsertReviewRunMetrics(input: UpsertReviewRunMetricsInput): Promise<ReviewRunMetricsRecord>;
  replaceReviewFindings(reviewRunId: string, findings: CreateReviewFindingInput[]): Promise<void>;
  listDiscussionMappings(tenantId: string, mergeRequestIid: number): Promise<DiscussionMappingRecord[]>;
  upsertDiscussionMapping(input: UpsertDiscussionMappingInput): Promise<DiscussionMappingRecord>;
}
