import type { Logger } from "pino";

import type { StorageHelpers } from "../storage/storage-helpers.js";
import type { IPlatform } from "../platforms/IPlatform.js";
import type {
  PlatformReviewComment,
  PlatformReviewDiscussionAdapter,
  PlatformReviewThread,
} from "../platforms/review-adapter.js";
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
import {
  renderReviewFindingBody,
  stripReviewThreadMarker,
} from "../review/discussion-format.js";
import type {
  PriorDisposition,
  ProviderThreadContext,
  ReviewAnchor,
  ReviewFinding,
  ReviewResult,
  ReviewSummaryContext,
} from "../review/types.js";

interface KnownThread {
  threadId: string;
  discussionId: string;
  discussion: PlatformReviewThread;
  mapping: DiscussionMappingRecord | null;
  latestBotNote: PlatformReviewComment | null;
  anchor: ReviewAnchor | null;
  resolvable: boolean;
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
  id: string;
  body: string;
  draftMarker: string;
  finding: ReviewFinding;
  fingerprint: string;
  identityKey: string;
  positionJson: string | null;
}

interface PublishedDraftThreadMatch {
  discussion: PlatformReviewThread;
  pending: PendingDraftThread;
  rootNote: PlatformReviewComment;
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
    platform: IPlatform;
    tenant: TenantRecord;
    context: ReviewSummaryContext;
    mappings: DiscussionMappingRecord[];
    interactionRunId: string;
    reviewResult: ReviewResult;
    discussionAdapter: PlatformReviewDiscussionAdapter;
  }): Promise<ReconcileSummary> {
    const discussions = await input.discussionAdapter.listThreads();
    const knownThreads = buildKnownThreads({
      discussions,
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
      codeReviewId: input.context.codeReview.id,
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
            discussionAdapter: input.discussionAdapter,
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
            discussionAdapter: input.discussionAdapter,
            interactionRunId: input.interactionRunId,
            finding,
          }),
        );
        summary.created += 1;
      }
    } catch (error) {
      await this.cleanupPendingDraftThreads({
        tenant: input.tenant,
        codeReviewId: input.context.codeReview.id,
        discussionAdapter: input.discussionAdapter,
        pendingDraftThreads,
      });
      throw error;
    }

    if (pendingDraftThreads.length > 0) {
      await this.publishPendingDraftThreads({
        tenant: input.tenant,
        context: input.context,
        discussionAdapter: input.discussionAdapter,
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
          if (thread.resolvable) {
            await input.discussionAdapter.setThreadResolved(
              thread.discussionId,
              true,
            );
          } else {
            this.logSkippedThreadResolutionChange({
              tenant: input.tenant,
              codeReviewId: input.context.codeReview.id,
              interactionRunId: input.interactionRunId,
              thread,
              resolved: true,
            });
          }
        }

        await this.persistThreadState({
          tenant: input.tenant,
          context: input.context,
          interactionRunId: input.interactionRunId,
          thread,
          note: thread.latestBotNote ?? thread.discussion.comments[0] ?? null,
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
          positionJson: thread.discussion.comments[0]?.positionJson ?? null,
          discussionStatus:
            thread.resolved || thread.resolvable ? "resolved" : "open",
          findingStatus: disposition.resolution ?? "resolved",
        });
        summary.resolved += 1;
      } else if (disposition.action === "reply" && disposition.replyBody) {
        const note = await input.discussionAdapter.replyToThread(
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
          positionJson:
            note.positionJson ??
            thread.discussion.comments[0]?.positionJson ??
            null,
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
    context: ReviewSummaryContext;
    discussionAdapter: PlatformReviewDiscussionAdapter;
    interactionRunId: string;
    thread: KnownThread;
    finding: ReviewFinding;
    disposition: PriorDisposition | undefined;
  }): Promise<ThreadReconcileAction> {
    const body = renderReviewFindingBody(input.finding);
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
          input.thread.discussion.comments[0] ??
          null,
        identityKey,
        fingerprint,
        title: input.finding.title,
        body,
        severity: input.finding.severity,
        category: input.finding.category,
        positionJson: input.thread.discussion.comments[0]?.positionJson ?? null,
        discussionStatus: "open",
        findingStatus: "open",
      });
      return "kept";
    }

    if (shouldReply) {
      let discussionStatus: "open" | "resolved" = "open";
      if (input.thread.resolved) {
        if (input.thread.resolvable) {
          await input.discussionAdapter.setThreadResolved(
            input.thread.discussionId,
            false,
          );
        } else {
          discussionStatus = "resolved";
          this.logSkippedThreadResolutionChange({
            tenant: input.tenant,
            codeReviewId: input.context.codeReview.id,
            interactionRunId: input.interactionRunId,
            thread: input.thread,
            resolved: false,
          });
        }
      }

      const note = await input.discussionAdapter.replyToThread(
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
        positionJson:
          note.positionJson ??
          input.thread.discussion.comments[0]?.positionJson ??
          null,
        discussionStatus,
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

    const updatedNote = await input.discussionAdapter.updateComment(
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
      positionJson:
        updatedNote.positionJson ??
        input.thread.discussion.comments[0]?.positionJson ??
        null,
      discussionStatus: "open",
      findingStatus: "open",
    });
    return "updated";
  }

  private async createPendingDraftThread(input: {
    tenant: TenantRecord;
    context: ReviewSummaryContext;
    discussionAdapter: PlatformReviewDiscussionAdapter;
    interactionRunId: string;
    finding: ReviewFinding;
  }): Promise<PendingDraftThread> {
    const body = renderReviewFindingBody(input.finding);
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
    const createdDraft = await input.discussionAdapter.createDraftThread({
      finding: input.finding,
      body,
      draftMarker,
    });
    return {
      id: createdDraft.id,
      draftMarker,
      finding: input.finding,
      body,
      identityKey,
      fingerprint,
      positionJson: createdDraft.positionJson,
    };
  }

  private async publishPendingDraftThreads(input: {
    tenant: TenantRecord;
    context: ReviewSummaryContext;
    discussionAdapter: PlatformReviewDiscussionAdapter;
    interactionRunId: string;
    pendingDraftThreads: PendingDraftThread[];
  }): Promise<void> {
    const existingThreadIds = new Set(
      (await input.discussionAdapter.listThreads()).map((discussion) => discussion.id),
    );
    try {
      await input.discussionAdapter.publishDraftThreads();
      const matched = (
        await input.discussionAdapter.matchPublishedDraftThreads({
          pendingDraftThreads: input.pendingDraftThreads,
          existingThreadIds,
        })
      ).map((match) => ({
        discussion: match.thread,
        pending: match.pending,
        rootNote: match.rootComment,
      }));
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
        discussionAdapter: input.discussionAdapter,
        interactionRunId: input.interactionRunId,
        pendingDraftThreads: input.pendingDraftThreads,
        existingThreadIds,
      });
      if (recovered) {
        return;
      }

      await this.cleanupPendingDraftThreads({
        tenant: input.tenant,
        codeReviewId: input.context.codeReview.id,
        discussionAdapter: input.discussionAdapter,
        pendingDraftThreads: input.pendingDraftThreads,
      });
      throw error;
    }
  }

  private async tryRecoverPublishedDraftThreads(input: {
    tenant: TenantRecord;
    context: ReviewSummaryContext;
    discussionAdapter: PlatformReviewDiscussionAdapter;
    interactionRunId: string;
    pendingDraftThreads: PendingDraftThread[];
    existingThreadIds: ReadonlySet<string>;
  }): Promise<boolean> {
    try {
      const matches = (
        await input.discussionAdapter.matchPublishedDraftThreads({
          pendingDraftThreads: input.pendingDraftThreads,
          existingThreadIds: input.existingThreadIds,
          maxAttempts: 1,
        })
      ).map((match) => ({
        discussion: match.thread,
        pending: match.pending,
        rootNote: match.rootComment,
      }));
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
    codeReviewId: number;
    discussionAdapter: PlatformReviewDiscussionAdapter;
    pendingDraftThreads: PendingDraftThread[];
  }): Promise<void> {
    for (const pending of input.pendingDraftThreads) {
      try {
        await input.discussionAdapter.deleteDraftThread(pending.id);
      } catch (error) {
        if (isNotFoundError(error)) {
          continue;
        }

        this.logger.warn(
          {
            err: error,
            tenantId: input.tenant.id,
            codeReviewId: input.codeReviewId,
            draftNoteId: pending.id,
          },
          "failed to clean up platform draft thread",
        );
      }
    }
  }

  private async persistPublishedDraftThreadMatches(input: {
    tenant: TenantRecord;
    context: ReviewSummaryContext;
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
    context: ReviewSummaryContext;
    interactionRunId: string;
    finding: ReviewFinding;
    identityKey: string;
    fingerprint: string;
    body: string;
    discussion: PlatformReviewThread;
    note: PlatformReviewComment;
  }): Promise<void> {
    await this.storage.upsertDiscussionMapping({
      tenantId: input.tenant.id,
      codeReviewId: input.context.codeReview.id,
      identityKey: input.identityKey,
      findingFingerprint: input.fingerprint,
      title: input.finding.title,
      severity: input.finding.severity,
      category: input.finding.category,
      body: input.body,
      platformThreadId: input.discussion.id,
      platformCommentId: Number(input.note.id),
      anchorJson: input.finding.anchor
        ? JSON.stringify(input.finding.anchor)
        : null,
      positionJson: input.note.positionJson,
      botDiscussion: input.discussion.comments[0]?.isBot ?? input.note.isBot,
      botNote: input.note.isBot,
      noteAuthorId: parseNumericId(input.note.authorId),
      noteAuthorUsername: input.note.authorUsername,
      status: input.discussion.comments.some((note) => note.resolved === true)
        ? "resolved"
        : "open",
      lastInteractionRunId: input.interactionRunId,
    });
    await this.storage.updateReviewFindingStatus(
      input.tenant.id,
      input.context.codeReview.id,
      input.identityKey,
      "open",
    );
  }

  private async persistThreadState(input: {
    tenant: TenantRecord;
    context: ReviewSummaryContext;
    interactionRunId: string;
    thread: KnownThread;
    note: PlatformReviewComment | null;
    identityKey: string;
    fingerprint: string;
    title: string;
    body: string;
    severity: string;
    category: string;
    positionJson: string | null;
    discussionStatus: "open" | "resolved";
    findingStatus: ReviewFindingStatus;
  }): Promise<void> {
    const rootNote = input.thread.discussion.comments[0];
    if (!rootNote || !input.note) {
      return;
    }

    await this.storage.upsertDiscussionMapping({
      ...(input.thread.mapping ? { id: input.thread.mapping.id } : {}),
      tenantId: input.tenant.id,
      codeReviewId: input.context.codeReview.id,
      identityKey: input.identityKey,
      findingFingerprint: input.fingerprint,
      title: input.title,
      severity: input.severity,
      category: input.category,
      body: input.body,
      platformThreadId: input.thread.discussionId,
      platformCommentId: Number(input.note.id),
      anchorJson: input.thread.anchor
        ? JSON.stringify(input.thread.anchor)
        : null,
      positionJson: input.positionJson,
      botDiscussion: rootNote.isBot,
      botNote: input.note.isBot,
      noteAuthorId: parseNumericId(input.note.authorId),
      noteAuthorUsername: input.note.authorUsername,
      status: input.discussionStatus,
      lastInteractionRunId: input.interactionRunId,
    });

    const updatedFinding = await this.storage.updateReviewFindingStatus(
      input.tenant.id,
      input.context.codeReview.id,
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
          codeReviewId: input.context.codeReview.id,
          identityKey: input.identityKey,
          findingStatus: input.findingStatus,
        },
        "failed to update persisted review finding status",
      );
    }

    await this.retireReplacedFinding({
      tenantId: input.tenant.id,
      codeReviewId: input.context.codeReview.id,
      previousIdentityKey: input.thread.mapping?.identityKey ?? null,
      nextIdentityKey: input.identityKey,
    });
  }

  private logSkippedThreadResolutionChange(input: {
    tenant: TenantRecord;
    codeReviewId: number;
    interactionRunId: string;
    thread: KnownThread;
    resolved: boolean;
  }): void {
    this.logger.warn(
      {
        tenantId: input.tenant.id,
        codeReviewId: input.codeReviewId,
        interactionRunId: input.interactionRunId,
        threadId: input.thread.threadId,
        discussionId: input.thread.discussionId,
        requestedResolved: input.resolved,
      },
      "skipping discussion resolution change because the thread is not resolvable",
    );
  }

  private async syncSummaryNote(input: {
    platform: IPlatform;
    tenant: TenantRecord;
    context: ReviewSummaryContext;
    interactionRunId: string;
    reviewResult: ReviewResult;
    discussionAdapter: PlatformReviewDiscussionAdapter;
    activeFindings: SummaryFinding[];
  }): Promise<ReconcileSummary["summaryNoteAction"]> {
    const body = buildReviewSummaryNote({
      platform: input.platform,
      tenant: input.tenant,
      context: input.context,
      reviewResult: input.reviewResult,
      activeFindings: input.activeFindings,
    });
    const existingNote = findLatestReviewSummaryNote(
      await input.discussionAdapter.listSummaryNotes(),
      (note) => note.isBot,
    );

    if (existingNote) {
      await input.discussionAdapter.updateSummaryNote(existingNote.id, body);
      return "updated";
    }

    await input.discussionAdapter.createSummaryNote(body);
    return "created";
  }

  private async retireReplacedFinding(input: {
    tenantId: string;
    codeReviewId: number;
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
      input.codeReviewId,
      input.previousIdentityKey,
      "resolved",
    );
    if (!retiredFinding) {
      this.logger.warn(
        {
          tenantId: input.tenantId,
          codeReviewId: input.codeReviewId,
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
    codeReviewId: number;
    reviewResult: ReviewResult;
    threadById: ReadonlyMap<string, KnownThread>;
    referencedThreadIds: ReadonlySet<string>;
  }): Promise<SummaryFinding[]> {
    const activeFindings = new Map<string, SummaryFinding>();
    const persistedFindings = await this.storage.listLatestReviewFindings(
      input.tenant.id,
      input.codeReviewId,
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

export function buildProviderThreads(input: {
  discussions: PlatformReviewThread[];
  mappings: DiscussionMappingRecord[];
}): ProviderThreadContext[] {
  return buildKnownThreads(input).map((thread) => ({
    threadId: thread.threadId,
    discussionId: thread.discussionId,
    noteId: Number(
      thread.latestBotNote?.id ?? thread.discussion.comments[0]?.id ?? 0,
    ),
    title: thread.title,
    body: thread.body,
    anchor: thread.anchor,
    resolvable: thread.resolvable,
    resolved: thread.resolved,
    humanReplies: thread.humanReplies,
  }));
}

function buildKnownThreads(input: {
  discussions: PlatformReviewThread[];
  mappings: DiscussionMappingRecord[];
}): KnownThread[] {
  const mappingByDiscussionId = new Map(
    input.mappings.map(
      (mapping) => [mapping.platformThreadId, mapping] as const,
    ),
  );

  const threads: KnownThread[] = [];

  for (const discussion of input.discussions) {
    const rootNote = discussion.comments[0];
    if (!rootNote) {
      continue;
    }

    const mapping = mappingByDiscussionId.get(discussion.id) ?? null;
    const botOwnedDiscussion = rootNote.isBot;
    if (!botOwnedDiscussion) {
      continue;
    }
    if (isReviewSummaryNoteBody(rootNote.body)) {
      continue;
    }

    const latestBotNote =
      discussion.comments
        .slice()
        .reverse()
        .find((note) => note.isBot) ?? null;

    const anchor = mapping?.anchorJson
      ? (JSON.parse(mapping.anchorJson) as ReviewAnchor)
      : (latestBotNote?.anchor ?? rootNote.anchor);

    const threadTitle = stripTitleDecoration(
      mapping?.title ??
        firstNonEmptyLine(
          stripReviewThreadMarker(
            mapping?.body ?? latestBotNote?.body ?? rootNote.body,
          ),
        ),
    );
    const threadBody = stripReviewThreadMarker(
      mapping?.body ?? latestBotNote?.body ?? rootNote.body,
    );

    threads.push({
      threadId: mapping?.id ?? `discussion:${discussion.id}`,
      discussionId: discussion.id,
      discussion,
      mapping,
      latestBotNote,
      anchor,
      resolvable: discussion.resolvable,
      resolved: discussion.comments.some((note) => note.resolved === true),
      title: threadTitle || "Review finding",
      body: threadBody,
      humanReplies: discussion.comments
        .filter((note) => !note.isBot)
        .map((note) => ({
          noteId: Number(note.id),
          authorUsername: note.authorUsername ?? "(unknown)",
          body: note.body,
        })),
    });
  }

  return threads;
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

function parseNumericId(value: string | null): number | null {
  if (value === null || value.trim().length === 0) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 404
  );
}
