import { isReviewSummaryNoteBody } from "../../review/summary.js";
import type {
  ProviderThreadContext,
  ResponseTarget,
  ReviewTriggerContext,
  TriggerNoteReference,
  WebhookReviewTrigger,
} from "../../review/types.js";
import type { TenantRecord } from "../../storage/contract/index.js";
import { isBotUser } from "./bot-user.js";
import type { GitLabClient } from "./client.js";
import { getGitLabTenantConfig } from "./tenant-config.js";
import type { GitLabDiscussion, GitLabNoteHookPayload } from "./types.js";
import {
  containsBotMention,
  extractBotMentionInstruction,
} from "./webhook.js";

export async function classifyGitLabWebhookTrigger(input: {
  payload: GitLabNoteHookPayload;
  tenant: TenantRecord;
  client: Pick<GitLabClient, "listCodeReviewDiscussions">;
}): Promise<WebhookReviewTrigger | null> {
  const { payload, tenant, client } = input;
  const tenantConfig = getGitLabTenantConfig(tenant);
  if (payload.object_attributes.draft) {
    return null;
  }

  if (payload.object_attributes.system) {
    return null;
  }

  if (!payload.user || isBotUser(payload.user, tenant)) {
    return null;
  }

  const discussions = await client.listCodeReviewDiscussions(
    tenantConfig.projectId,
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

  if (
    !containsBotMention(payload.object_attributes.note, tenantConfig.botUsername)
  ) {
    return null;
  }

  return {
    kind: "direct-mention",
    note,
  };
}

export const classifyWebhookTrigger = classifyGitLabWebhookTrigger;

export function buildGitLabReviewTriggerContext(input: {
  payload: GitLabNoteHookPayload;
  tenant: TenantRecord;
  discussions: GitLabDiscussion[];
  priorThreads: ProviderThreadContext[];
}): ReviewTriggerContext {
  const tenantConfig = getGitLabTenantConfig(input.tenant);
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
          tenantConfig.botUsername,
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

export const buildReviewTriggerContext = buildGitLabReviewTriggerContext;

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
    kind: "code-review-note",
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
    kind: "code-review-note",
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
        : "code-review-note",
    locationType:
      input.note.kind === "discussion-note"
        ? "discussion-note"
        : "code-review-note",
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
