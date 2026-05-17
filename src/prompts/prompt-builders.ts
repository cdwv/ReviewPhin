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
  if (context.scope.mode === "follow-up-thread") {
    return "review.follow-up-thread";
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
      noteId: attachment.noteId,
      displayName: attachment.displayName,
      contentType: attachment.contentType,
    })),
    attachmentIssues: context.attachmentIssues.map((issue) => ({
      sourceKind: issue.sourceKind,
      noteId: issue.noteId,
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
      targetThread: context.scope.targetThread
        ? {
            threadId: context.scope.targetThread.threadId,
            discussionId: context.scope.targetThread.discussionId,
            title: context.scope.targetThread.title,
            anchor: context.scope.targetThread.anchor,
            resolved: context.scope.targetThread.resolved,
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
    reviewTrigger: {
      kind: context.trigger.kind,
      noteId: context.trigger.noteId,
      authorUsername: context.trigger.authorUsername,
      body: truncate(context.trigger.body, 1_500),
      instruction: context.trigger.instruction
        ? truncate(context.trigger.instruction, 1_000)
        : null,
      targetThreadId: context.trigger.targetThreadId,
      targetDiscussionId: context.trigger.targetDiscussionId,
      targetThreadTitle: context.trigger.targetThreadTitle,
    },
    mergeRequest: {
      iid: context.mergeRequest.iid,
      title: context.mergeRequest.title,
      description: truncate(context.mergeRequest.description ?? "", 3_000),
      webUrl: context.mergeRequest.web_url,
      author: context.mergeRequest.author.username,
      sourceBranch: context.mergeRequest.source_branch,
      targetBranch: context.mergeRequest.target_branch,
    },
    projectMemory: buildPromptProjectMemory(
      context.projectMemory,
      maxPromptMemoryChars,
    ),
    instructionFiles: context.instructionFiles.map((file) => file.path),
    changedFiles: context.changes.map((change) => ({
      oldPath: change.old_path,
      newPath: change.new_path,
      newFile: change.new_file,
      renamedFile: change.renamed_file,
      deletedFile: change.deleted_file,
      diff: truncate(change.diff ?? "", 6_000),
    })),
    additionalChangedFiles: context.scope.omittedChangedFiles.slice(0, 40),
    mergeRequestNotes: context.notes
      .filter((note) => !isReviewSummaryNoteBody(note.body))
      .slice(0, 50)
      .map((note) => ({
        id: note.id,
        author: note.author.username,
        body: truncate(note.body, 1_500),
        resolvable: note.resolvable ?? false,
        resolved: note.resolved ?? false,
      })),
    priorThreads: context.priorThreads.map((thread) => ({
      threadId: thread.threadId,
      discussionId: thread.discussionId,
      noteId: thread.noteId,
      title: thread.title,
      body: truncate(thread.body, 2_000),
      anchor: thread.anchor,
      resolved: thread.resolved,
      humanReplies: thread.humanReplies.map((reply) => ({
        noteId: reply.noteId,
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
      priorThreadId: "optional string",
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
      threadId: "string",
      action: "keep | update | resolve | reply",
      replyBody: "optional string",
      resolution: "optional resolved | dismissed",
    },
  ],
  replyHandoff: {
    summary: "string",
    targets: [
      {
        kind: "merge-request-note | discussion-reply | summary-discussion-reply | finding-thread-reply",
        noteId: 1,
        discussionId:
          "required for threaded reply kinds; optional for merge-request-note",
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
        kind: "merge-request-note | discussion-reply | summary-discussion-reply | finding-thread-reply",
        noteId: 1,
        discussionId:
          "required for threaded reply kinds; optional for merge-request-note",
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
  const compactTrigger = {
    kind: context.trigger.kind,
    noteId: context.trigger.noteId,
    authorUsername: context.trigger.authorUsername,
    body: truncate(context.trigger.body, 1_500),
    instruction: context.trigger.instruction
      ? truncate(context.trigger.instruction, 1_000)
      : null,
    targetThreadId: context.trigger.targetThreadId,
    targetDiscussionId: context.trigger.targetDiscussionId,
    targetThreadTitle: context.trigger.targetThreadTitle,
  };

  return {
    phase: context.phase,
    replyStyle: context.replyStyle,
    attachments: sharedReviewContext?.attachments ?? [],
    attachmentIssues: sharedReviewContext?.attachmentIssues ?? [],
    reviewMode: sharedReviewContext?.reviewMode ?? null,
    reviewScope: sharedReviewContext?.reviewScope ?? null,
    reviewTrigger: sharedReviewContext?.reviewTrigger ?? compactTrigger,
    mergeRequest: sharedReviewContext?.mergeRequest ?? null,
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
    instructionFiles: sharedReviewContext?.instructionFiles ?? [],
    changedFiles: sharedReviewContext?.changedFiles ?? [],
    additionalChangedFiles: sharedReviewContext?.additionalChangedFiles ?? [],
    mergeRequestNotes: sharedReviewContext?.mergeRequestNotes ?? [],
    priorThreads: sharedReviewContext?.priorThreads ?? [],
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
    `GitLab failed to download ${context.attachmentIssues.length} referenced image attachment(s) before this run. These images were not sent to you: ${missingDescription}. ${availableDescription} Do not claim to have inspected the missing images. If they seem relevant, explicitly mention that some referenced GitLab images were unavailable because GitLab download requests failed, and reason from the remaining context only.`,
  ];
}
