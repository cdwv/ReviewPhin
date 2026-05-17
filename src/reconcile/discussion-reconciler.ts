import type { Logger } from "pino";

import { isBotUser } from "../gitlab/bot-user.js";
import {
  appendSuggestion,
  buildDiffPosition,
  renderSuggestionMarkdown,
} from "../gitlab/positions.js";
import { GitLabApiError, type GitLabClient } from "../gitlab/client.js";
import type {
  GitLabDiscussion,
  GitLabDiffPosition,
  GitLabDraftNote,
  GitLabNote,
  HydratedMergeRequestContext,
} from "../gitlab/types.js";
import type { StorageHelpers } from "../storage/storage-helpers.js";
import type {
  DiscussionMappingRecord,
  ReviewFindingStatus,
  TenantRecord,
} from "../storage/contract/index.js";
import {
  createId,
  createFindingFingerprint,
  createFindingIdentityKey,
} from "../utils/ids.js";
import { firstNonEmptyLine } from "../utils/text.js";
import {
  buildReviewSummaryNote,
  findLatestReviewSummaryNote,
  isReviewSummaryNoteBody,
} from "../review/summary.js";
import type {
  PriorDisposition,
  ProviderThreadContext,
  ReviewAnchor,
  ReviewFinding,
  ReviewResult,
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
  storage: StorageHelpers;
  logger: Logger;
}

interface PendingDraftThread {
  body: string;
  draftMarker: string;
  draftNoteId: number;
  finding: ReviewFinding;
  fingerprint: string;
  identityKey: string;
  position: GitLabDiffPosition | null;
}

interface PublishedDraftThreadMatch {
  discussion: GitLabDiscussion;
  pending: PendingDraftThread;
  rootNote: GitLabNote;
}

type ThreadReconcileAction =
  | "created"
  | "updated"
  | "replied"
  | "resolved"
  | "kept";

export class DiscussionReconciler {
  private readonly storage: StorageHelpers;
  private readonly logger: Logger;

  public constructor(options: DiscussionReconcilerOptions) {
    this.storage = options.storage;
    this.logger = options.logger;
  }

  public async reconcile(input: {
    tenant: TenantRecord;
    context: HydratedMergeRequestContext;
    mappings: DiscussionMappingRecord[];
    interactionRunId: string;
    reviewResult: ReviewResult;
    client: GitLabClient;
  }): Promise<ReconcileSummary> {
    const knownThreads = buildKnownThreads({
      tenant: input.tenant,
      discussions: input.context.discussions,
      mappings: input.mappings,
    });

    const threadById = new Map(
      knownThreads.map((thread) => [thread.threadId, thread]),
    );
    const dispositionByThreadId = new Map(
      input.reviewResult.priorDispositions.map((disposition) => [
        disposition.threadId,
        disposition,
      ]),
    );

    const summary: ReconcileSummary = {
      created: 0,
      updated: 0,
      replied: 0,
      resolved: 0,
      kept: 0,
      summaryNoteAction: null,
    };

    const referencedThreadIds = collectReferencedThreadIds(
      input.reviewResult.findings,
      threadById,
    );
    const projectedActiveFindings = await this.projectActiveFindings({
      tenant: input.tenant,
      mergeRequestIid: input.context.mergeRequest.iid,
      reviewResult: input.reviewResult,
      threadById,
      referencedThreadIds,
    });

    summary.summaryNoteAction = await this.syncSummaryNote({
      ...input,
      activeFindings: projectedActiveFindings,
    });

    const pendingDraftThreads: PendingDraftThread[] = [];
    try {
      for (const finding of input.reviewResult.findings) {
        const matchedThread = finding.priorThreadId
          ? (threadById.get(finding.priorThreadId) ?? null)
          : null;
        if (matchedThread) {
          const disposition = dispositionByThreadId.get(matchedThread.threadId);
          const action = await this.applyFindingToExistingThread({
            tenant: input.tenant,
            context: input.context,
            client: input.client,
            interactionRunId: input.interactionRunId,
            thread: matchedThread,
            finding,
            disposition,
          });
          summary[action] += 1;
          continue;
        }

        pendingDraftThreads.push(
          await this.createPendingDraftThread({
            tenant: input.tenant,
            context: input.context,
            client: input.client,
            interactionRunId: input.interactionRunId,
            finding,
          }),
        );
        summary.created += 1;
      }
    } catch (error) {
      await this.cleanupPendingDraftThreads({
        tenant: input.tenant,
        mergeRequestIid: input.context.mergeRequest.iid,
        client: input.client,
        pendingDraftThreads,
      });
      throw error;
    }

    if (pendingDraftThreads.length > 0) {
      await this.publishPendingDraftThreads({
        tenant: input.tenant,
        context: input.context,
        client: input.client,
        interactionRunId: input.interactionRunId,
        pendingDraftThreads,
      });
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
            true,
          );
        }

        await this.persistThreadState({
          tenant: input.tenant,
          context: input.context,
          interactionRunId: input.interactionRunId,
          thread,
          note: thread.latestBotNote ?? thread.discussion.notes[0] ?? null,
          identityKey:
            thread.mapping?.identityKey ??
            createFindingIdentityKey({
              title: thread.title,
              category: thread.mapping?.category ?? "correctness",
              path: thread.anchor?.path,
              startLine: thread.anchor?.startLine,
              endLine: thread.anchor?.endLine,
              side: thread.anchor?.side,
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
                  side: thread.anchor?.side,
                }),
              body: thread.body,
            }),
          title: thread.title,
          body: thread.body,
          severity: thread.mapping?.severity ?? "medium",
          category: thread.mapping?.category ?? "correctness",
          position: thread.discussion.notes[0]?.position ?? null,
          discussionStatus: "resolved",
          findingStatus: disposition.resolution ?? "resolved",
        });
        summary.resolved += 1;
      } else if (disposition.action === "reply" && disposition.replyBody) {
        const note = await input.client.replyToDiscussion(
          input.tenant.projectId,
          input.context.mergeRequest.iid,
          thread.discussionId,
          disposition.replyBody,
        );
        await this.persistThreadState({
          tenant: input.tenant,
          context: input.context,
          interactionRunId: input.interactionRunId,
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
              side: thread.anchor?.side,
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
                  side: thread.anchor?.side,
                }),
              body: disposition.replyBody,
            }),
          title: thread.title,
          body: disposition.replyBody,
          severity: thread.mapping?.severity ?? "medium",
          category: thread.mapping?.category ?? "correctness",
          position:
            note.position ?? thread.discussion.notes[0]?.position ?? null,
          discussionStatus: thread.resolved ? "resolved" : "open",
          findingStatus: thread.resolved ? "resolved" : "open",
        });
        summary.replied += 1;
      }
    }

    return summary;
  }

  private async applyFindingToExistingThread(input: {
    tenant: TenantRecord;
    context: HydratedMergeRequestContext;
    client: GitLabClient;
    interactionRunId: string;
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
      side: input.finding.anchor?.side,
    });
    const fingerprint = createFindingFingerprint({
      identityKey,
      body,
      suggestionReplacement: input.finding.suggestion?.replacement,
    });

    const shouldReply =
      input.disposition?.action === "reply" ||
      Boolean(input.finding.replyInDiscussion) ||
      !input.thread.latestBotNote ||
      input.thread.resolved;

    if (
      input.thread.mapping?.findingFingerprint === fingerprint &&
      !shouldReply
    ) {
      await this.persistThreadState({
        tenant: input.tenant,
        context: input.context,
        interactionRunId: input.interactionRunId,
        thread: input.thread,
        note:
          input.thread.latestBotNote ??
          input.thread.discussion.notes[0] ??
          null,
        identityKey,
        fingerprint,
        title: input.finding.title,
        body,
        severity: input.finding.severity,
        category: input.finding.category,
        position: input.thread.discussion.notes[0]?.position ?? null,
        discussionStatus: "open",
        findingStatus: "open",
      });
      return "kept";
    }

    if (shouldReply) {
      if (input.thread.resolved) {
        await input.client.resolveDiscussion(
          input.tenant.projectId,
          input.context.mergeRequest.iid,
          input.thread.discussionId,
          false,
        );
      }

      const note = await input.client.replyToDiscussion(
        input.tenant.projectId,
        input.context.mergeRequest.iid,
        input.thread.discussionId,
        input.disposition?.replyBody ?? body,
      );
      await this.persistThreadState({
        tenant: input.tenant,
        context: input.context,
        interactionRunId: input.interactionRunId,
        thread: input.thread,
        note,
        identityKey,
        fingerprint,
        title: input.finding.title,
        body: input.disposition?.replyBody ?? body,
        severity: input.finding.severity,
        category: input.finding.category,
        position:
          note.position ?? input.thread.discussion.notes[0]?.position ?? null,
        discussionStatus: "open",
        findingStatus: "open",
      });
      return "replied";
    }

    const latestBotNote = input.thread.latestBotNote;
    if (!latestBotNote) {
      throw new Error(
        `Expected a bot-authored note for discussion ${input.thread.discussionId}`,
      );
    }

    const updatedNote = await input.client.updateDiscussionNote(
      input.tenant.projectId,
      input.context.mergeRequest.iid,
      input.thread.discussionId,
      latestBotNote.id,
      body,
    );
    await this.persistThreadState({
      tenant: input.tenant,
      context: input.context,
      interactionRunId: input.interactionRunId,
      thread: input.thread,
      note: updatedNote,
      identityKey,
      fingerprint,
      title: input.finding.title,
      body,
      severity: input.finding.severity,
      category: input.finding.category,
      position:
        updatedNote.position ??
        input.thread.discussion.notes[0]?.position ??
        null,
      discussionStatus: "open",
      findingStatus: "open",
    });
    return "updated";
  }

  private async createPendingDraftThread(input: {
    tenant: TenantRecord;
    context: HydratedMergeRequestContext;
    client: GitLabClient;
    interactionRunId: string;
    finding: ReviewFinding;
  }): Promise<PendingDraftThread> {
    const body = renderFindingBody(input.finding);
    const draftMarker = createId("draftthread");
    const identityKey = createFindingIdentityKey({
      title: input.finding.title,
      category: input.finding.category,
      path: input.finding.anchor?.path,
      startLine: input.finding.anchor?.startLine,
      endLine: input.finding.anchor?.endLine,
      side: input.finding.anchor?.side,
    });
    const fingerprint = createFindingFingerprint({
      identityKey,
      body,
      suggestionReplacement: input.finding.suggestion?.replacement,
    });
    const position = input.finding.anchor
      ? buildDiffPosition(
          input.finding.anchor,
          input.context.changes,
          input.context.latestVersion,
        )
      : null;
    const createdDraft = await this.createDraftDiscussion({
      client: input.client,
      projectId: input.tenant.projectId,
      mergeRequestIid: input.context.mergeRequest.iid,
      interactionRunId: input.interactionRunId,
      finding: input.finding,
      noteBody: appendDraftThreadMarker(body, draftMarker),
      position,
    });
    return {
      draftMarker,
      draftNoteId: createdDraft.draftNote.id,
      finding: input.finding,
      body,
      identityKey,
      fingerprint,
      position: createdDraft.position,
    };
  }

  private async createDraftDiscussion(input: {
    client: GitLabClient;
    projectId: number;
    mergeRequestIid: number;
    interactionRunId: string;
    finding: ReviewFinding;
    noteBody: string;
    position: GitLabDiffPosition | null;
  }): Promise<{
    draftNote: GitLabDraftNote;
    position: GitLabDiffPosition | null;
  }> {
    if (!input.position) {
      return {
        draftNote: await input.client.createMergeRequestDraftNote(
          input.projectId,
          input.mergeRequestIid,
          {
            note: input.noteBody,
          },
        ),
        position: null,
      };
    }

    try {
      return {
        draftNote: await input.client.createMergeRequestDraftNote(
          input.projectId,
          input.mergeRequestIid,
          {
            note: input.noteBody,
            position: input.position,
          },
        ),
        position: input.position,
      };
    } catch (error) {
      if (!isInvalidDiffPositionError(error)) {
        throw error;
      }

      this.logger.warn(
        {
          err: error,
          interactionRunId: input.interactionRunId,
          projectId: input.projectId,
          mergeRequestIid: input.mergeRequestIid,
          findingTitle: input.finding.title,
          anchor: input.finding.anchor,
          position: input.position,
        },
        "GitLab rejected diff note position; retrying as an overview thread",
      );

      return {
        draftNote: await input.client.createMergeRequestDraftNote(
          input.projectId,
          input.mergeRequestIid,
          {
            note: input.noteBody,
          },
        ),
        position: null,
      };
    }
  }

  private async publishPendingDraftThreads(input: {
    tenant: TenantRecord;
    context: HydratedMergeRequestContext;
    client: GitLabClient;
    interactionRunId: string;
    pendingDraftThreads: PendingDraftThread[];
  }): Promise<void> {
    try {
      await input.client.bulkPublishMergeRequestDraftNotes(
        input.tenant.projectId,
        input.context.mergeRequest.iid,
      );
      const matched = await this.findPublishedDraftThreadMatches({
        tenant: input.tenant,
        mergeRequestIid: input.context.mergeRequest.iid,
        client: input.client,
        pendingDraftThreads: input.pendingDraftThreads,
        existingDiscussionIds: new Set(
          input.context.discussions.map((discussion) => discussion.id),
        ),
      });
      await this.persistPublishedDraftThreadMatches({
        tenant: input.tenant,
        context: input.context,
        interactionRunId: input.interactionRunId,
        matches: matched,
      });
    } catch (error) {
      const recovered = await this.tryRecoverPublishedDraftThreads({
        tenant: input.tenant,
        context: input.context,
        client: input.client,
        interactionRunId: input.interactionRunId,
        pendingDraftThreads: input.pendingDraftThreads,
      });
      if (recovered) {
        return;
      }

      await this.cleanupPendingDraftThreads({
        tenant: input.tenant,
        mergeRequestIid: input.context.mergeRequest.iid,
        client: input.client,
        pendingDraftThreads: input.pendingDraftThreads,
      });
      throw error;
    }
  }

  private async tryRecoverPublishedDraftThreads(input: {
    tenant: TenantRecord;
    context: HydratedMergeRequestContext;
    client: GitLabClient;
    interactionRunId: string;
    pendingDraftThreads: PendingDraftThread[];
  }): Promise<boolean> {
    try {
      const matches = await this.findPublishedDraftThreadMatches({
        tenant: input.tenant,
        mergeRequestIid: input.context.mergeRequest.iid,
        client: input.client,
        pendingDraftThreads: input.pendingDraftThreads,
        existingDiscussionIds: new Set(
          input.context.discussions.map((discussion) => discussion.id),
        ),
        maxAttempts: 1,
      });
      await this.persistPublishedDraftThreadMatches({
        tenant: input.tenant,
        context: input.context,
        interactionRunId: input.interactionRunId,
        matches,
      });
      return true;
    } catch {
      return false;
    }
  }

  private async cleanupPendingDraftThreads(input: {
    tenant: TenantRecord;
    mergeRequestIid: number;
    client: GitLabClient;
    pendingDraftThreads: PendingDraftThread[];
  }): Promise<void> {
    for (const pending of input.pendingDraftThreads) {
      try {
        await input.client.deleteMergeRequestDraftNote(
          input.tenant.projectId,
          input.mergeRequestIid,
          pending.draftNoteId,
        );
      } catch (error) {
        if (error instanceof GitLabApiError && error.status === 404) {
          continue;
        }

        this.logger.warn(
          {
            err: error,
            tenantId: input.tenant.id,
            mergeRequestIid: input.mergeRequestIid,
            draftNoteId: pending.draftNoteId,
          },
          "failed to clean up GitLab draft note",
        );
      }
    }
  }

  private async findPublishedDraftThreadMatches(input: {
    tenant: TenantRecord;
    mergeRequestIid: number;
    client: GitLabClient;
    pendingDraftThreads: PendingDraftThread[];
    existingDiscussionIds: ReadonlySet<string>;
    maxAttempts?: number | undefined;
  }): Promise<PublishedDraftThreadMatch[]> {
    const maxAttempts = input.maxAttempts ?? 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const liveDiscussions = await input.client.listMergeRequestDiscussions(
        input.tenant.projectId,
        input.mergeRequestIid,
        { noCache: true },
      );
      const matched = matchPublishedDraftThreads({
        tenant: input.tenant,
        pendingDraftThreads: input.pendingDraftThreads,
        discussions: liveDiscussions,
        existingDiscussionIds: input.existingDiscussionIds,
      });
      if (matched.length === input.pendingDraftThreads.length) {
        return matched;
      }

      lastError = new Error(
        `Expected ${input.pendingDraftThreads.length} published draft discussions but matched ${matched.length}`,
      );
      if (attempt < maxAttempts) {
        await sleep(250 * attempt);
      }
    }

    throw lastError ?? new Error("Failed to match published draft threads");
  }

  private async persistPublishedDraftThreadMatches(input: {
    tenant: TenantRecord;
    context: HydratedMergeRequestContext;
    interactionRunId: string;
    matches: PublishedDraftThreadMatch[];
  }): Promise<void> {
    for (const match of input.matches) {
      await this.persistCreatedThread({
        tenant: input.tenant,
        context: input.context,
        interactionRunId: input.interactionRunId,
        finding: match.pending.finding,
        identityKey: match.pending.identityKey,
        fingerprint: match.pending.fingerprint,
        body: match.pending.body,
        discussion: match.discussion,
        note: match.rootNote,
      });
    }
  }

  private async persistCreatedThread(input: {
    tenant: TenantRecord;
    context: HydratedMergeRequestContext;
    interactionRunId: string;
    finding: ReviewFinding;
    identityKey: string;
    fingerprint: string;
    body: string;
    discussion: GitLabDiscussion;
    note: GitLabNote;
  }): Promise<void> {
    await this.storage.upsertDiscussionMapping({
      tenantId: input.tenant.id,
      projectId: input.tenant.projectId,
      mergeRequestIid: input.context.mergeRequest.iid,
      identityKey: input.identityKey,
      findingFingerprint: input.fingerprint,
      title: input.finding.title,
      severity: input.finding.severity,
      category: input.finding.category,
      body: input.body,
      gitlabDiscussionId: input.discussion.id,
      gitlabNoteId: input.note.id,
      anchorJson: input.finding.anchor
        ? JSON.stringify(input.finding.anchor)
        : null,
      positionJson: input.note.position
        ? JSON.stringify(input.note.position)
        : null,
      botDiscussion: isBotUser(
        input.discussion.notes[0]?.author ?? input.note.author,
        input.tenant,
      ),
      botNote: isBotUser(input.note.author, input.tenant),
      noteAuthorId: input.note.author.id,
      noteAuthorUsername: input.note.author.username,
      status: input.discussion.notes.some((note) => note.resolved === true)
        ? "resolved"
        : "open",
      lastInteractionRunId: input.interactionRunId,
    });
    await this.storage.updateReviewFindingStatus(
      input.tenant.id,
      input.context.mergeRequest.iid,
      input.identityKey,
      "open",
    );
  }

  private async persistThreadState(input: {
    tenant: TenantRecord;
    context: HydratedMergeRequestContext;
    interactionRunId: string;
    thread: KnownThread;
    note: GitLabNote | null;
    identityKey: string;
    fingerprint: string;
    title: string;
    body: string;
    severity: string;
    category: string;
    position: GitLabDiffPosition | null;
    discussionStatus: "open" | "resolved";
    findingStatus: ReviewFindingStatus;
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
      anchorJson: input.thread.anchor
        ? JSON.stringify(input.thread.anchor)
        : null,
      positionJson: input.position ? JSON.stringify(input.position) : null,
      botDiscussion: isBotUser(rootNote.author, input.tenant),
      botNote: isBotUser(input.note.author, input.tenant),
      noteAuthorId: input.note.author.id,
      noteAuthorUsername: input.note.author.username,
      status: input.discussionStatus,
      lastInteractionRunId: input.interactionRunId,
    });

    const updatedFinding = await this.storage.updateReviewFindingStatus(
      input.tenant.id,
      input.context.mergeRequest.iid,
      input.identityKey,
      input.findingStatus,
    );
    const shouldWarnAboutFindingStatusUpdate =
      input.findingStatus !== "open" ||
      input.thread.mapping?.status === "resolved";
    if (!updatedFinding && shouldWarnAboutFindingStatusUpdate) {
      this.logger.warn(
        {
          tenantId: input.tenant.id,
          mergeRequestIid: input.context.mergeRequest.iid,
          identityKey: input.identityKey,
          findingStatus: input.findingStatus,
        },
        "failed to update persisted review finding status",
      );
    }

    await this.retireReplacedFinding({
      tenantId: input.tenant.id,
      mergeRequestIid: input.context.mergeRequest.iid,
      previousIdentityKey: input.thread.mapping?.identityKey ?? null,
      nextIdentityKey: input.identityKey,
    });
  }

  private async syncSummaryNote(input: {
    tenant: TenantRecord;
    context: HydratedMergeRequestContext;
    interactionRunId: string;
    reviewResult: ReviewResult;
    client: GitLabClient;
    activeFindings: SummaryFinding[];
  }): Promise<ReconcileSummary["summaryNoteAction"]> {
    const body = buildReviewSummaryNote({
      context: input.context,
      reviewResult: input.reviewResult,
      activeFindings: input.activeFindings,
    });
    const existingNote = findLatestReviewSummaryNote(
      input.context.notes,
      (note) => isBotUser(note.author, input.tenant),
    );

    if (existingNote) {
      await input.client.updateMergeRequestNote(
        input.tenant.projectId,
        input.context.mergeRequest.iid,
        existingNote.id,
        body,
      );
      return "updated";
    }

    await input.client.createMergeRequestNote(
      input.tenant.projectId,
      input.context.mergeRequest.iid,
      body,
    );
    return "created";
  }

  private async retireReplacedFinding(input: {
    tenantId: string;
    mergeRequestIid: number;
    previousIdentityKey: string | null;
    nextIdentityKey: string;
  }): Promise<void> {
    if (
      !input.previousIdentityKey ||
      input.previousIdentityKey === input.nextIdentityKey
    ) {
      return;
    }

    const retiredFinding = await this.storage.updateReviewFindingStatus(
      input.tenantId,
      input.mergeRequestIid,
      input.previousIdentityKey,
      "resolved",
    );
    if (!retiredFinding) {
      this.logger.warn(
        {
          tenantId: input.tenantId,
          mergeRequestIid: input.mergeRequestIid,
          previousIdentityKey: input.previousIdentityKey,
          nextIdentityKey: input.nextIdentityKey,
          findingStatus: "resolved",
        },
        "failed to retire replaced review finding status",
      );
    }
  }

  private async projectActiveFindings(input: {
    tenant: TenantRecord;
    mergeRequestIid: number;
    reviewResult: ReviewResult;
    threadById: ReadonlyMap<string, KnownThread>;
    referencedThreadIds: ReadonlySet<string>;
  }): Promise<SummaryFinding[]> {
    const activeFindings = new Map<string, SummaryFinding>();
    const persistedFindings = await this.storage.listLatestReviewFindings(
      input.tenant.id,
      input.mergeRequestIid,
    );

    for (const finding of persistedFindings) {
      if (finding.status !== "open") {
        continue;
      }

      activeFindings.set(finding.identityKey, {
        title: finding.title,
        body: finding.body,
        severity: finding.severity as SummaryFinding["severity"],
        category: finding.category as SummaryFinding["category"],
      });
    }

    for (const finding of input.reviewResult.findings) {
      const nextIdentityKey = createFindingIdentityKey({
        title: finding.title,
        category: finding.category,
        path: finding.anchor?.path,
        startLine: finding.anchor?.startLine,
        endLine: finding.anchor?.endLine,
        side: finding.anchor?.side,
      });
      const matchedThread = finding.priorThreadId
        ? (input.threadById.get(finding.priorThreadId) ?? null)
        : null;
      if (matchedThread) {
        const previousIdentityKey = matchedThread.mapping?.identityKey ?? null;
        if (previousIdentityKey && previousIdentityKey !== nextIdentityKey) {
          activeFindings.delete(previousIdentityKey);
        }
      }

      activeFindings.set(nextIdentityKey, {
        title: finding.title,
        body: finding.body,
        severity: finding.severity,
        category: finding.category,
      });
    }

    for (const disposition of input.reviewResult.priorDispositions) {
      if (
        disposition.action !== "resolve" ||
        input.referencedThreadIds.has(disposition.threadId)
      ) {
        continue;
      }

      const thread = input.threadById.get(disposition.threadId);
      if (!thread) {
        continue;
      }

      const identityKey =
        thread.mapping?.identityKey ??
        createFindingIdentityKey({
          title: thread.title,
          category: thread.mapping?.category ?? "correctness",
          path: thread.anchor?.path,
          startLine: thread.anchor?.startLine,
          endLine: thread.anchor?.endLine,
          side: thread.anchor?.side,
        });
      activeFindings.delete(identityKey);
    }

    return [...activeFindings.values()];
  }
}

type SummaryFinding = Pick<
  ReviewFinding,
  "title" | "body" | "severity" | "category"
>;

function isInvalidDiffPositionError(error: unknown): error is GitLabApiError {
  return (
    error instanceof GitLabApiError &&
    error.status === 400 &&
    /\bline_code\b|\bvalid line code\b|\bposition\b[\s\S]*\b(?:invalid|incomplete)\b/i.test(
      error.responseBody,
    )
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
    humanReplies: thread.humanReplies,
  }));
}

function buildKnownThreads(input: {
  tenant: TenantRecord;
  discussions: GitLabDiscussion[];
  mappings: DiscussionMappingRecord[];
}): KnownThread[] {
  const mappingByDiscussionId = new Map(
    input.mappings.map(
      (mapping) => [mapping.gitlabDiscussionId, mapping] as const,
    ),
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

    const threadTitle = stripTitleDecoration(
      mapping?.title ??
        firstNonEmptyLine(
          stripDraftThreadMarker(
            mapping?.body ?? latestBotNote?.body ?? rootNote.body,
          ),
        ),
    );
    const threadBody = stripDraftThreadMarker(
      mapping?.body ?? latestBotNote?.body ?? rootNote.body,
    );

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
          body: note.body,
        })),
    });
  }

  return threads;
}

function renderFindingBody(finding: ReviewFinding): string {
  const suggestion = renderSuggestionMarkdown(
    finding.suggestion,
    finding.anchor ?? null,
  );
  return appendSuggestion(
    `**${finding.title.trim()}**\n\n${finding.body.trim()}`,
    suggestion,
  );
}

const DRAFT_THREAD_MARKER_PREFIX = "gitlab-agentic-review-thread:";
const DRAFT_THREAD_MARKER_PATTERN =
  /\n*\[comment\]: <> \(gitlab-agentic-review-thread:([^\s)]+)\)\s*/g;

function appendDraftThreadMarker(body: string, marker: string): string {
  return `${body}\n\n[comment]: <> (${DRAFT_THREAD_MARKER_PREFIX}${marker})`;
}

function extractDraftThreadMarker(body: string): string | null {
  const match =
    /\[comment\]: <> \(gitlab-agentic-review-thread:([^\s)]+)\)/.exec(body);
  return match?.[1] ?? null;
}

function stripDraftThreadMarker(body: string): string {
  return body.replace(DRAFT_THREAD_MARKER_PATTERN, "\n").trim();
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
      side: "new",
    };
  }

  if (note.position.old_line) {
    return {
      path: note.position.old_path,
      oldPath: note.position.old_path,
      startLine: note.position.old_line,
      endLine: note.position.old_line,
      side: "old",
    };
  }

  return null;
}

function stripTitleDecoration(value: string): string {
  return value.replace(/^[#*\s`]+/, "").replace(/[*\s`]+$/, "");
}

function collectReferencedThreadIds(
  findings: ReadonlyArray<ReviewFinding>,
  threadById: ReadonlyMap<string, KnownThread>,
): Set<string> {
  const referencedThreadIds = new Set<string>();

  for (const finding of findings) {
    if (!finding.priorThreadId || !threadById.has(finding.priorThreadId)) {
      continue;
    }

    referencedThreadIds.add(finding.priorThreadId);
  }

  return referencedThreadIds;
}

function matchPublishedDraftThreads(input: {
  tenant: TenantRecord;
  pendingDraftThreads: ReadonlyArray<PendingDraftThread>;
  discussions: ReadonlyArray<GitLabDiscussion>;
  existingDiscussionIds: ReadonlySet<string>;
}): PublishedDraftThreadMatch[] {
  const availableDiscussions = input.discussions
    .filter((discussion) => {
      if (input.existingDiscussionIds.has(discussion.id)) {
        return false;
      }

      const rootNote = discussion.notes[0];
      if (!rootNote) {
        return false;
      }

      if (!isBotUser(rootNote.author, input.tenant)) {
        return false;
      }

      return !isReviewSummaryNoteBody(rootNote.body);
    })
    .sort(compareDiscussionsByRecency);
  const usedDiscussionIds = new Set<string>();
  const matched: PublishedDraftThreadMatch[] = [];
  const sortedPendingDraftThreads = [...input.pendingDraftThreads].sort(
    (left, right) =>
      Number(right.position !== null) - Number(left.position !== null) ||
      right.draftNoteId - left.draftNoteId,
  );

  for (const pending of sortedPendingDraftThreads) {
    const markerMatches = availableDiscussions.filter((discussion) => {
      if (usedDiscussionIds.has(discussion.id)) {
        return false;
      }

      const rootNote = discussion.notes[0];
      if (!rootNote) {
        return false;
      }

      const rootDraftMarker = extractDraftThreadMarker(rootNote.body);
      return rootDraftMarker === pending.draftMarker;
    });
    const fallbackMatches = markerMatches.length
      ? []
      : availableDiscussions.filter((discussion) => {
          if (usedDiscussionIds.has(discussion.id)) {
            return false;
          }

          const rootNote = discussion.notes[0];
          if (!rootNote) {
            return false;
          }

          const rootDraftMarker = extractDraftThreadMarker(rootNote.body);
          if (rootDraftMarker !== null) {
            return false;
          }

          return (
            stripDraftThreadMarker(rootNote.body) === pending.body &&
            positionsMatch(rootNote.position ?? null, pending.position)
          );
        });
    const candidates =
      markerMatches.length > 0 ? markerMatches : fallbackMatches;
    if (candidates.length === 0) {
      continue;
    }

    const discussion = candidates[0];
    const rootNote = discussion?.notes[0];
    if (!discussion || !rootNote) {
      continue;
    }

    usedDiscussionIds.add(discussion.id);
    matched.push({
      pending,
      discussion,
      rootNote,
    });
  }

  return matched;
}

function compareDiscussionsByRecency(
  left: GitLabDiscussion,
  right: GitLabDiscussion,
): number {
  const leftRootNote = left.notes[0];
  const rightRootNote = right.notes[0];
  const leftCreatedAt = leftRootNote
    ? Date.parse(leftRootNote.created_at)
    : Number.NaN;
  const rightCreatedAt = rightRootNote
    ? Date.parse(rightRootNote.created_at)
    : Number.NaN;

  if (Number.isFinite(leftCreatedAt) && Number.isFinite(rightCreatedAt)) {
    const createdAtDelta = rightCreatedAt - leftCreatedAt;
    if (createdAtDelta !== 0) {
      return createdAtDelta;
    }
  }

  return (rightRootNote?.id ?? 0) - (leftRootNote?.id ?? 0);
}

function positionsMatch(
  actual: GitLabNote["position"] | null,
  expected: GitLabDiffPosition | null,
): boolean {
  if (!actual && !expected) {
    return true;
  }

  if (!actual || !expected) {
    return false;
  }

  return (
    actual.base_sha === expected.base_sha &&
    actual.start_sha === expected.start_sha &&
    actual.head_sha === expected.head_sha &&
    actual.position_type === expected.position_type &&
    actual.old_path === expected.old_path &&
    actual.new_path === expected.new_path &&
    actual.old_line === expected.old_line &&
    actual.new_line === expected.new_line
  );
}

async function sleep(durationMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
