import { renderPrompt, type PromptTemplateId } from "./instruction-renderer.js";
import { isReviewSummaryNoteBody } from "../review/summary.js";
import type { ChatterRunContext } from "../review/harness-chatter.js";
import type { ReviewContext } from "../review/types.js";
import { truncate } from "../utils/text.js";
import type { ProjectMemoryCoalesceInput } from "../memory/types.js";

const DEFAULT_MAX_PROMPT_MEMORY_CHARS = 5_000;

export function buildProjectMemoryCoalescePrompt(
  input: ProjectMemoryCoalesceInput,
): string {
  return renderPrompt("memory.coalesce", input);
}

export function buildReviewPrompt(
  context: ReviewContext,
  options: {
    maxPromptMemoryChars?: number;
  } = {},
): string {
  const maxPromptMemoryChars =
    options.maxPromptMemoryChars ?? DEFAULT_MAX_PROMPT_MEMORY_CHARS;
  return [
    renderPrompt(getPromptTemplateId(context), {}),
    ...buildAttachmentRuntimeNote(context),
    "",
    "JSON schema:",
    JSON.stringify(reviewResponseSchema, null, 2),
    "",
    "Context:",
    JSON.stringify(
      buildCompactReviewContext(context, maxPromptMemoryChars),
      null,
      2,
    ),
  ].join("\n");
}

export function buildChatterPrompt(context: ChatterRunContext): string {
  const maxPromptMemoryChars = DEFAULT_MAX_PROMPT_MEMORY_CHARS;
  return [
    renderPrompt(getChatterPromptTemplateId(context), {}),
    ...buildAttachmentRuntimeNote(context.reviewContext),
    "",
    "Formatting contract:",
    "- Return exactly one JSON object matching the schema below.",
    "- Put all human-facing reply text inside JSON string fields such as `replies[].replyBody`.",
    "- Do not include Markdown fences, introductions, explanations, or trailing text outside the JSON object.",
    "",
    "JSON schema:",
    JSON.stringify(chatterResponseSchema, null, 2),
    "",
    "Context:",
    JSON.stringify(
      buildCompactChatterContext(context, maxPromptMemoryChars),
      null,
      2,
    ),
  ].join("\n");
}

function getPromptTemplateId(
  context: ReviewContext,
): Extract<PromptTemplateId, `review.${string}`> {
  if (context.scope.mode === "follow-up-discussion") {
    return "review.follow-up-discussion";
  }

  if (context.scope.mode === "incremental-rereview") {
    return context.trigger.kind === "summary-follow-up"
      ? "review.incremental-rereview.summary-follow-up"
      : "review.incremental-rereview";
  }

  return context.trigger.kind === "summary-follow-up"
    ? "review.first-pass-full.summary-follow-up"
    : "review.first-pass-full";
}

function getChatterPromptTemplateId(
  context: ChatterRunContext,
): Extract<PromptTemplateId, `reply.${string}`> {
  if (context.phase === "memory") {
    return "reply.memory-update";
  }

  if (context.trigger.kind === "summary-follow-up") {
    return context.reviewResult
      ? "reply.summary-follow-up.after-review"
      : "reply.summary-follow-up";
  }

  return context.reviewResult
    ? "reply.direct-mention.after-review"
    : "reply.direct-mention";
}

export function buildCompactReviewContext(
  context: ReviewContext,
  maxPromptMemoryChars: number,
) {
  return {
    attachments: context.attachments.map((attachment) => ({
      sourceKind: attachment.sourceKind,
      commentId: attachment.commentId,
      displayName: attachment.displayName,
      contentType: attachment.contentType,
    })),
    attachmentIssues: context.attachmentIssues.map((issue) => ({
      sourceKind: issue.sourceKind,
      commentId: issue.commentId,
      displayName: issue.displayName,
      status: issue.status,
      message: issue.message,
      url: issue.url,
    })),
    reviewMode: context.scope.mode,
    reviewScope: {
      summary: context.scope.scopeSummary,
      totalChangedFiles: context.scope.allChangedFiles.length,
      includedChangedFiles: context.changes.length,
      omittedChangedFiles: context.scope.omittedChangedFiles.slice(0, 25),
      widenScopeHints: context.scope.widenScopeHints,
      targetDiscussion: context.scope.targetDiscussion
        ? {
            discussionId: context.scope.targetDiscussion.discussionId,
            platformDiscussionId:
              context.scope.targetDiscussion.platformDiscussionId,
            platformCommentId: context.scope.targetDiscussion.platformCommentId,
            title: context.scope.targetDiscussion.title,
            anchor: context.scope.targetDiscussion.anchor,
            resolved: context.scope.targetDiscussion.resolved,
          }
        : null,
      previousReview: context.scope.previousReview
        ? {
            reviewRunId: context.scope.previousReview.reviewRunId,
            reviewedAt: context.scope.previousReview.reviewedAt,
            headSha: context.scope.previousReview.headSha,
            overviewSummary: context.scope.previousReview.overviewSummary,
            mergeReadiness: context.scope.previousReview.mergeReadiness,
          }
        : null,
      priorFindings: context.scope.priorFindings
        .slice(0, 25)
        .map((finding) => ({
          findingId: finding.findingId,
          identityKey: finding.identityKey,
          status: finding.status,
          title: finding.title,
          body: truncate(finding.body, 1_500),
          severity: finding.severity,
          category: finding.category,
          anchor: finding.anchor,
          suggestion: finding.suggestion,
          reviewRunId: finding.reviewRunId,
          reviewedAt: finding.reviewedAt,
          headSha: finding.headSha,
        })),
      deltaSincePreviousReview: context.scope.deltaSincePreviousReview,
    },
    reviewTrigger: buildCompactTrigger(context.trigger),
    codeReview: {
      id: context.codeReview.id,
      title: context.codeReview.title,
      description: truncate(context.codeReview.description ?? "", 3_000),
      webUrl: context.codeReview.webUrl,
      author: context.codeReview.authorUsername,
      sourceBranch: context.codeReview.sourceBranch,
      targetBranch: context.codeReview.targetBranch,
    },
    projectMemory: buildPromptProjectMemory(
      context.projectMemory,
      maxPromptMemoryChars,
    ),
    changedFiles: context.changes.map((change) => ({
      oldPath: change.oldPath,
      newPath: change.newPath,
      newFile: change.newFile,
      renamedFile: change.renamedFile,
      deletedFile: change.deletedFile,
      diff: truncate(change.diff ?? "", 6_000),
    })),
    additionalChangedFiles: context.scope.omittedChangedFiles.slice(0, 40),
    codeReviewComments: context.comments
      .filter((note) => !isReviewSummaryNoteBody(note.body))
      .slice(0, 50)
      .map((note) => ({
        id: note.id,
        author: note.authorUsername,
        body: truncate(note.body, 1_500),
        resolvable: note.resolvable,
        resolved: note.resolved,
      })),
    priorDiscussions: context.priorDiscussions.map((discussion) => ({
      discussionId: discussion.discussionId,
      platformDiscussionId: discussion.platformDiscussionId,
      platformCommentId: discussion.platformCommentId,
      title: discussion.title,
      body: truncate(discussion.body, 2_000),
      anchor: discussion.anchor,
      resolvable: discussion.resolvable,
      resolved: discussion.resolved,
      humanReplies: discussion.humanReplies.map((reply) => ({
        platformCommentId: reply.platformCommentId,
        authorUsername: reply.authorUsername,
        body: truncate(reply.body, 1_500),
      })),
    })),
  };
}

function buildPromptProjectMemory(
  projectMemory: ReviewContext["projectMemory"],
  maxPromptMemoryChars: number,
):
  | {
      enabled: false;
    }
  | {
      enabled: true;
      pageTitle: string | null;
      pageSlug: string | null;
      totalEntryCount: number;
      includedEntryCount: number;
      omittedEntryCount: number;
      entries: string[];
    } {
  if (!projectMemory.enabled) {
    return {
      enabled: false,
    };
  }

  const entries: string[] = [];
  let remainingChars = maxPromptMemoryChars;

  for (const entry of projectMemory.entries) {
    if (remainingChars <= 0) {
      break;
    }

    if (entry.text.length > remainingChars) {
      break;
    }

    if (!entry.text.trim()) {
      continue;
    }

    entries.push(entry.text);
    remainingChars -= entry.text.length;
  }

  return {
    enabled: true,
    pageTitle: projectMemory.page?.title ?? null,
    pageSlug: projectMemory.page?.slug ?? null,
    totalEntryCount: projectMemory.entries.length,
    includedEntryCount: entries.length,
    omittedEntryCount: Math.max(
      0,
      projectMemory.entries.length - entries.length,
    ),
    entries,
  };
}

const reviewResponseSchema = {
  overview: {
    summary: "string",
    overallSeverity: "low | medium | high | critical",
    overallAssessment: "string",
    mergeReadiness: {
      status: "ready | needs_attention | blocked",
      confidence: "low | medium | high",
      summary: "string",
    },
    highlights: ["optional string"],
  },
  findings: [
    {
      priorDiscussionId: "optional string",
      title: "string",
      body: "string",
      severity: "low | medium | high | critical",
      category: "bug | correctness | security | performance | maintainability",
      confidence: "optional low | medium | high",
      anchor: {
        path: "string",
        oldPath: "optional string",
        startLine: 1,
        endLine: 1,
        side: "new | old",
      },
      suggestion: {
        replacement: "string",
        startLine: 1,
        endLine: 1,
      },
      replyInDiscussion: false,
    },
  ],
  priorDispositions: [
    {
      discussionId: "string",
      action: "keep | update | resolve | reply",
      replyBody: "optional string",
      resolution: "optional resolved | dismissed",
    },
  ],
  replyHandoff: {
    summary: "string",
    targets: [
      {
        kind: "code-review-comment | discussion-reply | summary-discussion-reply | finding-discussion-reply",
        commentId: 1,
        discussionId:
          "required for threaded reply kinds; optional for code-review-comment",
        guidance: "string",
      },
    ],
  },
};

const chatterResponseSchema = {
  memory: {
    status: "written | skipped",
    summary: "string",
  },
  replies: [
    {
      target: {
        kind: "code-review-comment | discussion-reply | summary-discussion-reply | finding-discussion-reply",
        commentId: 1,
        discussionId:
          "required for threaded reply kinds; optional for code-review-comment",
      },
      replyBody: "string",
    },
  ],
};

function buildCompactChatterContext(
  context: ChatterRunContext,
  maxPromptMemoryChars: number,
) {
  const sharedReviewContext = context.reviewContext
    ? buildCompactReviewContext(context.reviewContext, maxPromptMemoryChars)
    : null;
  const compactTrigger = buildCompactTrigger(context.trigger);

  return {
    phase: context.phase,
    replyStyle: context.replyStyle,
    attachments: sharedReviewContext?.attachments ?? [],
    attachmentIssues: sharedReviewContext?.attachmentIssues ?? [],
    reviewMode: sharedReviewContext?.reviewMode ?? null,
    reviewScope: sharedReviewContext?.reviewScope ?? null,
    reviewTrigger: sharedReviewContext?.reviewTrigger ?? compactTrigger,
    codeReview: sharedReviewContext?.codeReview ?? null,
    trigger: {
      ...compactTrigger,
      responseTarget: context.trigger.responseTarget,
    },
    responseTargets: context.responseTargets.map((target) => ({
      ...target,
      body: truncate(target.body, 1_500),
      instruction: target.instruction
        ? truncate(target.instruction, 1_000)
        : null,
    })),
    projectMemory:
      sharedReviewContext?.projectMemory ??
      buildPromptProjectMemory(context.projectMemory, maxPromptMemoryChars),
    changedFiles: sharedReviewContext?.changedFiles ?? [],
    additionalChangedFiles: sharedReviewContext?.additionalChangedFiles ?? [],
    codeReviewComments: sharedReviewContext?.codeReviewComments ?? [],
    priorDiscussions: sharedReviewContext?.priorDiscussions ?? [],
    reviewResult: context.reviewResult
      ? {
          overview: context.reviewResult.overview,
          findings: context.reviewResult.findings.map((finding) => ({
            title: finding.title,
            body: truncate(finding.body, 1_000),
            severity: finding.severity,
            category: finding.category,
            anchor: finding.anchor,
          })),
          replyHandoff:
            context.reviewResult.replyHandoff ??
            context.reviewerReplyHandoff ??
            null,
        }
      : null,
    reviewerReplyHandoff: context.reviewerReplyHandoff ?? null,
  };
}

function buildCompactTrigger(trigger: ReviewContext["trigger"]) {
  if (trigger.kind === "manual-review") {
    return {
      kind: trigger.kind,
      provider: trigger.provider,
      source: trigger.source,
      instruction: trigger.instruction
        ? truncate(trigger.instruction, 1_000)
        : null,
      metadata: trigger.metadata,
    };
  }

  return {
    kind: trigger.kind,
    commentId: trigger.commentId,
    authorUsername: trigger.authorUsername,
    body: truncate(trigger.body, 1_500),
    instruction: trigger.instruction
      ? truncate(trigger.instruction, 1_000)
      : null,
    targetDiscussionId: trigger.targetDiscussionId,
    targetPlatformDiscussionId: trigger.targetPlatformDiscussionId,
    targetDiscussionTitle: trigger.targetDiscussionTitle,
  };
}

function buildAttachmentRuntimeNote(
  context:
    | Pick<ReviewContext, "attachments" | "attachmentIssues">
    | null
    | undefined,
): string[] {
  if (!context || context.attachmentIssues.length === 0) {
    return [];
  }

  const failedImages = context.attachmentIssues
    .map((issue) => issue.displayName)
    .filter((value, index, values) => values.indexOf(value) === index);
  const availableImages = context.attachments
    .map((attachment) => attachment.displayName)
    .filter((value, index, values) => values.indexOf(value) === index);
  const missingDescription =
    failedImages.length > 0 ? failedImages.join(", ") : "referenced images";
  const availableDescription =
    availableImages.length > 0
      ? `The images that were sent successfully are: ${availableImages.join(", ")}.`
      : "No referenced images were sent successfully.";

  return [
    "",
    "Runtime note:",
    `The platform failed to download ${context.attachmentIssues.length} referenced image attachment(s) before this run. These images were not sent to you: ${missingDescription}. ${availableDescription} Do not claim to have inspected the missing images. If they seem relevant, explicitly mention that some referenced platform attachments were unavailable because download requests failed, and reason from the remaining context only.`,
  ];
}
