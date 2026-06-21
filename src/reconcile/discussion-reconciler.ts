import type { Logger } from "pino";

import type { StorageHelpers } from "../storage/storage-helpers.js";
import type { IPlatform } from "../platforms/IPlatform.js";
import type {
  PlatformFindingPublication,
  PlatformPublicationLink,
  PlatformReviewComment,
  PlatformReviewPublicationAdapter,
  PlatformReviewDiscussion,
  PlatformSummaryPublication,
} from "../platforms/review-adapter.js";
import type {
  DiscussionMappingRecord,
  ReviewFindingStatus,
  TenantRecord,
} from "../storage/contract/index.js";
import type { PlatformConnectionRecord } from "../storage/contract/index.js";
import {
  createFindingFingerprint,
  createFindingIdentityKey,
} from "../utils/ids.js";
import { firstNonEmptyLine } from "../utils/text.js";
import {
  buildReviewSummaryNote,
  isReviewSummaryNoteBody,
} from "../review/summary.js";
import {
  renderReviewFindingProse,
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
  links: PlatformPublicationLink[];
}

interface DiscussionReconcilerOptions {
  storage: StorageHelpers;
  logger: Logger;
}

interface PendingFindingPublication extends PlatformFindingPublication {
  body: string;
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
    connection?: PlatformConnectionRecord;
    context: ReviewSummaryContext;
    mappings: DiscussionMappingRecord[];
    interactionJobId: string;
    interactionRunId: string;
    reviewResult: ReviewResult;
    publicationAdapter: PlatformReviewPublicationAdapter;
  }): Promise<ReconcileSummary> {
    const discussions = await input.publicationAdapter.loadDiscussions();
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
      links: [],
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

    const pendingFindings: PendingFindingPublication[] = [];
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
          publicationAdapter: input.publicationAdapter,
          interactionRunId: input.interactionRunId,
          knownDiscussion: matchedDiscussion,
          finding,
          disposition,
        });
        summary[action] += 1;
        continue;
      }

      pendingFindings.push(
        this.createPendingFindingPublication({
          platformSlug: input.platform.getPlatformInfo().slug,
          interactionJobId: input.interactionJobId,
          finding,
        }),
      );
      summary.created += 1;
    }

    if (pendingFindings.length > 0) {
      const publicationResult = await input.publicationAdapter.publishFindings({
        publicationKey: input.interactionJobId,
        findings: pendingFindings,
        existingDiscussionIds: new Set(discussions.map((entry) => entry.id)),
      });
      summary.links.push(...publicationResult.links);
      await this.persistPublishedFindings({
        tenant: input.tenant,
        context: input.context,
        interactionRunId: input.interactionRunId,
        pendingFindings,
        publishedFindings: publicationResult.findings,
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
            await input.publicationAdapter.mutateDiscussion({
              kind: "set-resolved",
              discussionId: knownDiscussion.platformDiscussionId,
              resolved: true,
            });
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
        const mutation = await input.publicationAdapter.mutateDiscussion({
          kind: "reply-text",
          discussionId: knownDiscussion.platformDiscussionId,
          body: disposition.replyBody,
        });
        const note = mutation.comment;
        if (!note) {
          throw new Error(
            `Platform did not return a reply comment for discussion ${knownDiscussion.platformDiscussionId}`,
          );
        }
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

    const summaryPublication = await this.syncSummaryNote({
      ...input,
      activeFindings: projectedActiveFindings,
    });
    summary.summaryCommentAction = summaryPublication.action;
    if (summaryPublication.url) {
      summary.links.push({
        label: "Review summary",
        url: summaryPublication.url,
      });
    }
    return summary;
  }

  private async applyFindingToExistingDiscussion(input: {
    tenant: TenantRecord;
    context: ReviewSummaryContext;
    publicationAdapter: PlatformReviewPublicationAdapter;
    interactionRunId: string;
    knownDiscussion: KnownDiscussion;
    finding: ReviewFinding;
    disposition: PriorDisposition | undefined;
  }): Promise<DiscussionReconcileAction> {
    const body = renderReviewFindingProse(input.finding);
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
          await input.publicationAdapter.mutateDiscussion({
            kind: "set-resolved",
            discussionId: input.knownDiscussion.platformDiscussionId,
            resolved: false,
          });
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

      const mutation = await input.publicationAdapter.mutateDiscussion(
        input.disposition?.replyBody
          ? {
              kind: "reply-text",
              discussionId: input.knownDiscussion.platformDiscussionId,
              body: input.disposition.replyBody,
            }
          : {
              kind: "reply-finding",
              discussionId: input.knownDiscussion.platformDiscussionId,
              finding: input.finding,
            },
      );
      const note = mutation.comment;
      if (!note) {
        throw new Error(
          `Platform did not return a reply comment for discussion ${input.knownDiscussion.platformDiscussionId}`,
        );
      }
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

    const mutation = await input.publicationAdapter.mutateDiscussion({
      kind: "update-finding",
      discussionId: input.knownDiscussion.platformDiscussionId,
      commentId: latestBotNote.id,
      finding: input.finding,
    });
    const updatedNote = mutation.comment;
    if (!updatedNote) {
      throw new Error(
        `Platform did not return an updated comment for discussion ${input.knownDiscussion.platformDiscussionId}`,
      );
    }
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

  private createPendingFindingPublication(input: {
    platformSlug: string;
    interactionJobId: string;
    finding: ReviewFinding;
  }): PendingFindingPublication {
    const body = renderReviewFindingProse(input.finding);
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
    return {
      finding: input.finding,
      body,
      identityKey,
      fingerprint,
      marker: createPublicationMarker({
        platformSlug: input.platformSlug,
        interactionJobId: input.interactionJobId,
        identityKey,
      }),
    };
  }

  private async persistPublishedFindings(input: {
    tenant: TenantRecord;
    context: ReviewSummaryContext;
    interactionRunId: string;
    pendingFindings: PendingFindingPublication[];
    publishedFindings: Array<{
      identityKey: string;
      discussion: PlatformReviewDiscussion;
      rootComment: PlatformReviewComment;
    }>;
  }): Promise<void> {
    const pendingByIdentity = new Map(
      input.pendingFindings.map((pending) => [pending.identityKey, pending]),
    );
    for (const published of input.publishedFindings) {
      const pending = pendingByIdentity.get(published.identityKey);
      if (!pending) {
        throw new Error(
          `Platform returned unknown published finding ${published.identityKey}`,
        );
      }
      await this.persistCreatedDiscussion({
        tenant: input.tenant,
        context: input.context,
        interactionRunId: input.interactionRunId,
        finding: pending.finding,
        identityKey: pending.identityKey,
        fingerprint: pending.fingerprint,
        body: pending.body,
        discussion: published.discussion,
        note: published.rootComment,
      });
    }
    if (input.publishedFindings.length !== input.pendingFindings.length) {
      throw new Error(
        `Platform published ${input.publishedFindings.length} of ${input.pendingFindings.length} findings`,
      );
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
    connection?: PlatformConnectionRecord;
    context: ReviewSummaryContext;
    interactionRunId: string;
    reviewResult: ReviewResult;
    publicationAdapter: PlatformReviewPublicationAdapter;
    activeFindings: SummaryFinding[];
  }): Promise<PlatformSummaryPublication> {
    const body = buildReviewSummaryNote({
      platform: input.platform,
      tenant: input.tenant,
      ...(input.connection
        ? {
            resolvedTenant: {
              tenant: input.tenant,
              connection: input.connection,
            },
          }
        : {}),
      context: input.context,
      reviewResult: input.reviewResult,
      activeFindings: input.activeFindings,
    });
    return input.publicationAdapter.upsertSummary({ body });
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
  const mappingByRootCommentId = buildUniqueMappingByRootCommentId(
    input.mappings,
  );

  const knownDiscussions: KnownDiscussion[] = [];

  for (const discussion of input.discussions) {
    const rootNote = discussion.comments[0];
    if (!rootNote) {
      continue;
    }

    const rootCommentId = parseNumericId(rootNote.id);
    const mapping =
      mappingByDiscussionId.get(discussion.id) ??
      (rootCommentId === null
        ? null
        : (mappingByRootCommentId.get(rootCommentId) ?? null));
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

function buildUniqueMappingByRootCommentId(
  mappings: DiscussionMappingRecord[],
): Map<number, DiscussionMappingRecord> {
  const result = new Map<number, DiscussionMappingRecord>();
  const duplicateIds = new Set<number>();
  for (const mapping of mappings) {
    if (duplicateIds.has(mapping.platformCommentId)) {
      continue;
    }
    if (result.has(mapping.platformCommentId)) {
      result.delete(mapping.platformCommentId);
      duplicateIds.add(mapping.platformCommentId);
      continue;
    }
    result.set(mapping.platformCommentId, mapping);
  }
  return result;
}

function parseNumericId(value: string | null): number | null {
  if (value === null || value.trim().length === 0) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function createPublicationMarker(input: {
  platformSlug: string;
  interactionJobId: string;
  identityKey: string;
}): string {
  return `${input.platformSlug}:${input.interactionJobId}:${input.identityKey}`;
}
