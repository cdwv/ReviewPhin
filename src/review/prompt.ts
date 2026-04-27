import type { ReviewContext } from "./types.js";
import { loadReviewPromptFile } from "./prompt-files.js";
import { isReviewSummaryNoteBody } from "./summary.js";
import { truncate } from "../utils/text.js";

export function buildReviewPrompt(context: ReviewContext): string {
  const compactContext = {
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
            mergeReadiness: context.scope.previousReview.mergeReadiness,
            findings: context.scope.previousReview.findings
          }
        : null,
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
    mergeRequestNotes: context.notes.filter((note) => !isReviewSummaryNoteBody(note.body)).slice(0, 50).map((note) => ({
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

  return [
    loadReviewPromptFile("main.md"),
    "",
    loadReviewPromptFile(getModePromptFile(context)),
    "",
    "JSON schema:",
     JSON.stringify(
        {
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
            replyBody: "optional string"
          }
        ]
      },
       null,
       2
     ),
    "",
    "Suggestion guidance:",
    "- Prefer `suggestion` when you can provide a concrete, low-risk code replacement.",
    "- Suggestions must target exact new-side diff lines and the replacement text must be raw code only.",
    "",
    "Context:",
    JSON.stringify(compactContext, null, 2)
  ].join("\n");
}

function getModePromptFile(context: ReviewContext): "first-pass-full.md" | "incremental-rereview.md" | "follow-up-thread.md" {
  switch (context.scope.mode) {
    case "incremental-rereview":
      return "incremental-rereview.md";
    case "follow-up-thread":
      return "follow-up-thread.md";
    default:
      return "first-pass-full.md";
  }
}
