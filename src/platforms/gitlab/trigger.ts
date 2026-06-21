import { isReviewSummaryNoteBody } from "../../review/summary.js";
import type {
  CommentReviewTriggerContext,
  ProviderDiscussionContext,
  ResponseTarget,
  TriggerCommentReference,
  WebhookReviewTrigger,
} from "../../review/types.js";
import type {
  PlatformConnectionRecord,
  TenantRecord,
} from "../../storage/contract/index.js";
import { isBotUser } from "./bot-user.js";
import type { GitLabClient } from "./client.js";
import {
  getGitLabConnectionConfig,
  getGitLabTenantConfig,
} from "./tenant-config.js";
import type { GitLabDiscussion, GitLabNoteHookPayload } from "./types.js";
import { containsBotMention, extractBotMentionInstruction } from "./webhook.js";

export async function classifyGitLabWebhookTrigger(input: {
  payload: GitLabNoteHookPayload;
  tenant: TenantRecord;
  connection?: PlatformConnectionRecord;
  client: Pick<GitLabClient, "listCodeReviewDiscussions">;
}): Promise<WebhookReviewTrigger | null> {
  const { payload, tenant, client } = input;
  const tenantConfig = getGitLabTenantConfig(tenant);
  const connectionConfig = getGitLabConnectionConfig(input.connection, tenant);
  if (payload.object_attributes.draft) {
    return null;
  }

  if (payload.object_attributes.system) {
    return null;
  }

  if (!payload.user || isBotUser(payload.user, connectionConfig.botUserId)) {
    return null;
  }

  const discussions = await client.listCodeReviewDiscussions(
    tenantConfig.projectId,
    payload.merge_request.iid,
  );
  const comment = locateTriggerCommentReference(
    discussions,
    payload.object_attributes.id,
  );
  if (comment.kind === "discussion-comment") {
    const discussion =
      discussions.find((entry) => entry.id === comment.discussionId) ?? null;
    const rootNote = discussion?.notes[0];
    if (
      rootNote &&
      isBotUser(rootNote.author, connectionConfig.botUserId) &&
      !isReviewSummaryNoteBody(rootNote.body)
    ) {
      return {
        kind: "follow-up-comment",
        comment,
      };
    }

    if (
      rootNote &&
      isBotUser(rootNote.author, connectionConfig.botUserId) &&
      isReviewSummaryNoteBody(rootNote.body)
    ) {
      return {
        kind: "summary-follow-up",
        comment,
      };
    }
  }

  if (
    !containsBotMention(
      payload.object_attributes.note,
      connectionConfig.botUsername,
    )
  ) {
    return null;
  }

  return {
    kind: "direct-mention",
    comment,
  };
}

export const classifyWebhookTrigger = classifyGitLabWebhookTrigger;

export function buildGitLabReviewTriggerContext(input: {
  payload: GitLabNoteHookPayload;
  tenant: TenantRecord;
  connection?: PlatformConnectionRecord;
  discussions: GitLabDiscussion[];
  priorDiscussions: ProviderDiscussionContext[];
}): CommentReviewTriggerContext {
  const connectionConfig = getGitLabConnectionConfig(
    input.connection,
    input.tenant,
  );
  const comment = locateTriggerCommentReference(
    input.discussions,
    input.payload.object_attributes.id,
  );
  const responseTargetComment = locateResponseTargetReference(
    input.discussions,
    input.payload.object_attributes.id,
  );
  const targetDiscussion =
    input.priorDiscussions.find((discussion) =>
      discussion.humanReplies.some(
        (reply) =>
          reply.platformCommentId === input.payload.object_attributes.id,
      ),
    ) ?? null;
  const kind =
    targetDiscussion !== null
      ? "follow-up-comment"
      : comment.kind === "discussion-comment" &&
          isSummaryDiscussionReply(
            input.discussions,
            comment.discussionId,
            connectionConfig.botUserId,
          )
        ? "summary-follow-up"
        : "direct-mention";
  const instruction =
    kind === "direct-mention"
      ? extractBotMentionInstruction(
          input.payload.object_attributes.note,
          connectionConfig.botUsername,
        )
      : input.payload.object_attributes.note.trim();

  return {
    kind,
    commentId: input.payload.object_attributes.id,
    authorUsername: input.payload.user?.username ?? null,
    body: input.payload.object_attributes.note,
    instruction,
    targetDiscussionId: targetDiscussion?.discussionId ?? null,
    targetPlatformDiscussionId: targetDiscussion?.platformDiscussionId ?? null,
    targetDiscussionTitle: targetDiscussion?.title ?? null,
    responseTarget: buildResponseTarget({
      kind,
      comment: responseTargetComment,
      authorUsername: input.payload.user?.username ?? null,
      body: input.payload.object_attributes.note,
      instruction,
    }),
  };
}

export const buildReviewTriggerContext = buildGitLabReviewTriggerContext;

function isSummaryDiscussionReply(
  discussions: GitLabDiscussion[],
  discussionId: string,
  botUserId: number,
): boolean {
  const discussion =
    discussions.find((entry) => entry.id === discussionId) ?? null;
  const rootNote = discussion?.notes[0];
  return Boolean(
    rootNote &&
    isBotUser(rootNote.author, botUserId) &&
    isReviewSummaryNoteBody(rootNote.body),
  );
}

export function locateTriggerCommentReference(
  discussions: GitLabDiscussion[],
  commentId: number,
): TriggerCommentReference {
  for (const discussion of discussions) {
    if (!discussion.notes.some((note) => note.id === commentId)) {
      continue;
    }

    if (!discussion.individual_note) {
      return {
        kind: "discussion-comment",
        discussionId: discussion.id,
        commentId,
      };
    }
  }

  return {
    kind: "code-review-comment",
    commentId,
  };
}

function locateResponseTargetReference(
  discussions: GitLabDiscussion[],
  commentId: number,
): TriggerCommentReference {
  for (const discussion of discussions) {
    if (discussion.notes.some((note) => note.id === commentId)) {
      return {
        kind: "discussion-comment",
        discussionId: discussion.id,
        commentId,
      };
    }
  }

  return {
    kind: "code-review-comment",
    commentId,
  };
}

function buildResponseTarget(input: {
  kind: CommentReviewTriggerContext["kind"];
  comment: TriggerCommentReference;
  authorUsername: string | null;
  body: string;
  instruction: string | null;
}): ResponseTarget {
  if (input.kind === "summary-follow-up") {
    return {
      kind: "summary-discussion-reply",
      locationType: "summary-discussion",
      triggerKind: input.kind,
      commentId: input.comment.commentId,
      discussionId:
        input.comment.kind === "discussion-comment"
          ? input.comment.discussionId
          : undefined,
      authorUsername: input.authorUsername,
      body: input.body,
      instruction: input.instruction,
    };
  }

  if (input.kind === "follow-up-comment") {
    return {
      kind: "finding-discussion-reply",
      locationType: "finding-discussion",
      triggerKind: input.kind,
      commentId: input.comment.commentId,
      discussionId:
        input.comment.kind === "discussion-comment"
          ? input.comment.discussionId
          : undefined,
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
    discussionId:
      input.comment.kind === "discussion-comment"
        ? input.comment.discussionId
        : undefined,
    authorUsername: input.authorUsername,
    body: input.body,
    instruction: input.instruction,
  };
}
