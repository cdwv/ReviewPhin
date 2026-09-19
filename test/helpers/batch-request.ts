import type { InteractionRequestContext } from "../../src/review/types.js";
export function batchRequest(
  id: number,
  body: string,
  discussionId?: string,
): InteractionRequestContext {
  const kind = discussionId ? "follow-up-comment" : "direct-mention";
  return {
    id: `request-${id}`,
    trigger: {
      kind,
      commentId: id,
      authorUsername: "developer",
      body,
      instruction: body,
      targetDiscussionId: discussionId ?? null,
      targetPlatformDiscussionId: discussionId ?? null,
      targetDiscussionTitle: null,
      responseTarget: {
        kind: discussionId ? "finding-discussion-reply" : "code-review-comment",
        locationType: discussionId
          ? "finding-discussion"
          : "code-review-comment",
        triggerKind: kind,
        commentId: id,
        ...(discussionId ? { discussionId } : {}),
        authorUsername: "developer",
        body,
        instruction: body,
      },
    },
  };
}
