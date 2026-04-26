import { isBotUser } from "../gitlab/bot-user.js";
import type { GitLabClient } from "../gitlab/client.js";
import type { GitLabNoteHookPayload } from "../gitlab/types.js";
import { containsReviewCommand, extractReviewCommandInstruction } from "../gitlab/webhook.js";
import type { TenantRecord } from "../storage/types.js";
import type { ProviderThreadContext, ReviewTriggerContext } from "./types.js";

export async function isFollowUpInstructionWebhook(input: {
  payload: GitLabNoteHookPayload;
  tenant: TenantRecord;
  client: Pick<GitLabClient, "listMergeRequestDiscussions">;
}): Promise<boolean> {
  const { payload, tenant, client } = input;
  if (payload.object_attributes.system) {
    return false;
  }

  if (!payload.user || isBotUser(payload.user, tenant)) {
    return false;
  }

  const discussions = await client.listMergeRequestDiscussions(tenant.projectId, payload.merge_request.iid);
  return discussions.some((discussion) => {
    const rootNote = discussion.notes[0];
    if (!rootNote || !isBotUser(rootNote.author, tenant)) {
      return false;
    }

    return discussion.notes.some((note) => note.id === payload.object_attributes.id);
  });
}

export function buildReviewTriggerContext(input: {
  payload: GitLabNoteHookPayload;
  priorThreads: ProviderThreadContext[];
}): ReviewTriggerContext {
  const targetThread =
    input.priorThreads.find((thread) => thread.humanReplies.some((reply) => reply.noteId === input.payload.object_attributes.id)) ??
    null;
  const kind = containsReviewCommand(input.payload.object_attributes.note) ? "review-command" : "follow-up-comment";
  const instruction =
    kind === "review-command"
      ? extractReviewCommandInstruction(input.payload.object_attributes.note)
      : input.payload.object_attributes.note.trim();

  return {
    kind,
    noteId: input.payload.object_attributes.id,
    authorUsername: input.payload.user?.username ?? null,
    body: input.payload.object_attributes.note,
    instruction,
    targetThreadId: targetThread?.threadId ?? null,
    targetDiscussionId: targetThread?.discussionId ?? null,
    targetThreadTitle: targetThread?.title ?? null
  };
}
