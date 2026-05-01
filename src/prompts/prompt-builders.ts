import { renderPrompt, type PromptTemplateId } from "./instruction-renderer.js";
import { isReviewSummaryNoteBody } from "../review/summary.js";
import type { ReviewContext } from "../review/types.js";
import { truncate } from "../utils/text.js";
import type { ProjectMemoryCoalesceInput } from "../memory/types.js";

const DEFAULT_MAX_PROMPT_MEMORY_CHARS = 5_000;

export function buildProjectMemoryCoalescePrompt(input: ProjectMemoryCoalesceInput): string {
  return renderPrompt("memory.coalesce", input);
}

export function buildReviewPrompt(
  context: ReviewContext,
  options: {
    maxPromptMemoryChars?: number;
  } = {}
): string {
  const maxPromptMemoryChars = options.maxPromptMemoryChars ?? DEFAULT_MAX_PROMPT_MEMORY_CHARS;
  return [
    renderPrompt(getPromptTemplateId(context), {}),
    "",
    "JSON schema:",
    JSON.stringify(reviewResponseSchema, null, 2),
    "",
    "Context:",
    JSON.stringify(buildCompactReviewContext(context, maxPromptMemoryChars), null, 2)
  ].join("\n");
}

function getPromptTemplateId(
  context: ReviewContext
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

function buildCompactReviewContext(
  context: ReviewContext,
  maxPromptMemoryChars: number
) {
  return {
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
            resolved: context.scope.targetThread.resolved
          }
        : null,
      previousReview: context.scope.previousReview
        ? {
            reviewRunId: context.scope.previousReview.reviewRunId,
            reviewedAt: context.scope.previousReview.reviewedAt,
            headSha: context.scope.previousReview.headSha,
            overviewSummary: context.scope.previousReview.overviewSummary,
            mergeReadiness: context.scope.previousReview.mergeReadiness
          }
        : null,
      priorFindings: context.scope.priorFindings.slice(0, 25).map((finding) => ({
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
        headSha: finding.headSha
      })),
      deltaSincePreviousReview: context.scope.deltaSincePreviousReview
    },
    reviewTrigger: {
      kind: context.trigger.kind,
      noteId: context.trigger.noteId,
      authorUsername: context.trigger.authorUsername,
      body: truncate(context.trigger.body, 1_500),
      instruction: context.trigger.instruction ? truncate(context.trigger.instruction, 1_000) : null,
      targetThreadId: context.trigger.targetThreadId,
      targetDiscussionId: context.trigger.targetDiscussionId,
      targetThreadTitle: context.trigger.targetThreadTitle
    },
    mergeRequest: {
      iid: context.mergeRequest.iid,
      title: context.mergeRequest.title,
      description: truncate(context.mergeRequest.description ?? "", 3_000),
      webUrl: context.mergeRequest.web_url,
      sourceBranch: context.mergeRequest.source_branch,
      targetBranch: context.mergeRequest.target_branch
    },
    projectMemory: buildPromptProjectMemory(context, maxPromptMemoryChars),
    instructionFiles: context.instructionFiles.map((file) => file.path),
    changedFiles: context.changes.map((change) => ({
      oldPath: change.old_path,
      newPath: change.new_path,
      newFile: change.new_file,
      renamedFile: change.renamed_file,
      deletedFile: change.deleted_file,
      diff: truncate(change.diff ?? "", 6_000)
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
        resolved: note.resolved ?? false
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
        body: truncate(reply.body, 1_500)
      }))
    }))
  };
}

function buildPromptProjectMemory(
  context: ReviewContext,
  maxPromptMemoryChars: number
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
  if (!context.projectMemory.enabled) {
    return {
      enabled: false
    };
  }

  const entries: string[] = [];
  let remainingChars = maxPromptMemoryChars;

  for (const entry of context.projectMemory.entries) {
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
    pageTitle: context.projectMemory.page?.title ?? null,
    pageSlug: context.projectMemory.page?.slug ?? null,
    totalEntryCount: context.projectMemory.entries.length,
    includedEntryCount: entries.length,
    omittedEntryCount: Math.max(0, context.projectMemory.entries.length - entries.length),
    entries
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
      summary: "string"
    },
    highlights: ["optional string"]
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
        side: "new | old"
      },
      suggestion: {
        replacement: "string",
        startLine: 1,
        endLine: 1
      },
      replyInDiscussion: false
    }
  ],
  priorDispositions: [
    {
      threadId: "string",
      action: "keep | update | resolve | reply",
      replyBody: "optional string",
      resolution: "optional resolved | dismissed"
    }
  ]
};
