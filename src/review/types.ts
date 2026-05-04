import { z } from "zod";

import type {
  GitLabDiscussion,
  GitLabMergeRequest,
  GitLabMergeRequestChange,
  GitLabNote,
  InstructionFile,
  TriggerNoteReference
} from "../gitlab/types.js";
import type { ProjectMemoryContext } from "../memory/types.js";
import type { ReviewFindingStatus } from "../storage/types.js";

export const reviewAnchorSchema = z
  .object({
    path: z.string().min(1),
    oldPath: z.string().min(1).optional(),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    side: z.enum(["new", "old"])
  })
  .refine((value) => value.endLine >= value.startLine, {
    message: "endLine must be greater than or equal to startLine"
  });

export const reviewSuggestionSchema = z
  .object({
    replacement: z.string().min(1),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive()
  })
  .refine((value) => value.endLine >= value.startLine, {
    message: "endLine must be greater than or equal to startLine"
  });

export const reviewFindingSchema = z.object({
  priorThreadId: z.string().min(1).optional(),
  title: z.string().min(1),
  body: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]),
  category: z.enum(["bug", "correctness", "security", "performance", "maintainability"]),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  anchor: reviewAnchorSchema.nullable().optional(),
  suggestion: reviewSuggestionSchema.nullable().optional(),
  replyInDiscussion: z.boolean().optional()
});

export const priorDispositionSchema = z.object({
  threadId: z.string().min(1),
  action: z.enum(["keep", "update", "resolve", "reply"]),
  replyBody: z.string().min(1).optional(),
  resolution: z.enum(["resolved", "dismissed"]).optional()
});

export const reviewMergeReadinessSchema = z.object({
  status: z.enum(["ready", "needs_attention", "blocked"]),
  confidence: z.enum(["low", "medium", "high"]),
  summary: z.string().min(1)
});

export const reviewOverviewSchema = z.object({
  summary: z.string().min(1),
  overallSeverity: z.enum(["low", "medium", "high", "critical"]),
  overallAssessment: z.string().min(1).optional(),
  mergeReadiness: reviewMergeReadinessSchema.optional(),
  highlights: z.array(z.string().min(1)).max(5).optional()
});

export const reviewResultSchema = z.object({
  overview: reviewOverviewSchema,
  findings: z.array(reviewFindingSchema),
  priorDispositions: z.array(priorDispositionSchema).default([])
});

export type ReviewAnchor = z.infer<typeof reviewAnchorSchema>;
export type ReviewSuggestion = z.infer<typeof reviewSuggestionSchema>;
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
export type PriorDisposition = z.infer<typeof priorDispositionSchema>;
export type ReviewMergeReadiness = z.infer<typeof reviewMergeReadinessSchema>;
export type ReviewOverview = z.infer<typeof reviewOverviewSchema>;
export type ReviewResult = z.infer<typeof reviewResultSchema>;
export type ReviewMode = "first-pass-full" | "incremental-rereview" | "follow-up-thread";

export interface ReviewChangeSummary {
  path: string;
  oldPath: string | null;
  newFile: boolean;
  renamedFile: boolean;
  deletedFile: boolean;
  reason?: string | undefined;
}

export interface PriorReviewFindingContext {
  findingId: string;
  identityKey: string;
  status: ReviewFindingStatus;
  title: string;
  body: string;
  severity: ReviewFinding["severity"];
  category: ReviewFinding["category"];
  anchor: ReviewAnchor | null;
  suggestion: ReviewSuggestion | null;
  reviewRunId: string;
  reviewedAt: string;
  headSha: string;
}

export interface ProviderThreadContext {
  threadId: string;
  discussionId: string;
  noteId: number;
  title: string;
  body: string;
  anchor: ReviewAnchor | null;
  resolved: boolean;
  humanReplies: Array<{
    noteId: number;
    authorUsername: string;
    body: string;
  }>;
}

export type ReviewTriggerKind = "direct-mention" | "follow-up-comment" | "summary-follow-up";

export interface ReviewTriggerContext {
  kind: ReviewTriggerKind;
  noteId: number;
  authorUsername: string | null;
  body: string;
  instruction: string | null;
  targetThreadId: string | null;
  targetDiscussionId: string | null;
  targetThreadTitle: string | null;
}

export interface WebhookReviewTrigger {
  kind: ReviewTriggerKind;
  note: TriggerNoteReference;
}

export interface PreviousReviewContext {
  reviewRunId: string;
  reviewedAt: string;
  headSha: string;
  overviewSummary: string | null;
  mergeReadiness: ReviewMergeReadiness | null;
}

export interface ReviewDeltaContext {
  previousReviewRunId: string;
  previousHeadSha: string;
  changedFiles: ReviewChangeSummary[];
}

export interface ReviewScopeContext {
  mode: ReviewMode;
  scopeSummary: string;
  widenScopeHints: string[];
  allChangedFiles: ReviewChangeSummary[];
  omittedChangedFiles: ReviewChangeSummary[];
  targetThread: ProviderThreadContext | null;
  previousReview: PreviousReviewContext | null;
  priorFindings: PriorReviewFindingContext[];
  deltaSincePreviousReview: ReviewDeltaContext | null;
}

export interface ReviewContext {
  workspacePath: string;
  mergeRequest: GitLabMergeRequest;
  changes: GitLabMergeRequestChange[];
  notes: GitLabNote[];
  discussions: GitLabDiscussion[];
  instructionFiles: InstructionFile[];
  projectMemory: ProjectMemoryContext;
  trigger: ReviewTriggerContext;
  priorThreads: ProviderThreadContext[];
  scope: ReviewScopeContext;
  logging?: {
    interactionRunId: string;
    interactionJobId: string;
    tenantId: string;
    runDirectory?: string | undefined;
  };
}
