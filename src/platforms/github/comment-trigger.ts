import { z } from "zod";

import type {
  CommentReviewTriggerContext,
  CommentReviewTriggerKind,
  ProviderDiscussionContext,
  ResponseTarget,
  TriggerCommentReference,
} from "../../review/types.js";
import type { InteractionJobRecord } from "../../storage/contract/current.js";
import type { GitHubWebhookPayload } from "./webhook.js";

const triggerCommentReferenceSchema = z.union([
  z.object({
    kind: z.literal("code-review-comment"),
    commentId: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("discussion-comment"),
    discussionId: z.string().min(1),
    commentId: z.number().int().positive(),
  }),
]);

export const githubCommentTriggerSchema = z.object({
  kind: z.literal("github-comment"),
  deliveryId: z.string().min(1),
  eventName: z.enum(["issue_comment", "pull_request_review_comment"]),
  triggerKind: z.enum([
    "direct-mention",
    "follow-up-comment",
    "summary-follow-up",
  ]),
  commentId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  pullRequestNumber: z.number().int().positive(),
  authorUsername: z.string().min(1).nullable(),
  body: z.string(),
  instruction: z.string().nullable(),
  comment: triggerCommentReferenceSchema.optional(),
});

export type GitHubCommentTrigger = z.infer<typeof githubCommentTriggerSchema>;

export function classifyGitHubCommentCommand(input: {
  payload: GitHubWebhookPayload;
  appSlug: string;
}): { kind: "direct-mention"; instruction: string } | null {
  if (
    !["issue_comment", "pull_request_review_comment"].includes(
      input.payload.eventName,
    ) ||
    input.payload.action !== "created" ||
    input.payload.pullRequestNumber === null ||
    input.payload.commentId === null ||
    input.payload.commentBody === null
  ) {
    return null;
  }
  if (
    input.payload.eventName === "issue_comment" &&
    !input.payload.issueIsPullRequest
  ) {
    return null;
  }
  if (
    input.payload.commentAuthorLogin?.toLowerCase() ===
      `${input.appSlug}[bot]`.toLowerCase() ||
    input.payload.commentAuthorType?.toLowerCase() === "bot"
  ) {
    return null;
  }

  const instruction = extractGitHubReviewCommand(
    input.payload.commentBody,
    input.appSlug,
  );
  return instruction === null
    ? null
    : { kind: "direct-mention", instruction };
}

export function extractGitHubReviewCommand(
  body: string,
  appSlug: string,
): string | null {
  const slash = /^\s*\/reviewphin(?:\s+([\s\S]*?))?\s*$/i.exec(body);
  if (slash) {
    return slash[1]?.trim() ?? "";
  }

  const aliases = new Set([
    "reviewphin",
    appSlug.toLowerCase(),
    `${appSlug.toLowerCase()}[bot]`,
  ]);
  for (const alias of aliases) {
    const pattern = new RegExp(
      `(^|\\s)@${escapeRegExp(alias)}(?=\\s|$|[,:;.!?])`,
      "i",
    );
    if (!pattern.test(body)) {
      continue;
    }
    return body.replace(pattern, "$1").trim();
  }
  return null;
}

export function createGitHubCommentTriggerJson(input: {
  payload: GitHubWebhookPayload;
  triggerKind: CommentReviewTriggerKind;
  comment: TriggerCommentReference;
  instruction: string | null;
}): string {
  return JSON.stringify(
    githubCommentTriggerSchema.parse({
      kind: "github-comment",
      deliveryId: input.payload.deliveryId,
      eventName: input.payload.eventName,
      triggerKind: input.triggerKind,
      commentId: input.payload.commentId,
      repositoryId: input.payload.repositoryId,
      pullRequestNumber: input.payload.pullRequestNumber,
      authorUsername: input.payload.commentAuthorLogin,
      body: input.payload.commentBody,
      instruction: input.instruction,
      comment: input.comment,
    }),
  );
}

export function getPersistedGitHubCommentReference(
  triggerJson: string,
): TriggerCommentReference | null {
  const parsed = githubCommentTriggerSchema.safeParse(
    JSON.parse(triggerJson),
  );
  return parsed.success ? (parsed.data.comment ?? null) : null;
}

export function buildGitHubCommentReviewTriggerContext(input: {
  job: InteractionJobRecord;
  priorDiscussions: ProviderDiscussionContext[];
  fallbackDiscussions?: ProviderDiscussionContext[] | undefined;
  locateComment: (commentId: number) => TriggerCommentReference;
}): CommentReviewTriggerContext {
  const trigger = githubCommentTriggerSchema.parse(
    JSON.parse(input.job.triggerJson),
  );
  const comment = trigger.comment ?? input.locateComment(trigger.commentId);
  const discussions = [
    ...input.priorDiscussions,
    ...(input.fallbackDiscussions ?? []),
  ];
  const targetDiscussion =
    discussions.find((discussion) => {
      if (
        trigger.comment?.kind === "discussion-comment" &&
        (discussion.platformDiscussionId === trigger.comment.discussionId ||
          discussion.platformCommentId ===
            getFallbackReviewCommentDiscussionRootId(
              trigger.comment.discussionId,
            ))
      ) {
        return true;
      }
      return discussion.humanReplies.some(
        (reply) => reply.platformCommentId === trigger.commentId,
      );
    }) ?? null;
  const kind =
    (targetDiscussion || trigger.comment?.kind === "discussion-comment") &&
    trigger.triggerKind !== "direct-mention"
      ? "follow-up-comment"
      : trigger.triggerKind;

  return {
    kind,
    commentId: trigger.commentId,
    authorUsername: trigger.authorUsername,
    body: trigger.body,
    instruction: trigger.instruction,
    targetDiscussionId: targetDiscussion?.discussionId ?? null,
    targetPlatformDiscussionId:
      targetDiscussion?.platformDiscussionId ?? null,
    targetDiscussionTitle: targetDiscussion?.title ?? null,
    responseTarget: buildResponseTarget({
      kind,
      comment,
      authorUsername: trigger.authorUsername,
      body: trigger.body,
      instruction: trigger.instruction,
    }),
  };
}

function getFallbackReviewCommentDiscussionRootId(
  discussionId: string,
): number | null {
  const match = /^review-comment:(\d+)$/.exec(discussionId);
  return match ? Number(match[1]) : null;
}

function buildResponseTarget(input: {
  kind: CommentReviewTriggerKind;
  comment: TriggerCommentReference;
  authorUsername: string | null;
  body: string;
  instruction: string | null;
}): ResponseTarget {
  const discussionId =
    input.comment.kind === "discussion-comment"
      ? input.comment.discussionId
      : undefined;
  if (input.kind === "follow-up-comment") {
    return {
      kind: "finding-discussion-reply",
      locationType: "finding-discussion",
      triggerKind: input.kind,
      commentId: input.comment.commentId,
      discussionId,
      authorUsername: input.authorUsername,
      body: input.body,
      instruction: input.instruction,
    };
  }
  if (input.kind === "summary-follow-up") {
    return {
      kind: "summary-discussion-reply",
      locationType: "summary-discussion",
      triggerKind: input.kind,
      commentId: input.comment.commentId,
      discussionId,
      authorUsername: input.authorUsername,
      body: input.body,
      instruction: input.instruction,
    };
  }
  return {
    kind:
      input.comment.kind === "discussion-comment"
        ? "discussion-reply"
        : "code-review-comment",
    locationType:
      input.comment.kind === "discussion-comment"
        ? "discussion-comment"
        : "code-review-comment",
    triggerKind: input.kind,
    commentId: input.comment.commentId,
    discussionId,
    authorUsername: input.authorUsername,
    body: input.body,
    instruction: input.instruction,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
