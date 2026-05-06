import { isBotUser } from "../gitlab/bot-user.js";
import type { GitLabClient } from "../gitlab/client.js";
import type {
  GitLabDiscussion,
  TriggerNoteReference,
  GitLabNoteHookPayload,
} from "../gitlab/types.js";
import {
  containsBotMention,
  extractBotMentionInstruction,
} from "../gitlab/webhook.js";
import type { TenantRecord } from "../storage/contract/index.js";
import { isReviewSummaryNoteBody } from "./summary.js";
import type {
  ProviderThreadContext,
  ResponseTarget,
  ReviewTriggerContext,
  WebhookReviewTrigger,
} from "./types.js";

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

  const discussions = await client.listMergeRequestDiscussions(
    tenant.projectId,
    payload.merge_request.iid,
  );
  const note = locateTriggerNoteReference(
    discussions,
    payload.object_attributes.id,
  );
  if (note.kind === "discussion-note") {
    const discussion =
      discussions.find((entry) => entry.id === note.discussionId) ?? null;
    const rootNote = discussion?.notes[0];
    if (
      rootNote &&
      isBotUser(rootNote.author, tenant) &&
      !isReviewSummaryNoteBody(rootNote.body)
    ) {
      return {
        kind: "follow-up-comment",
        note,
      };
    }

    if (
      rootNote &&
      isBotUser(rootNote.author, tenant) &&
      isReviewSummaryNoteBody(rootNote.body)
    ) {
      return {
        kind: "summary-follow-up",
        note,
      };
    }
  }

  if (!containsBotMention(payload.object_attributes.note, tenant.botUsername)) {
    return null;
  }

  return {
    kind: "direct-mention",
    note,
  };
}

export function buildReviewTriggerContext(input: {
  payload: GitLabNoteHookPayload;
  tenant: TenantRecord;
  discussions: GitLabDiscussion[];
  priorThreads: ProviderThreadContext[];
}): ReviewTriggerContext {
  const note = locateTriggerNoteReference(
    input.discussions,
    input.payload.object_attributes.id,
  );
  const responseTargetNote = locateResponseTargetReference(
    input.discussions,
    input.payload.object_attributes.id,
  );
  const targetThread =
    input.priorThreads.find((thread) =>
      thread.humanReplies.some(
        (reply) => reply.noteId === input.payload.object_attributes.id,
      ),
    ) ?? null;
  const kind =
    targetThread !== null
      ? "follow-up-comment"
      : note.kind === "discussion-note" &&
          isSummaryDiscussionReply(
            input.discussions,
            note.discussionId,
            input.tenant,
          )
        ? "summary-follow-up"
        : "direct-mention";
  const instruction =
    kind === "direct-mention"
      ? extractBotMentionInstruction(
          input.payload.object_attributes.note,
          input.tenant.botUsername,
        )
      : input.payload.object_attributes.note.trim();

  return {
    kind,
    noteId: input.payload.object_attributes.id,
    authorUsername: input.payload.user?.username ?? null,
    body: input.payload.object_attributes.note,
    instruction,
    targetThreadId: targetThread?.threadId ?? null,
    targetDiscussionId: targetThread?.discussionId ?? null,
    targetThreadTitle: targetThread?.title ?? null,
    responseTarget: buildResponseTarget({
      kind,
      note: responseTargetNote,
      authorUsername: input.payload.user?.username ?? null,
      body: input.payload.object_attributes.note,
      instruction,
    }),
  };
}

function isSummaryDiscussionReply(
  discussions: GitLabDiscussion[],
  discussionId: string,
  tenant: TenantRecord,
): boolean {
  const discussion =
    discussions.find((entry) => entry.id === discussionId) ?? null;
  const rootNote = discussion?.notes[0];
  return Boolean(
    rootNote &&
    isBotUser(rootNote.author, tenant) &&
    isReviewSummaryNoteBody(rootNote.body),
  );
}

export function locateTriggerNoteReference(
  discussions: GitLabDiscussion[],
  noteId: number,
): TriggerNoteReference {
  for (const discussion of discussions) {
    if (!discussion.notes.some((note) => note.id === noteId)) {
      continue;
    }

    if (!discussion.individual_note) {
      return {
        kind: "discussion-note",
        discussionId: discussion.id,
        noteId,
      };
    }
  }

  return {
    kind: "merge-request-note",
    noteId,
  };
}

function locateResponseTargetReference(
  discussions: GitLabDiscussion[],
  noteId: number,
): TriggerNoteReference {
  for (const discussion of discussions) {
    if (discussion.notes.some((note) => note.id === noteId)) {
      return {
        kind: "discussion-note",
        discussionId: discussion.id,
        noteId,
      };
    }
  }

  return {
    kind: "merge-request-note",
    noteId,
  };
}

function buildResponseTarget(input: {
  kind: ReviewTriggerContext["kind"];
  note: TriggerNoteReference;
  authorUsername: string | null;
  body: string;
  instruction: string | null;
}): ResponseTarget {
  if (input.kind === "summary-follow-up") {
    return {
      kind: "summary-discussion-reply",
      locationType: "summary-discussion",
      triggerKind: input.kind,
      noteId: input.note.noteId,
      discussionId:
        input.note.kind === "discussion-note"
          ? input.note.discussionId
          : undefined,
      authorUsername: input.authorUsername,
      body: input.body,
      instruction: input.instruction,
    };
  }

  if (input.kind === "follow-up-comment") {
    return {
      kind: "finding-thread-reply",
      locationType: "finding-thread",
      triggerKind: input.kind,
      noteId: input.note.noteId,
      discussionId:
        input.note.kind === "discussion-note"
          ? input.note.discussionId
          : undefined,
      authorUsername: input.authorUsername,
      body: input.body,
      instruction: input.instruction,
    };
  }

  return {
    kind:
      input.note.kind === "discussion-note"
        ? "discussion-reply"
        : "merge-request-note",
    locationType:
      input.note.kind === "discussion-note"
        ? "discussion-note"
        : "merge-request-note",
    triggerKind: input.kind,
    noteId: input.note.noteId,
    discussionId:
      input.note.kind === "discussion-note"
        ? input.note.discussionId
        : undefined,
    authorUsername: input.authorUsername,
    body: input.body,
    instruction: input.instruction,
  };
}
