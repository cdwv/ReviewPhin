import { isBotUser } from "../gitlab/bot-user.js";
import type { GitLabClient } from "../gitlab/client.js";
import type { GitLabDiscussion, TriggerNoteReference, GitLabNoteHookPayload } from "../gitlab/types.js";
import { containsBotMention, extractBotMentionInstruction } from "../gitlab/webhook.js";
import type { TenantRecord } from "../storage/types.js";
import { isReviewSummaryNoteBody } from "./summary.js";
import type { ProviderThreadContext, ReviewTriggerContext, WebhookReviewTrigger } from "./types.js";

export async function classifyWebhookTrigger(input: {
  payload: GitLabNoteHookPayload;
  tenant: TenantRecord;
  client: Pick<GitLabClient, "listMergeRequestDiscussions">;
}): Promise<WebhookReviewTrigger | null> {
  const { payload, tenant, client } = input;
  if (payload.object_attributes.draft) {
    return null;
  }

  if (payload.object_attributes.system) {
    return null;
  }

  if (!payload.user || isBotUser(payload.user, tenant)) {
    return null;
  }

  const discussions = await client.listMergeRequestDiscussions(tenant.projectId, payload.merge_request.iid);
  const note = locateTriggerNoteReference(discussions, payload.object_attributes.id);
  if (note.kind === "discussion-note") {
    const discussion = discussions.find((entry) => entry.id === note.discussionId) ?? null;
    const rootNote = discussion?.notes[0];
    if (rootNote && isBotUser(rootNote.author, tenant) && !isReviewSummaryNoteBody(rootNote.body)) {
      return {
        kind: "follow-up-comment",
        note
      };
    }
  }

  if (!containsBotMention(payload.object_attributes.note, tenant.botUsername)) {
    return null;
  }

  return {
    kind: "direct-mention",
    note
  };
}

export function buildReviewTriggerContext(input: {
  payload: GitLabNoteHookPayload;
  tenant: TenantRecord;
  priorThreads: ProviderThreadContext[];
}): ReviewTriggerContext {
  const targetThread =
    input.priorThreads.find((thread) => thread.humanReplies.some((reply) => reply.noteId === input.payload.object_attributes.id)) ??
    null;
  const kind = targetThread ? "follow-up-comment" : "direct-mention";
  const instruction =
    kind === "direct-mention"
      ? extractBotMentionInstruction(input.payload.object_attributes.note, input.tenant.botUsername)
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

export function locateTriggerNoteReference(
  discussions: GitLabDiscussion[],
  noteId: number
): TriggerNoteReference {
  for (const discussion of discussions) {
    if (!discussion.notes.some((note) => note.id === noteId)) {
      continue;
    }

    if (!discussion.individual_note) {
      return {
        kind: "discussion-note",
        discussionId: discussion.id,
        noteId
      };
    }
  }

  return {
    kind: "merge-request-note",
    noteId
  };
}
