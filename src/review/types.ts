import { z } from "zod";

import type { ProjectMemoryContext } from "../memory/types.js";
import type { HarnessRunLoggingContext } from "../harness/types.js";
import type {
  ReviewFindingStatus,
  TenantRecord,
} from "../storage/contract/index.js";

export const reviewAnchorSchema = z
  .object({
    path: z.string().min(1),
    oldPath: z.string().min(1).optional(),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    side: z.enum(["new", "old"]),
  })
  .refine((value) => value.endLine >= value.startLine, {
    message: "endLine must be greater than or equal to startLine",
  });

export const reviewSuggestionSchema = z
  .object({
    replacement: z.string().min(1),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .refine((value) => value.endLine >= value.startLine, {
    message: "endLine must be greater than or equal to startLine",
  });

export const reviewFindingSchema = z.object({
  priorDiscussionId: z.string().min(1).optional(),
  title: z.string().min(1),
  body: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]),
  category: z.enum([
    "bug",
    "correctness",
    "security",
    "performance",
    "maintainability",
  ]),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  anchor: reviewAnchorSchema.nullable().optional(),
  suggestion: reviewSuggestionSchema.nullable().optional(),
  replyInDiscussion: z.boolean().optional(),
});

export const priorDispositionSchema = z.object({
  discussionId: z.string().min(1),
  action: z.enum(["keep", "update", "resolve", "reply"]),
  replyBody: z.string().min(1).optional(),
  resolution: z.enum(["resolved", "dismissed"]).optional(),
});

export const responseTargetSchema = z.object({
  kind: z.enum([
    "code-review-comment",
    "discussion-reply",
    "summary-discussion-reply",
    "finding-discussion-reply",
  ]),
  locationType: z.enum([
    "code-review-comment",
    "discussion-comment",
    "summary-discussion",
    "finding-discussion",
  ]),
  triggerKind: z.enum([
    "direct-mention",
    "follow-up-comment",
    "summary-follow-up",
  ]),
  commentId: z.number().int().positive(),
  discussionId: z.string().min(1).optional(),
  authorUsername: z.string().min(1).nullable(),
  body: z.string().min(1),
  instruction: z.string().min(1).nullable(),
});

export const reviewerReplyTargetHandoffSchema = z
  .object({
    kind: responseTargetSchema.shape.kind,
    commentId: z.number().int().positive(),
    discussionId: z.string().min(1).optional(),
    guidance: z.string().min(1),
  })
  .superRefine((target, context) => {
    if (target.kind !== "code-review-comment" && !target.discussionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "discussionId is required for discussion reply targets",
        path: ["discussionId"],
      });
    }
  });

export const reviewerReplyHandoffSchema = z.object({
  summary: z.string().min(1),
  targets: z.array(reviewerReplyTargetHandoffSchema).default([]),
});

export const reviewMergeReadinessSchema = z.object({
  status: z.enum(["ready", "needs_attention", "blocked"]),
  confidence: z.enum(["low", "medium", "high"]),
  summary: z.string().min(1),
});

export const reviewOverviewSchema = z.object({
  summary: z.string().min(1),
  overallSeverity: z.enum(["low", "medium", "high", "critical"]),
  overallAssessment: z.string().min(1).optional(),
  mergeReadiness: reviewMergeReadinessSchema.optional(),
  highlights: z.array(z.string().min(1)).max(5).optional(),
});

export const reviewResultSchema = z.object({
  overview: reviewOverviewSchema,
  findings: z.array(reviewFindingSchema),
  priorDispositions: z.array(priorDispositionSchema).default([]),
  replyHandoff: reviewerReplyHandoffSchema.optional(),
});

export const chatterMemoryOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("written"),
    summary: z.string().min(1),
  }),
  z.object({
    status: z.literal("skipped"),
    summary: z.string(),
  }),
]);

export const chatterReplySchema = z.object({
  target: z
    .object({
      kind: responseTargetSchema.shape.kind,
      commentId: z.number().int().positive(),
      discussionId: z.string().min(1).optional(),
    })
    .superRefine((target, context) => {
      if (target.kind !== "code-review-comment" && !target.discussionId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "discussionId is required for discussion reply targets",
          path: ["discussionId"],
        });
      }
    }),
  replyBody: z.string().min(1),
});

export const chatterBatchResultSchema = z.object({
  memory: chatterMemoryOutcomeSchema.nullable().optional(),
  replies: z.array(chatterReplySchema).default([]),
});

export type ReviewAnchor = z.infer<typeof reviewAnchorSchema>;
export type ReviewSuggestion = z.infer<typeof reviewSuggestionSchema>;
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
export type PriorDisposition = z.infer<typeof priorDispositionSchema>;
export type ResponseTarget = z.infer<typeof responseTargetSchema>;
export type ReviewerReplyTargetHandoff = z.infer<
  typeof reviewerReplyTargetHandoffSchema
>;
export type ReviewerReplyHandoff = z.infer<typeof reviewerReplyHandoffSchema>;
export type ReviewMergeReadiness = z.infer<typeof reviewMergeReadinessSchema>;
export type ReviewOverview = z.infer<typeof reviewOverviewSchema>;
export type ReviewResult = z.infer<typeof reviewResultSchema>;
export type ChatterMemoryOutcome = z.infer<typeof chatterMemoryOutcomeSchema>;
export type ChatterReply = z.infer<typeof chatterReplySchema>;
export type ChatterBatchResult = z.infer<typeof chatterBatchResultSchema>;
export type ReviewMode =
  "first-pass-full" | "incremental-rereview" | "follow-up-discussion";
export type ReplyStyle =
  | "none"
  | "direct-answer"
  | "summary-follow-up"
  | "discussion-follow-up"
  | "acknowledgement";

export interface ReviewChangeSummary {
  path: string;
  oldPath: string | null;
  newFile: boolean;
  renamedFile: boolean;
  deletedFile: boolean;
  reason?: string | undefined;
}

export interface CodeReviewItem {
  id: number;
  title: string;
  description: string;
  webUrl: string;
  authorUsername: string | null;
  sourceBranch: string;
  targetBranch: string;
}

export interface CodeReviewChange {
  oldPath: string;
  newPath: string;
  diff?: string | undefined;
  newFile: boolean;
  renamedFile: boolean;
  deletedFile: boolean;
}

export interface CodeReviewComment {
  id: number;
  body: string;
  authorUsername: string | null;
  resolvable: boolean;
  resolved: boolean;
}

export interface CodeReviewDiscussionComment {
  id: number;
  body: string;
  authorUsername: string | null;
  resolvable: boolean;
  resolved: boolean;
  anchor: ReviewAnchor | null;
  positionJson: string | null;
  isBot: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CodeReviewDiscussion {
  id: string;
  resolved: boolean;
  comments: CodeReviewDiscussionComment[];
}

export type ReviewAttachmentSourceKind =
  "trigger-comment" | "code-review-description";

export interface ReviewAttachment {
  contentType: string;
  displayName: string;
  commentId: number | null;
  sourceKind: ReviewAttachmentSourceKind;
}

export interface ReviewAttachmentIssue {
  displayName: string;
  message: string;
  commentId: number | null;
  sourceKind: ReviewAttachmentSourceKind;
  status: number;
  url: string;
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

export interface ProviderDiscussionContext {
  discussionId: string;
  platformDiscussionId: string;
  platformCommentId: number;
  title: string;
  body: string;
  anchor: ReviewAnchor | null;
  resolvable: boolean;
  resolved: boolean;
  humanReplies: Array<{
    platformCommentId: number;
    authorUsername: string;
    body: string;
  }>;
}

export type TriggerCommentReference =
  | {
      kind: "code-review-comment";
      commentId: number;
    }
  | {
      kind: "discussion-comment";
      discussionId: string;
      commentId: number;
    };

export type CommentReviewTriggerKind =
  "direct-mention" | "follow-up-comment" | "summary-follow-up";

export type ReviewTriggerKind = CommentReviewTriggerKind | "manual-review";

export interface CommentReviewTriggerContext {
  kind: CommentReviewTriggerKind;
  commentId: number;
  authorUsername: string | null;
  body: string;
  instruction: string | null;
  targetDiscussionId: string | null;
  targetPlatformDiscussionId: string | null;
  targetDiscussionTitle: string | null;
  responseTarget: ResponseTarget;
}

export interface ManualReviewTriggerContext {
  kind: "manual-review";
  provider: string;
  source: string;
  instruction: string | null;
  metadata: Record<string, string | number | boolean | null>;
}

export type ReviewTriggerContext =
  CommentReviewTriggerContext | ManualReviewTriggerContext;

export type WebhookReviewTrigger =
  | {
      kind: CommentReviewTriggerKind;
      comment: TriggerCommentReference;
    }
  | {
      kind: "check-run-requested-action";
      checkRunId: number;
      actionIdentifier: string;
    };

export interface ReviewSummaryContext {
  tenant?: TenantRecord | undefined;
  job?: unknown;
  codeReview: CodeReviewItem;
  changes: ReadonlyArray<CodeReviewChange>;
}

export interface PlannedResponseAction {
  target: ResponseTarget;
  replyStyle: ReplyStyle;
  reviewNeeded: boolean;
  memoryCandidate: boolean;
}

export interface InteractionPlan {
  initiatingTrigger: ReviewTriggerContext;
  responseTargets: ResponseTarget[];
  plannedResponses: PlannedResponseAction[];
  memoryCandidate: boolean;
  reviewNeeded: boolean;
  replyNeeded: boolean;
  replyStyle: ReplyStyle;
  rerunReason: string | null;
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
  targetDiscussion: ProviderDiscussionContext | null;
  previousReview: PreviousReviewContext | null;
  priorFindings: PriorReviewFindingContext[];
  deltaSincePreviousReview: ReviewDeltaContext | null;
}

export interface ReviewContext {
  attachments: ReviewAttachment[];
  attachmentIssues: ReviewAttachmentIssue[];
  workspacePath: string;
  codeReview: CodeReviewItem;
  changes: CodeReviewChange[];
  comments: CodeReviewComment[];
  discussions: CodeReviewDiscussion[];
  projectMemory: ProjectMemoryContext;
  trigger: ReviewTriggerContext;
  priorDiscussions: ProviderDiscussionContext[];
  scope: ReviewScopeContext;
  logging?: {
    interactionRunId: string;
    interactionJobId: string;
    tenantId: string;
    runDirectory?: string | undefined;
    onMetrics?: HarnessRunLoggingContext["onMetrics"];
  };
}
