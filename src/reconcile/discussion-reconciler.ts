import type { Logger } from "pino";

import type { StorageHelpers } from "../storage/storage-helpers.js";
import type { IPlatform } from "../platforms/IPlatform.js";
import type {
  PlatformReviewComment,
  PlatformReviewDiscussionAdapter,
  PlatformReviewDiscussion,
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
  stripReviewDiscussionMarker,
} from "../review/discussion-format.js";
import type {
  PriorDisposition,
  ProviderDiscussionContext,
  ReviewAnchor,
  ReviewFinding,
  ReviewResult,
  ReviewSummaryContext,
} from "../review/types.js";

interface KnownDiscussion {
  discussionId: string;
  platformDiscussionId: string;
  discussion: PlatformReviewDiscussion;
  mapping: DiscussionMappingRecord | null;
  latestBotNote: PlatformReviewComment | null;
  anchor: ReviewAnchor | null;
  resolvable: boolean;
  resolved: boolean;
  title: string;
  body: string;
  humanReplies: Array<{
    platformCommentId: number;
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
  summaryCommentAction: "created" | "updated" | null;
}

interface DiscussionReconcilerOptions {
  storage: StorageHelpers;
  logger: Logger;
}

interface PendingDraftDiscussion {
  id: string;
  body: string;
  draftMarker: string;
  finding: ReviewFinding;
  fingerprint: string;
  identityKey: string;
  positionJson: string | null;
}

interface PublishedDraftDiscussionMatch {
  discussion: PlatformReviewDiscussion;
  pending: PendingDraftDiscussion;
  rootNote: PlatformReviewComment;
}

type DiscussionReconcileAction =
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
    const discussions = await input.discussionAdapter.listDiscussions();
    const knownDiscussions = buildKnownDiscussions({
      discussions,
      mappings: input.mappings,
    });

    const discussionById = new Map(
      knownDiscussions.map((discussion) => [
        discussion.discussionId,
        discussion,
      ]),
    );
    const dispositionByDiscussionId = new Map(
      input.reviewResult.priorDispositions.map((disposition) => [
        disposition.discussionId,
        disposition,
      ]),
    );

    const summary: ReconcileSummary = {
      created: 0,
      updated: 0,
      replied: 0,
      resolved: 0,
      kept: 0,
      summaryCommentAction: null,
    };

    const referencedDiscussionIds = collectReferencedDiscussionIds(
      input.reviewResult.findings,
      discussionById,
    );
    const projectedActiveFindings = await this.projectActiveFindings({
      tenant: input.tenant,
      codeReviewId: input.context.codeReview.id,
      reviewResult: input.reviewResult,
      discussionById,
      referencedDiscussionIds,
    });

    summary.summaryCommentAction = await this.syncSummaryNote({
      ...input,
      activeFindings: projectedActiveFindings,
    });

    const pendingDraftDiscussions: PendingDraftDiscussion[] = [];
    try {
      for (const finding of input.reviewResult.findings) {
        const matchedDiscussion = finding.priorDiscussionId
          ? (discussionById.get(finding.priorDiscussionId) ?? null)
          : null;
        if (matchedDiscussion) {
          const disposition = dispositionByDiscussionId.get(
            matchedDiscussion.discussionId,
          );
          const action = await this.applyFindingToExistingDiscussion({
            tenant: input.tenant,
            context: input.context,
            discussionAdapter: input.discussionAdapter,
            interactionRunId: input.interactionRunId,
            knownDiscussion: matchedDiscussion,
            finding,
            disposition,
          });
          summary[action] += 1;
          continue;
        }

        pendingDraftDiscussions.push(
          await this.createPendingDraftDiscussion({
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
      await this.cleanupPendingDraftDiscussions({
        tenant: input.tenant,
        codeReviewId: input.context.codeReview.id,
        discussionAdapter: input.discussionAdapter,
        pendingDraftDiscussions,
      });
      throw error;
    }

    if (pendingDraftDiscussions.length > 0) {
      await this.publishPendingDraftDiscussions({
        tenant: input.tenant,
        context: input.context,
        discussionAdapter: input.discussionAdapter,
        interactionRunId: input.interactionRunId,
        pendingDraftDiscussions,
      });
    }

    for (const disposition of input.reviewResult.priorDispositions) {
      if (referencedDiscussionIds.has(disposition.discussionId)) {
        continue;
      }

      const knownDiscussion = discussionById.get(disposition.discussionId);
      if (!knownDiscussion) {
        continue;
      }

      if (disposition.action === "resolve") {
        if (!knownDiscussion.resolved) {
          if (knownDiscussion.resolvable) {
            await input.discussionAdapter.setDiscussionResolved(
              knownDiscussion.platformDiscussionId,
              true,
            );
          } else {
            this.logSkippedDiscussionResolutionChange({
              tenant: input.tenant,
              codeReviewId: input.context.codeReview.id,
              interactionRunId: input.interactionRunId,
              knownDiscussion,
              resolved: true,
            });
          }
        }

        await this.persistDiscussionState({
          tenant: input.tenant,
          context: input.context,
          interactionRunId: input.interactionRunId,
          knownDiscussion,
          note:
            knownDiscussion.latestBotNote ??
            knownDiscussion.discussion.comments[0] ??
            null,
          identityKey:
            knownDiscussion.mapping?.identityKey ??
            createFindingIdentityKey({
              title: knownDiscussion.title,
              category: knownDiscussion.mapping?.category ?? "correctness",
              path: knownDiscussion.anchor?.path,
              startLine: knownDiscussion.anchor?.startLine,
              endLine: knownDiscussion.anchor?.endLine,
              side: knownDiscussion.anchor?.side,
            }),
          fingerprint:
            knownDiscussion.mapping?.findingFingerprint ??
            createFindingFingerprint({
              identityKey:
                knownDiscussion.mapping?.identityKey ??
                createFindingIdentityKey({
                  title: knownDiscussion.title,
                  category: knownDiscussion.mapping?.category ?? "correctness",
                  path: knownDiscussion.anchor?.path,
                  startLine: knownDiscussion.anchor?.startLine,
                  endLine: knownDiscussion.anchor?.endLine,
                  side: knownDiscussion.anchor?.side,
                }),
              body: knownDiscussion.body,
            }),
          title: knownDiscussion.title,
          body: knownDiscussion.body,
          severity: knownDiscussion.mapping?.severity ?? "medium",
          category: knownDiscussion.mapping?.category ?? "correctness",
          positionJson:
            knownDiscussion.discussion.comments[0]?.positionJson ?? null,
          discussionStatus:
            knownDiscussion.resolved || knownDiscussion.resolvable
              ? "resolved"
              : "open",
          findingStatus: disposition.resolution ?? "resolved",
        });
        summary.resolved += 1;
      } else if (disposition.action === "reply" && disposition.replyBody) {
        const note = await input.discussionAdapter.replyToDiscussion(
          knownDiscussion.platformDiscussionId,
          disposition.replyBody,
        );
        await this.persistDiscussionState({
          tenant: input.tenant,
          context: input.context,
          interactionRunId: input.interactionRunId,
          knownDiscussion,
          note,
          identityKey:
            knownDiscussion.mapping?.identityKey ??
            createFindingIdentityKey({
              title: knownDiscussion.title,
              category: knownDiscussion.mapping?.category ?? "correctness",
              path: knownDiscussion.anchor?.path,
              startLine: knownDiscussion.anchor?.startLine,
              endLine: knownDiscussion.anchor?.endLine,
              side: knownDiscussion.anchor?.side,
            }),
          fingerprint:
            knownDiscussion.mapping?.findingFingerprint ??
            createFindingFingerprint({
              identityKey:
                knownDiscussion.mapping?.identityKey ??
                createFindingIdentityKey({
                  title: knownDiscussion.title,
                  category: knownDiscussion.mapping?.category ?? "correctness",
                  path: knownDiscussion.anchor?.path,
                  startLine: knownDiscussion.anchor?.startLine,
                  endLine: knownDiscussion.anchor?.endLine,
                  side: knownDiscussion.anchor?.side,
                }),
              body: disposition.replyBody,
            }),
          title: knownDiscussion.title,
          body: disposition.replyBody,
          severity: knownDiscussion.mapping?.severity ?? "medium",
          category: knownDiscussion.mapping?.category ?? "correctness",
          positionJson:
            note.positionJson ??
            knownDiscussion.discussion.comments[0]?.positionJson ??
            null,
          discussionStatus: knownDiscussion.resolved ? "resolved" : "open",
          findingStatus: knownDiscussion.resolved ? "resolved" : "open",
        });
        summary.replied += 1;
      }
    }

    return summary;
  }

  private async applyFindingToExistingDiscussion(input: {
    tenant: TenantRecord;
    context: ReviewSummaryContext;
    discussionAdapter: PlatformReviewDiscussionAdapter;
    interactionRunId: string;
    knownDiscussion: KnownDiscussion;
    finding: ReviewFinding;
    disposition: PriorDisposition | undefined;
  }): Promise<DiscussionReconcileAction> {
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
      !input.knownDiscussion.latestBotNote ||
      input.knownDiscussion.resolved;

    if (
      input.knownDiscussion.mapping?.findingFingerprint === fingerprint &&
      !shouldReply
    ) {
      await this.persistDiscussionState({
        tenant: input.tenant,
        context: input.context,
        interactionRunId: input.interactionRunId,
        knownDiscussion: input.knownDiscussion,
        note:
          input.knownDiscussion.latestBotNote ??
          input.knownDiscussion.discussion.comments[0] ??
          null,
        identityKey,
        fingerprint,
        title: input.finding.title,
        body,
        severity: input.finding.severity,
        category: input.finding.category,
        positionJson:
          input.knownDiscussion.discussion.comments[0]?.positionJson ?? null,
        discussionStatus: "open",
        findingStatus: "open",
      });
      return "kept";
    }

    if (shouldReply) {
      let discussionStatus: "open" | "resolved" = "open";
      if (input.knownDiscussion.resolved) {
        if (input.knownDiscussion.resolvable) {
          await input.discussionAdapter.setDiscussionResolved(
            input.knownDiscussion.platformDiscussionId,
            false,
          );
        } else {
          discussionStatus = "resolved";
          this.logSkippedDiscussionResolutionChange({
            tenant: input.tenant,
            codeReviewId: input.context.codeReview.id,
            interactionRunId: input.interactionRunId,
            knownDiscussion: input.knownDiscussion,
            resolved: false,
          });
        }
      }

      const note = await input.discussionAdapter.replyToDiscussion(
        input.knownDiscussion.platformDiscussionId,
        input.disposition?.replyBody ?? body,
      );
      await this.persistDiscussionState({
        tenant: input.tenant,
        context: input.context,
        interactionRunId: input.interactionRunId,
        knownDiscussion: input.knownDiscussion,
        note,
        identityKey,
        fingerprint,
        title: input.finding.title,
        body: input.disposition?.replyBody ?? body,
        severity: input.finding.severity,
        category: input.finding.category,
        positionJson:
          note.positionJson ??
          input.knownDiscussion.discussion.comments[0]?.positionJson ??
          null,
        discussionStatus,
        findingStatus: "open",
      });
      return "replied";
    }

    const latestBotNote = input.knownDiscussion.latestBotNote;
    if (!latestBotNote) {
      throw new Error(
        `Expected a bot-authored note for discussion ${input.knownDiscussion.discussionId}`,
      );
    }

    const updatedNote = await input.discussionAdapter.updateComment(
      input.knownDiscussion.platformDiscussionId,
      latestBotNote.id,
      body,
    );
    await this.persistDiscussionState({
      tenant: input.tenant,
      context: input.context,
      interactionRunId: input.interactionRunId,
      knownDiscussion: input.knownDiscussion,
      note: updatedNote,
      identityKey,
      fingerprint,
      title: input.finding.title,
      body,
      severity: input.finding.severity,
      category: input.finding.category,
      positionJson:
        updatedNote.positionJson ??
        input.knownDiscussion.discussion.comments[0]?.positionJson ??
        null,
      discussionStatus: "open",
      findingStatus: "open",
    });
    return "updated";
  }

  private async createPendingDraftDiscussion(input: {
    tenant: TenantRecord;
    context: ReviewSummaryContext;
    discussionAdapter: PlatformReviewDiscussionAdapter;
    interactionRunId: string;
    finding: ReviewFinding;
  }): Promise<PendingDraftDiscussion> {
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
    const createdDraft = await input.discussionAdapter.createDraftDiscussion({
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

  private async publishPendingDraftDiscussions(input: {
    tenant: TenantRecord;
    context: ReviewSummaryContext;
    discussionAdapter: PlatformReviewDiscussionAdapter;
    interactionRunId: string;
    pendingDraftDiscussions: PendingDraftDiscussion[];
  }): Promise<void> {
    const existingDiscussionIds = new Set(
      (await input.discussionAdapter.listDiscussions()).map(
        (discussion) => discussion.id,
      ),
    );
    try {
      await input.discussionAdapter.publishDraftDiscussions();
      const matched = (
        await input.discussionAdapter.matchPublishedDraftDiscussions({
          pendingDraftDiscussions: input.pendingDraftDiscussions,
          existingDiscussionIds: existingDiscussionIds,
        })
      ).map((match) => ({
        discussion: match.discussion,
        pending: match.pending,
        rootNote: match.rootComment,
      }));
      await this.persistPublishedDraftDiscussionMatches({
        tenant: input.tenant,
        context: input.context,
        interactionRunId: input.interactionRunId,
        matches: matched,
      });
    } catch (error) {
      const recovered = await this.tryRecoverPublishedDraftDiscussions({
        tenant: input.tenant,
        context: input.context,
        discussionAdapter: input.discussionAdapter,
        interactionRunId: input.interactionRunId,
        pendingDraftDiscussions: input.pendingDraftDiscussions,
        existingDiscussionIds,
      });
      if (recovered) {
        return;
      }

      await this.cleanupPendingDraftDiscussions({
        tenant: input.tenant,
        codeReviewId: input.context.codeReview.id,
        discussionAdapter: input.discussionAdapter,
        pendingDraftDiscussions: input.pendingDraftDiscussions,
      });
      throw error;
    }
  }

  private async tryRecoverPublishedDraftDiscussions(input: {
    tenant: TenantRecord;
    context: ReviewSummaryContext;
    discussionAdapter: PlatformReviewDiscussionAdapter;
    interactionRunId: string;
    pendingDraftDiscussions: PendingDraftDiscussion[];
    existingDiscussionIds: ReadonlySet<string>;
  }): Promise<boolean> {
    try {
      const matches = (
        await input.discussionAdapter.matchPublishedDraftDiscussions({
          pendingDraftDiscussions: input.pendingDraftDiscussions,
          existingDiscussionIds: input.existingDiscussionIds,
          maxAttempts: 1,
        })
      ).map((match) => ({
        discussion: match.discussion,
        pending: match.pending,
        rootNote: match.rootComment,
      }));
      await this.persistPublishedDraftDiscussionMatches({
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

  private async cleanupPendingDraftDiscussions(input: {
    tenant: TenantRecord;
    codeReviewId: number;
    discussionAdapter: PlatformReviewDiscussionAdapter;
    pendingDraftDiscussions: PendingDraftDiscussion[];
  }): Promise<void> {
    for (const pending of input.pendingDraftDiscussions) {
      try {
        await input.discussionAdapter.deleteDraftDiscussion(pending.id);
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
          "failed to clean up platform draft discussion",
        );
      }
    }
  }

  private async persistPublishedDraftDiscussionMatches(input: {
    tenant: TenantRecord;
    context: ReviewSummaryContext;
    interactionRunId: string;
    matches: PublishedDraftDiscussionMatch[];
  }): Promise<void> {
    for (const match of input.matches) {
      await this.persistCreatedDiscussion({
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

  private async persistCreatedDiscussion(input: {
    tenant: TenantRecord;
    context: ReviewSummaryContext;
    interactionRunId: string;
    finding: ReviewFinding;
    identityKey: string;
    fingerprint: string;
    body: string;
    discussion: PlatformReviewDiscussion;
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
      platformDiscussionId: input.discussion.id,
      platformCommentId: Number(input.note.id),
      anchorJson: input.finding.anchor
        ? JSON.stringify(input.finding.anchor)
        : null,
      positionJson: input.note.positionJson,
      botDiscussion: input.discussion.comments[0]?.isBot ?? input.note.isBot,
      botComment: input.note.isBot,
      commentAuthorId: parseNumericId(input.note.authorId),
      commentAuthorUsername: input.note.authorUsername,
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

  private async persistDiscussionState(input: {
    tenant: TenantRecord;
    context: ReviewSummaryContext;
    interactionRunId: string;
    knownDiscussion: KnownDiscussion;
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
    const rootNote = input.knownDiscussion.discussion.comments[0];
    if (!rootNote || !input.note) {
      return;
    }

    await this.storage.upsertDiscussionMapping({
      ...(input.knownDiscussion.mapping
        ? { id: input.knownDiscussion.mapping.id }
        : {}),
      tenantId: input.tenant.id,
      codeReviewId: input.context.codeReview.id,
      identityKey: input.identityKey,
      findingFingerprint: input.fingerprint,
      title: input.title,
      severity: input.severity,
      category: input.category,
      body: input.body,
      platformDiscussionId: input.knownDiscussion.platformDiscussionId,
      platformCommentId: Number(input.note.id),
      anchorJson: input.knownDiscussion.anchor
        ? JSON.stringify(input.knownDiscussion.anchor)
        : null,
      positionJson: input.positionJson,
      botDiscussion: rootNote.isBot,
      botComment: input.note.isBot,
      commentAuthorId: parseNumericId(input.note.authorId),
      commentAuthorUsername: input.note.authorUsername,
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
      input.knownDiscussion.mapping?.status === "resolved";
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
      previousIdentityKey: input.knownDiscussion.mapping?.identityKey ?? null,
      nextIdentityKey: input.identityKey,
    });
  }

  private logSkippedDiscussionResolutionChange(input: {
    tenant: TenantRecord;
    codeReviewId: number;
    interactionRunId: string;
    knownDiscussion: KnownDiscussion;
    resolved: boolean;
  }): void {
    this.logger.warn(
      {
        tenantId: input.tenant.id,
        codeReviewId: input.codeReviewId,
        interactionRunId: input.interactionRunId,
        discussionId: input.knownDiscussion.discussionId,
        platformDiscussionId: input.knownDiscussion.platformDiscussionId,
        requestedResolved: input.resolved,
      },
      "skipping discussion resolution change because the discussion is not resolvable",
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
  }): Promise<ReconcileSummary["summaryCommentAction"]> {
    const body = buildReviewSummaryNote({
      platform: input.platform,
      tenant: input.tenant,
      context: input.context,
      reviewResult: input.reviewResult,
      activeFindings: input.activeFindings,
    });
    const existingNote = findLatestReviewSummaryNote(
      await input.discussionAdapter.listSummaryComments(),
      (note) => note.isBot,
    );

    if (existingNote) {
      await input.discussionAdapter.updateSummaryComment(existingNote.id, body);
      return "updated";
    }

    await input.discussionAdapter.createSummaryComment(body);
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
    discussionById: ReadonlyMap<string, KnownDiscussion>;
    referencedDiscussionIds: ReadonlySet<string>;
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
      const matchedDiscussion = finding.priorDiscussionId
        ? (input.discussionById.get(finding.priorDiscussionId) ?? null)
        : null;
      if (matchedDiscussion) {
        const previousIdentityKey =
          matchedDiscussion.mapping?.identityKey ?? null;
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
        input.referencedDiscussionIds.has(disposition.discussionId)
      ) {
        continue;
      }

      const knownDiscussion = input.discussionById.get(
        disposition.discussionId,
      );
      if (!knownDiscussion) {
        continue;
      }

      const identityKey =
        knownDiscussion.mapping?.identityKey ??
        createFindingIdentityKey({
          title: knownDiscussion.title,
          category: knownDiscussion.mapping?.category ?? "correctness",
          path: knownDiscussion.anchor?.path,
          startLine: knownDiscussion.anchor?.startLine,
          endLine: knownDiscussion.anchor?.endLine,
          side: knownDiscussion.anchor?.side,
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

export function buildProviderDiscussions(input: {
  discussions: PlatformReviewDiscussion[];
  mappings: DiscussionMappingRecord[];
}): ProviderDiscussionContext[] {
  return buildKnownDiscussions(input).map((knownDiscussion) => ({
    discussionId: knownDiscussion.discussionId,
    platformDiscussionId: knownDiscussion.platformDiscussionId,
    platformCommentId: Number(
      knownDiscussion.latestBotNote?.id ??
        knownDiscussion.discussion.comments[0]?.id ??
        0,
    ),
    title: knownDiscussion.title,
    body: knownDiscussion.body,
    anchor: knownDiscussion.anchor,
    resolvable: knownDiscussion.resolvable,
    resolved: knownDiscussion.resolved,
    humanReplies: knownDiscussion.humanReplies,
  }));
}

function buildKnownDiscussions(input: {
  discussions: PlatformReviewDiscussion[];
  mappings: DiscussionMappingRecord[];
}): KnownDiscussion[] {
  const mappingByDiscussionId = new Map(
    input.mappings.map(
      (mapping) => [mapping.platformDiscussionId, mapping] as const,
    ),
  );

  const knownDiscussions: KnownDiscussion[] = [];

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

    const discussionTitle = stripTitleDecoration(
      mapping?.title ??
        firstNonEmptyLine(
          stripReviewDiscussionMarker(
            mapping?.body ?? latestBotNote?.body ?? rootNote.body,
          ),
        ),
    );
    const discussionBody = stripReviewDiscussionMarker(
      mapping?.body ?? latestBotNote?.body ?? rootNote.body,
    );

    knownDiscussions.push({
      discussionId: mapping?.id ?? `discussion:${discussion.id}`,
      platformDiscussionId: discussion.id,
      discussion,
      mapping,
      latestBotNote,
      anchor,
      resolvable: discussion.resolvable,
      resolved: discussion.comments.some((note) => note.resolved === true),
      title: discussionTitle || "Review finding",
      body: discussionBody,
      humanReplies: discussion.comments
        .filter((note) => !note.isBot)
        .map((note) => ({
          platformCommentId: Number(note.id),
          authorUsername: note.authorUsername ?? "(unknown)",
          body: note.body,
        })),
    });
  }

  return knownDiscussions;
}

function stripTitleDecoration(value: string): string {
  return value.replace(/^[#*\s`]+/, "").replace(/[*\s`]+$/, "");
}

function collectReferencedDiscussionIds(
  findings: ReadonlyArray<ReviewFinding>,
  discussionById: ReadonlyMap<string, KnownDiscussion>,
): Set<string> {
  const referencedDiscussionIds = new Set<string>();

  for (const finding of findings) {
    if (
      !finding.priorDiscussionId ||
      !discussionById.has(finding.priorDiscussionId)
    ) {
      continue;
    }

    referencedDiscussionIds.add(finding.priorDiscussionId);
  }

  return referencedDiscussionIds;
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
