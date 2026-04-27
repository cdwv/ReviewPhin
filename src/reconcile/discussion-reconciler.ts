import type { Logger } from "pino";

import { isBotUser } from "../gitlab/bot-user.js";
import { appendSuggestion, buildDiffPosition, renderSuggestionMarkdown } from "../gitlab/positions.js";
import { GitLabApiError, type GitLabClient } from "../gitlab/client.js";
import type {
  GitLabDiscussion,
  GitLabDiffPosition,
  GitLabNote,
  GitLabUser,
  HydratedMergeRequestContext
} from "../gitlab/types.js";
import type { Storage, DiscussionMappingRecord, TenantRecord } from "../storage/types.js";
import { createFindingFingerprint, createFindingIdentityKey } from "../utils/ids.js";
import { firstNonEmptyLine } from "../utils/text.js";
import { buildReviewSummaryNote, findLatestReviewSummaryNote, isReviewSummaryNoteBody } from "../review/summary.js";
import type {
  PriorDisposition,
  ProviderThreadContext,
  ReviewAnchor,
  ReviewFinding,
  ReviewResult
} from "../review/types.js";

interface KnownThread {
  threadId: string;
  discussionId: string;
  discussion: GitLabDiscussion;
  mapping: DiscussionMappingRecord | null;
  latestBotNote: GitLabNote | null;
  anchor: ReviewAnchor | null;
  resolved: boolean;
  title: string;
  body: string;
  humanReplies: Array<{
    noteId: number;
    authorUsername: string;
    body: string;
  }>;
}

export interface ReconcileSummary {
  created: number;
  updated: number;
  replied: number;
  resolved: number;
  kept: number;
  summaryNoteAction: "created" | "updated" | null;
}

interface DiscussionReconcilerOptions {
  storage: Storage;
  logger: Logger;
}

type ThreadReconcileAction = "created" | "updated" | "replied" | "resolved" | "kept";

export class DiscussionReconciler {
  private readonly storage: Storage;
  private readonly logger: Logger;

  public constructor(options: DiscussionReconcilerOptions) {
    this.storage = options.storage;
    this.logger = options.logger;
  }

  public async reconcile(input: {
    tenant: TenantRecord;
    context: HydratedMergeRequestContext;
    mappings: DiscussionMappingRecord[];
    reviewRunId: string;
    reviewResult: ReviewResult;
    client: GitLabClient;
  }): Promise<ReconcileSummary> {
    const knownThreads = buildKnownThreads({
      tenant: input.tenant,
      discussions: input.context.discussions,
      mappings: input.mappings
    });

    const threadById = new Map(knownThreads.map((thread) => [thread.threadId, thread]));
    const dispositionByThreadId = new Map(
      input.reviewResult.priorDispositions.map((disposition) => [disposition.threadId, disposition])
    );

    const summary: ReconcileSummary = {
      created: 0,
      updated: 0,
      replied: 0,
      resolved: 0,
      kept: 0,
      summaryNoteAction: null
    };

    const referencedThreadIds = new Set<string>();

    for (const finding of input.reviewResult.findings) {
      const matchedThread = finding.priorThreadId ? threadById.get(finding.priorThreadId) ?? null : null;
      if (matchedThread) {
        referencedThreadIds.add(matchedThread.threadId);
        const disposition = dispositionByThreadId.get(matchedThread.threadId);
        const action = await this.applyFindingToExistingThread({
          tenant: input.tenant,
          context: input.context,
          client: input.client,
          reviewRunId: input.reviewRunId,
          thread: matchedThread,
          finding,
          disposition
        });
        summary[action] += 1;
        continue;
      }

      await this.createNewThread({
        tenant: input.tenant,
        context: input.context,
        client: input.client,
        reviewRunId: input.reviewRunId,
        finding
      });
      summary.created += 1;
    }

    for (const disposition of input.reviewResult.priorDispositions) {
      if (referencedThreadIds.has(disposition.threadId)) {
        continue;
      }

      const thread = threadById.get(disposition.threadId);
      if (!thread) {
        continue;
      }

      if (disposition.action === "resolve") {
        if (!thread.resolved) {
          await input.client.resolveDiscussion(
            input.tenant.projectId,
            input.context.mergeRequest.iid,
            thread.discussionId,
            true
          );
        }

        await this.persistThreadState({
          tenant: input.tenant,
          context: input.context,
          reviewRunId: input.reviewRunId,
          thread,
          note: thread.latestBotNote ?? thread.discussion.notes[0] ?? null,
          identityKey: thread.mapping?.identityKey ?? createFindingIdentityKey({
            title: thread.title,
            category: thread.mapping?.category ?? "correctness",
            path: thread.anchor?.path,
            startLine: thread.anchor?.startLine,
            endLine: thread.anchor?.endLine,
            side: thread.anchor?.side
          }),
          fingerprint:
            thread.mapping?.findingFingerprint ??
            createFindingFingerprint({
              identityKey:
                thread.mapping?.identityKey ??
                createFindingIdentityKey({
                  title: thread.title,
                  category: thread.mapping?.category ?? "correctness",
                  path: thread.anchor?.path,
                  startLine: thread.anchor?.startLine,
                  endLine: thread.anchor?.endLine,
                  side: thread.anchor?.side
                }),
              body: thread.body
            }),
          title: thread.title,
          body: thread.body,
          severity: thread.mapping?.severity ?? "medium",
          category: thread.mapping?.category ?? "correctness",
          position: thread.discussion.notes[0]?.position ?? null,
          status: "resolved"
        });
        summary.resolved += 1;
      } else if (disposition.action === "reply" && disposition.replyBody) {
        const note = await input.client.replyToDiscussion(
          input.tenant.projectId,
          input.context.mergeRequest.iid,
          thread.discussionId,
          disposition.replyBody
        );
        await this.persistThreadState({
          tenant: input.tenant,
          context: input.context,
          reviewRunId: input.reviewRunId,
          thread,
          note,
          identityKey:
            thread.mapping?.identityKey ??
            createFindingIdentityKey({
              title: thread.title,
              category: thread.mapping?.category ?? "correctness",
              path: thread.anchor?.path,
              startLine: thread.anchor?.startLine,
              endLine: thread.anchor?.endLine,
              side: thread.anchor?.side
            }),
          fingerprint:
            thread.mapping?.findingFingerprint ??
            createFindingFingerprint({
              identityKey:
                thread.mapping?.identityKey ??
                createFindingIdentityKey({
                  title: thread.title,
                  category: thread.mapping?.category ?? "correctness",
                  path: thread.anchor?.path,
                  startLine: thread.anchor?.startLine,
                  endLine: thread.anchor?.endLine,
                  side: thread.anchor?.side
                }),
              body: disposition.replyBody
            }),
          title: thread.title,
          body: disposition.replyBody,
          severity: thread.mapping?.severity ?? "medium",
          category: thread.mapping?.category ?? "correctness",
          position: note.position ?? thread.discussion.notes[0]?.position ?? null,
          status: thread.resolved ? "resolved" : "open"
        });
        summary.replied += 1;
      }
    }

    summary.summaryNoteAction = await this.syncSummaryNote(input);

    return summary;
  }

  private async applyFindingToExistingThread(input: {
    tenant: TenantRecord;
    context: HydratedMergeRequestContext;
    client: GitLabClient;
    reviewRunId: string;
    thread: KnownThread;
    finding: ReviewFinding;
    disposition: PriorDisposition | undefined;
  }): Promise<ThreadReconcileAction> {
    const body = renderFindingBody(input.finding);
    const identityKey = createFindingIdentityKey({
      title: input.finding.title,
      category: input.finding.category,
      path: input.finding.anchor?.path,
      startLine: input.finding.anchor?.startLine,
      endLine: input.finding.anchor?.endLine,
      side: input.finding.anchor?.side
    });
    const fingerprint = createFindingFingerprint({
      identityKey,
      body,
      suggestionReplacement: input.finding.suggestion?.replacement
    });

    const shouldReply =
      input.disposition?.action === "reply" ||
      Boolean(input.finding.replyInDiscussion) ||
      !input.thread.latestBotNote ||
      input.thread.resolved;

    if (input.thread.mapping?.findingFingerprint === fingerprint && !shouldReply) {
      await this.persistThreadState({
        tenant: input.tenant,
        context: input.context,
        reviewRunId: input.reviewRunId,
        thread: input.thread,
        note: input.thread.latestBotNote ?? input.thread.discussion.notes[0] ?? null,
        identityKey,
        fingerprint,
        title: input.finding.title,
        body,
        severity: input.finding.severity,
        category: input.finding.category,
        position: input.thread.discussion.notes[0]?.position ?? null,
        status: input.thread.resolved ? "resolved" : "open"
      });
      return "kept";
    }

    if (shouldReply) {
      const note = await input.client.replyToDiscussion(
        input.tenant.projectId,
        input.context.mergeRequest.iid,
        input.thread.discussionId,
        input.disposition?.replyBody ?? body
      );
      await this.persistThreadState({
        tenant: input.tenant,
        context: input.context,
        reviewRunId: input.reviewRunId,
        thread: input.thread,
        note,
        identityKey,
        fingerprint,
        title: input.finding.title,
        body: input.disposition?.replyBody ?? body,
        severity: input.finding.severity,
        category: input.finding.category,
        position: note.position ?? input.thread.discussion.notes[0]?.position ?? null,
        status: input.thread.resolved ? "resolved" : "open"
      });
      return "replied";
    }

    const latestBotNote = input.thread.latestBotNote;
    if (!latestBotNote) {
      throw new Error(`Expected a bot-authored note for discussion ${input.thread.discussionId}`);
    }

    const updatedNote = await input.client.updateDiscussionNote(
      input.tenant.projectId,
      input.context.mergeRequest.iid,
      input.thread.discussionId,
      latestBotNote.id,
      body
    );
    await this.persistThreadState({
      tenant: input.tenant,
      context: input.context,
      reviewRunId: input.reviewRunId,
      thread: input.thread,
      note: updatedNote,
      identityKey,
      fingerprint,
      title: input.finding.title,
      body,
      severity: input.finding.severity,
      category: input.finding.category,
      position: updatedNote.position ?? input.thread.discussion.notes[0]?.position ?? null,
      status: input.thread.resolved ? "resolved" : "open"
    });
    return "updated";
  }

  private async createNewThread(input: {
    tenant: TenantRecord;
    context: HydratedMergeRequestContext;
    client: GitLabClient;
    reviewRunId: string;
    finding: ReviewFinding;
  }): Promise<void> {
    const body = renderFindingBody(input.finding);
    const position = input.finding.anchor
      ? buildDiffPosition(input.finding.anchor, input.context.changes, input.context.latestVersion)
      : null;
    const createdThread = await this.createDiscussion({
      client: input.client,
      projectId: input.tenant.projectId,
      mergeRequestIid: input.context.mergeRequest.iid,
      reviewRunId: input.reviewRunId,
      finding: input.finding,
      body,
      position
    });
    const { discussion, position: persistedPosition } = createdThread;

    const note = discussion.notes[0];
    if (!note) {
      throw new Error(`GitLab discussion ${discussion.id} did not include a root note`);
    }

    const identityKey = createFindingIdentityKey({
      title: input.finding.title,
      category: input.finding.category,
      path: input.finding.anchor?.path,
      startLine: input.finding.anchor?.startLine,
      endLine: input.finding.anchor?.endLine,
      side: input.finding.anchor?.side
    });
    const fingerprint = createFindingFingerprint({
      identityKey,
      body,
      suggestionReplacement: input.finding.suggestion?.replacement
    });

    await this.storage.upsertDiscussionMapping({
      tenantId: input.tenant.id,
      projectId: input.tenant.projectId,
      mergeRequestIid: input.context.mergeRequest.iid,
      identityKey,
      findingFingerprint: fingerprint,
      title: input.finding.title,
      severity: input.finding.severity,
      category: input.finding.category,
      body,
      gitlabDiscussionId: discussion.id,
      gitlabNoteId: note.id,
      anchorJson: input.finding.anchor ? JSON.stringify(input.finding.anchor) : null,
      positionJson: persistedPosition ? JSON.stringify(persistedPosition) : null,
      botDiscussion: true,
      botNote: true,
      noteAuthorId: note.author.id,
      noteAuthorUsername: note.author.username,
      status: note.resolved ? "resolved" : "open",
      lastReviewRunId: input.reviewRunId
    });
  }

  private async createDiscussion(input: {
    client: GitLabClient;
    projectId: number;
    mergeRequestIid: number;
    reviewRunId: string;
    finding: ReviewFinding;
    body: string;
    position: GitLabDiffPosition | null;
  }): Promise<{ discussion: GitLabDiscussion; position: GitLabDiffPosition | null }> {
    if (!input.position) {
      return {
        discussion: await input.client.createMergeRequestDiscussion(input.projectId, input.mergeRequestIid, {
          body: input.body
        }),
        position: null
      };
    }

    try {
      return {
        discussion: await input.client.createMergeRequestDiscussion(input.projectId, input.mergeRequestIid, {
          body: input.body,
          position: input.position
        }),
        position: input.position
      };
    } catch (error) {
      if (!isInvalidDiffPositionError(error)) {
        throw error;
      }

      this.logger.warn(
        {
          err: error,
          reviewRunId: input.reviewRunId,
          projectId: input.projectId,
          mergeRequestIid: input.mergeRequestIid,
          findingTitle: input.finding.title,
          anchor: input.finding.anchor,
          position: input.position
        },
        "GitLab rejected diff note position; retrying as an overview thread"
      );

      return {
        discussion: await input.client.createMergeRequestDiscussion(input.projectId, input.mergeRequestIid, {
          body: input.body
        }),
        position: null
      };
    }
  }

  private async persistThreadState(input: {
    tenant: TenantRecord;
    context: HydratedMergeRequestContext;
    reviewRunId: string;
    thread: KnownThread;
    note: GitLabNote | null;
    identityKey: string;
    fingerprint: string;
    title: string;
    body: string;
    severity: string;
    category: string;
    position: GitLabDiffPosition | null;
    status: "open" | "resolved";
  }): Promise<void> {
    const rootNote = input.thread.discussion.notes[0];
    if (!rootNote || !input.note) {
      return;
    }

    await this.storage.upsertDiscussionMapping({
      ...(input.thread.mapping ? { id: input.thread.mapping.id } : {}),
      tenantId: input.tenant.id,
      projectId: input.tenant.projectId,
      mergeRequestIid: input.context.mergeRequest.iid,
      identityKey: input.identityKey,
      findingFingerprint: input.fingerprint,
      title: input.title,
      severity: input.severity,
      category: input.category,
      body: input.body,
      gitlabDiscussionId: input.thread.discussionId,
      gitlabNoteId: input.note.id,
      anchorJson: input.thread.anchor ? JSON.stringify(input.thread.anchor) : null,
      positionJson: input.position ? JSON.stringify(input.position) : null,
      botDiscussion: isBotUser(rootNote.author, input.tenant),
      botNote: isBotUser(input.note.author, input.tenant),
      noteAuthorId: input.note.author.id,
      noteAuthorUsername: input.note.author.username,
      status: input.status,
      lastReviewRunId: input.reviewRunId
    });
  }

  private async syncSummaryNote(input: {
    tenant: TenantRecord;
    context: HydratedMergeRequestContext;
    reviewRunId: string;
    reviewResult: ReviewResult;
    client: GitLabClient;
  }): Promise<ReconcileSummary["summaryNoteAction"]> {
    const body = buildReviewSummaryNote({
      context: input.context,
      reviewResult: input.reviewResult
    });
    const existingNote = findLatestReviewSummaryNote(input.context.notes, (note) => isBotUser(note.author, input.tenant));

    if (existingNote) {
      await input.client.updateMergeRequestNote(
        input.tenant.projectId,
        input.context.mergeRequest.iid,
        existingNote.id,
        body
      );
      return "updated";
    }

    await input.client.createMergeRequestNote(input.tenant.projectId, input.context.mergeRequest.iid, body);
    return "created";
  }
}

function isInvalidDiffPositionError(error: unknown): error is GitLabApiError {
  return (
    error instanceof GitLabApiError &&
    error.status === 400 &&
    /\bline_code\b|\bvalid line code\b|\bposition\b[\s\S]*\b(?:invalid|incomplete)\b/i.test(error.responseBody)
  );
}

export function buildProviderThreads(input: {
  tenant: TenantRecord;
  discussions: GitLabDiscussion[];
  mappings: DiscussionMappingRecord[];
}): ProviderThreadContext[] {
  return buildKnownThreads(input).map((thread) => ({
    threadId: thread.threadId,
    discussionId: thread.discussionId,
    noteId: thread.latestBotNote?.id ?? thread.discussion.notes[0]?.id ?? 0,
    title: thread.title,
    body: thread.body,
    anchor: thread.anchor,
    resolved: thread.resolved,
    humanReplies: thread.humanReplies
  }));
}

function buildKnownThreads(input: {
  tenant: TenantRecord;
  discussions: GitLabDiscussion[];
  mappings: DiscussionMappingRecord[];
}): KnownThread[] {
  const mappingByDiscussionId = new Map(
    input.mappings.map((mapping) => [mapping.gitlabDiscussionId, mapping] as const)
  );

  const threads: KnownThread[] = [];

  for (const discussion of input.discussions) {
    const rootNote = discussion.notes[0];
    if (!rootNote) {
      continue;
    }

    const mapping = mappingByDiscussionId.get(discussion.id) ?? null;
    const botOwnedDiscussion = isBotUser(rootNote.author, input.tenant);
    if (!botOwnedDiscussion) {
      continue;
    }
    if (isReviewSummaryNoteBody(rootNote.body)) {
      continue;
    }

    const latestBotNote =
      discussion.notes
        .slice()
        .reverse()
        .find((note) => isBotUser(note.author, input.tenant)) ?? null;

    const anchor = mapping?.anchorJson
      ? (JSON.parse(mapping.anchorJson) as ReviewAnchor)
      : extractAnchorFromNote(latestBotNote ?? rootNote);

    const threadTitle = stripTitleDecoration(mapping?.title ?? firstNonEmptyLine(mapping?.body ?? latestBotNote?.body ?? rootNote.body));
    const threadBody = mapping?.body ?? latestBotNote?.body ?? rootNote.body;

    threads.push({
      threadId: mapping?.id ?? `discussion:${discussion.id}`,
      discussionId: discussion.id,
      discussion,
      mapping,
      latestBotNote,
      anchor,
      resolved: discussion.notes.some((note) => note.resolved === true),
      title: threadTitle || "Review finding",
      body: threadBody,
      humanReplies: discussion.notes
        .filter((note) => !isBotUser(note.author, input.tenant))
        .map((note) => ({
          noteId: note.id,
          authorUsername: note.author.username,
          body: note.body
        }))
    });
  }

  return threads;
}

function renderFindingBody(finding: ReviewFinding): string {
  const suggestion = renderSuggestionMarkdown(finding.suggestion, finding.anchor ?? null);
  return appendSuggestion(`**${finding.title.trim()}**\n\n${finding.body.trim()}`, suggestion);
}

function extractAnchorFromNote(note: GitLabNote | null): ReviewAnchor | null {
  if (!note?.position) {
    return null;
  }

  if (note.position.new_line) {
    return {
      path: note.position.new_path,
      oldPath: note.position.old_path,
      startLine: note.position.new_line,
      endLine: note.position.new_line,
      side: "new"
    };
  }

  if (note.position.old_line) {
    return {
      path: note.position.old_path,
      oldPath: note.position.old_path,
      startLine: note.position.old_line,
      endLine: note.position.old_line,
      side: "old"
    };
  }

  return null;
}

function stripTitleDecoration(value: string): string {
  return value.replace(/^[#*\s`]+/, "").replace(/[*\s`]+$/, "");
}
