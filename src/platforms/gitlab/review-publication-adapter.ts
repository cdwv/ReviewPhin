import type { Logger } from "pino";

import { buildDiffPosition } from "./positions.js";
import { buildFilePosition } from "./positions.js";
import { appendSuggestion, renderSuggestionMarkdown } from "./positions.js";
import type { LineAnchorLike } from "./positions.js";
import { isBotUser } from "./bot-user.js";
import { GitLabApiError } from "./client.js";
import type { GitLabClient } from "./client.js";
import { getGitLabTenantConfig } from "./tenant-config.js";
import type {
  GitLabDiscussion,
  GitLabDiffPosition,
  GitLabDraftNote,
  GitLabMergeRequestChange,
  GitLabMergeRequestVersion,
  GitLabNote,
  HydratedMergeRequestContext,
  LightweightMergeRequestContext,
} from "./types.js";
import type { TenantRecord } from "../../storage/contract/current.js";
import {
  appendReviewDiscussionMarker,
  extractAnchorFromPosition,
  extractReviewDiscussionMarker,
  renderReviewFindingProse,
  stripReviewDiscussionMarker,
} from "../../review/discussion-format.js";
import {
  findLatestReviewSummaryNote,
  isReviewSummaryNoteBody,
} from "../../review/summary.js";
import type { ReviewFinding } from "../../review/types.js";
import type {
  PlatformDiscussionMutation,
  PlatformDiscussionMutationResult,
  PlatformFindingPublication,
  PlatformFindingsPublicationResult,
  PlatformReviewComment,
  PlatformReviewPublicationAdapter,
  PlatformReviewDiscussion,
  PlatformSummaryComment,
  PlatformSummaryPublication,
} from "../review-adapter.js";

interface GitLabReviewContext {
  mergeRequest: {
    iid: number;
  };
  discussions: GitLabDiscussion[];
  notes: GitLabNote[];
  changes?: GitLabMergeRequestChange[] | undefined;
  latestVersion?: GitLabMergeRequestVersion | null | undefined;
}

interface PendingGitLabDraft {
  id: string;
  marker: string;
  publication: PlatformFindingPublication;
  body: string;
  positionJson: string | null;
}

interface PublishedGitLabDraftMatch {
  discussion: PlatformReviewDiscussion;
  pending: PendingGitLabDraft;
  rootComment: PlatformReviewComment;
}

export class GitLabReviewPublicationAdapter implements PlatformReviewPublicationAdapter {
  private readonly tenant: TenantRecord;
  private readonly botUserId: number;
  private readonly client: GitLabClient;
  private readonly logger: Logger;
  private readonly interactionRunId: string;
  private readonly context: GitLabReviewContext;

  public constructor(input: {
    tenant: TenantRecord;
    botUserId?: number;
    context: LightweightMergeRequestContext | HydratedMergeRequestContext;
    client: GitLabClient;
    logger: Logger;
    interactionRunId: string;
  }) {
    this.tenant = input.tenant;
    this.botUserId =
      input.botUserId ??
      (JSON.parse(input.tenant.platformConfigJson) as { botUserId: number })
        .botUserId;
    this.context = input.context;
    this.client = input.client;
    this.logger = input.logger;
    this.interactionRunId = input.interactionRunId;
  }

  public async loadDiscussions(options?: {
    fresh?: boolean | undefined;
  }): Promise<PlatformReviewDiscussion[]> {
    const discussions = options?.fresh
      ? await this.client.listCodeReviewDiscussions(
          getGitLabTenantConfig(this.tenant).projectId,
          this.context.mergeRequest.iid,
          { noCache: true },
        )
      : this.context.discussions;
    return discussions.map((discussion) =>
      toPlatformReviewDiscussion(discussion, this.botUserId),
    );
  }

  public async mutateDiscussion(
    mutation: PlatformDiscussionMutation,
  ): Promise<PlatformDiscussionMutationResult> {
    const projectId = getGitLabTenantConfig(this.tenant).projectId;
    switch (mutation.kind) {
      case "set-resolved":
        await this.client.resolveDiscussion(
          projectId,
          this.context.mergeRequest.iid,
          mutation.discussionId,
          mutation.resolved,
        );
        return {};
      case "update-finding": {
        const position = this.findCommentPosition(
          mutation.discussionId,
          mutation.commentId,
        );
        const note = await this.client.updateDiscussionNote(
          projectId,
          this.context.mergeRequest.iid,
          mutation.discussionId,
          Number(mutation.commentId),
          renderGitLabFindingBody(mutation.finding, position),
        );
        return { comment: toPlatformReviewComment(note, this.botUserId) };
      }
      case "reply-finding": {
        const position = this.findRootPosition(mutation.discussionId);
        const note = await this.client.replyToDiscussion(
          projectId,
          this.context.mergeRequest.iid,
          mutation.discussionId,
          renderGitLabFindingBody(mutation.finding, position),
        );
        return { comment: toPlatformReviewComment(note, this.botUserId) };
      }
      case "reply-text": {
        const note = await this.client.replyToDiscussion(
          projectId,
          this.context.mergeRequest.iid,
          mutation.discussionId,
          mutation.body,
        );
        return { comment: toPlatformReviewComment(note, this.botUserId) };
      }
    }
  }

  public async publishFindings(input: {
    publicationKey: string;
    findings: PlatformFindingPublication[];
    existingDiscussionIds: ReadonlySet<string>;
  }): Promise<PlatformFindingsPublicationResult> {
    if (input.findings.length === 0) {
      return { findings: [], links: [] };
    }

    const pending: PendingGitLabDraft[] = [];
    try {
      for (const publication of input.findings) {
        pending.push(await this.createDraft(publication));
      }
      await this.client.bulkPublishCodeReviewDraftNotes(
        getGitLabTenantConfig(this.tenant).projectId,
        this.context.mergeRequest.iid,
      );
      const matches = await this.matchPublishedDrafts({
        pending,
        existingDiscussionIds: input.existingDiscussionIds,
      });
      return {
        findings: matches.map((match) => ({
          identityKey: match.pending.publication.identityKey,
          discussion: match.discussion,
          rootComment: match.rootComment,
          url: match.rootComment.url,
        })),
        links: [],
      };
    } catch (error) {
      try {
        const matches = await this.matchPublishedDrafts({
          pending,
          existingDiscussionIds: input.existingDiscussionIds,
          maxAttempts: 1,
        });
        if (matches.length === pending.length) {
          return {
            findings: matches.map((match) => ({
              identityKey: match.pending.publication.identityKey,
              discussion: match.discussion,
              rootComment: match.rootComment,
              url: match.rootComment.url,
            })),
            links: [],
          };
        }
      } catch {
        // The drafts were not fully published; clean up what remains below.
      }
      await this.cleanupDrafts(pending);
      throw error;
    }
  }

  public async upsertSummary(input: {
    body: string;
  }): Promise<PlatformSummaryPublication> {
    const summaryComments: PlatformSummaryComment[] = this.context.notes.map(
      (note) => ({
        id: String(note.id),
        body: note.body,
        isBot: isBotUser(note.author, this.botUserId),
        updatedAt: note.updated_at ?? null,
        url: null,
      }),
    );
    const existing = findLatestReviewSummaryNote(
      summaryComments,
      (comment) => comment.isBot,
    );
    const projectId = getGitLabTenantConfig(this.tenant).projectId;
    const note = existing
      ? await this.client.updateCodeReviewComment(
          projectId,
          this.context.mergeRequest.iid,
          Number(existing.id),
          input.body,
        )
      : await this.client.createCodeReviewComment(
          projectId,
          this.context.mergeRequest.iid,
          input.body,
        );
    const comment: PlatformSummaryComment = {
      id: String(note.id),
      body: note.body,
      isBot: isBotUser(note.author, this.botUserId),
      updatedAt: note.updated_at ?? null,
      url: null,
    };
    return {
      comment,
      url: comment.url,
      action: existing ? "updated" : "created",
    };
  }

  private async createDraft(
    publication: PlatformFindingPublication,
  ): Promise<PendingGitLabDraft> {
    const context = this.requireHydratedContext();
    const positionAnchor = getGitLabPositionAnchor(publication.finding);
    const position = positionAnchor
      ? buildDiffPosition(
          positionAnchor,
          context.changes as GitLabMergeRequestChange[],
          context.latestVersion as GitLabMergeRequestVersion | null,
        )
      : null;
    const fallbackPosition = positionAnchor
      ? buildFilePosition(
          positionAnchor,
          context.changes as GitLabMergeRequestChange[],
          context.latestVersion as GitLabMergeRequestVersion | null,
        )
      : null;
    const draftNote = await this.createGitLabDraftDiscussion({
      finding: publication.finding,
      marker: publication.marker,
      position,
      fallbackPosition:
        position?.position_type === "file" ? null : fallbackPosition,
    });

    return {
      id: String(draftNote.draftNote.id),
      marker: publication.marker,
      publication,
      body: draftNote.body,
      positionJson: draftNote.position
        ? JSON.stringify(draftNote.position)
        : null,
    };
  }

  private async matchPublishedDrafts(input: {
    pending: ReadonlyArray<PendingGitLabDraft>;
    existingDiscussionIds: ReadonlySet<string>;
    maxAttempts?: number | undefined;
  }): Promise<PublishedGitLabDraftMatch[]> {
    const maxAttempts = input.maxAttempts ?? 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const liveDiscussions = await this.loadDiscussions({ fresh: true });
      const matched = matchPublishedDraftDiscussions({
        pendingDraftDiscussions: input.pending,
        discussions: liveDiscussions,
        existingDiscussionIds: input.existingDiscussionIds,
      });
      if (matched.length === input.pending.length) {
        return matched;
      }

      lastError = new Error(
        `Expected ${input.pending.length} published draft discussions but matched ${matched.length}`,
      );
      if (attempt < maxAttempts) {
        await sleep(250 * attempt);
      }
    }

    throw lastError ?? new Error("Failed to match published draft discussions");
  }

  private async cleanupDrafts(drafts: PendingGitLabDraft[]): Promise<void> {
    for (const draft of drafts) {
      try {
        await this.client.deleteCodeReviewDraftNote(
          getGitLabTenantConfig(this.tenant).projectId,
          this.context.mergeRequest.iid,
          Number(draft.id),
        );
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          error.status === 404
        ) {
          continue;
        }
        this.logger.warn(
          { err: error, draftNoteId: draft.id },
          "failed to clean up GitLab draft note",
        );
      }
    }
  }

  private findCommentPosition(
    discussionId: string,
    commentId: string,
  ): GitLabDiffPosition | null {
    const note = this.context.discussions
      .find((discussion) => discussion.id === discussionId)
      ?.notes.find((candidate) => String(candidate.id) === commentId);
    return note?.position ?? null;
  }

  private findRootPosition(discussionId: string): GitLabDiffPosition | null {
    return (
      this.context.discussions.find(
        (discussion) => discussion.id === discussionId,
      )?.notes[0]?.position ?? null
    );
  }

  private requireHydratedContext(): Required<
    Pick<GitLabReviewContext, "changes" | "latestVersion">
  > &
    GitLabReviewContext {
    const changes = this.context.changes;
    if (!changes) {
      throw new Error(
        "GitLab review discussion adapter requires hydrated change data to create draft threads",
      );
    }

    return {
      ...this.context,
      changes,
      latestVersion: this.context.latestVersion ?? null,
    };
  }

  private async createGitLabDraftDiscussion(input: {
    finding: ReviewFinding;
    marker: string;
    position: GitLabDiffPosition | null;
    fallbackPosition: GitLabDiffPosition | null;
  }): Promise<{
    draftNote: GitLabDraftNote;
    position: GitLabDiffPosition | null;
    body: string;
  }> {
    const createDraft = async (position: GitLabDiffPosition | null) => {
      const body = renderGitLabFindingBody(input.finding, position);
      const payload: { note: string; position?: GitLabDiffPosition } = {
        note: appendReviewDiscussionMarker(body, input.marker),
      };
      if (position) {
        payload.position = position;
      }

      return {
        draftNote: await this.client.createCodeReviewDraftNote(
          getGitLabTenantConfig(this.tenant).projectId,
          this.context.mergeRequest.iid,
          payload,
        ),
        position,
        body,
      };
    };

    const initialPosition = input.position ?? input.fallbackPosition;
    if (!initialPosition) {
      return createDraft(null);
    }

    try {
      return await createDraft(initialPosition);
    } catch (error) {
      if (!isInvalidDiffPositionError(error)) {
        throw error;
      }

      if (
        input.fallbackPosition &&
        initialPosition.position_type !== input.fallbackPosition.position_type
      ) {
        this.logger.warn(
          {
            err: error,
            interactionRunId: this.interactionRunId,
            projectId: getGitLabTenantConfig(this.tenant).projectId,
            codeReviewId: this.context.mergeRequest.iid,
            findingTitle: input.finding.title,
            anchor: input.finding.anchor,
            position: initialPosition,
            fallbackPosition: input.fallbackPosition,
          },
          "GitLab rejected diff note position; retrying as a file-level thread",
        );

        return createDraft(input.fallbackPosition);
      }

      this.logger.warn(
        {
          err: error,
          interactionRunId: this.interactionRunId,
          projectId: getGitLabTenantConfig(this.tenant).projectId,
          codeReviewId: this.context.mergeRequest.iid,
          findingTitle: input.finding.title,
          anchor: input.finding.anchor,
          position: initialPosition,
        },
        "GitLab rejected diff note position; retrying as an overview thread",
      );

      return createDraft(null);
    }
  }
}

export function toPlatformReviewDiscussion(
  discussion: GitLabDiscussion,
  botUserId: number,
): PlatformReviewDiscussion {
  const comments = discussion.notes.map((note) =>
    toPlatformReviewComment(note, botUserId),
  );
  return {
    id: discussion.id,
    comments,
    resolvable: comments.some((comment) => comment.resolvable),
    resolved: comments.some((comment) => comment.resolved),
  };
}

export function toPlatformReviewComment(
  note: GitLabNote,
  botUserId: number,
): PlatformReviewComment {
  return {
    id: String(note.id),
    body: note.body,
    authorId: String(note.author.id),
    authorUsername: note.author.username,
    isBot: isBotUser(note.author, botUserId),
    resolvable: note.resolvable === true,
    resolved: note.resolved === true,
    createdAt: note.created_at ?? null,
    updatedAt: note.updated_at ?? null,
    anchor: extractAnchorFromPosition(note.position ?? null),
    positionJson: note.position ? JSON.stringify(note.position) : null,
    url: null,
  };
}

function compareDiscussionsByRecency(
  left: PlatformReviewDiscussion,
  right: PlatformReviewDiscussion,
): number {
  const leftRootComment = left.comments[0];
  const rightRootComment = right.comments[0];
  const leftCreatedAt = leftRootComment?.createdAt
    ? Date.parse(leftRootComment.createdAt)
    : Number.NaN;
  const rightCreatedAt = rightRootComment?.createdAt
    ? Date.parse(rightRootComment.createdAt)
    : Number.NaN;

  if (Number.isFinite(leftCreatedAt) && Number.isFinite(rightCreatedAt)) {
    const createdAtDelta = rightCreatedAt - leftCreatedAt;
    if (createdAtDelta !== 0) {
      return createdAtDelta;
    }
  }

  return (
    Number(rightRootComment?.id ?? "0") - Number(leftRootComment?.id ?? "0")
  );
}

function positionJsonMatches(
  actualPositionJson: string | null,
  expectedPositionJson: string | null,
): boolean {
  if (!actualPositionJson && !expectedPositionJson) {
    return true;
  }

  if (!actualPositionJson || !expectedPositionJson) {
    return false;
  }

  return actualPositionJson === expectedPositionJson;
}

function matchPublishedDraftDiscussions(input: {
  pendingDraftDiscussions: ReadonlyArray<PendingGitLabDraft>;
  discussions: ReadonlyArray<PlatformReviewDiscussion>;
  existingDiscussionIds: ReadonlySet<string>;
}): PublishedGitLabDraftMatch[] {
  const availableDiscussions = input.discussions
    .filter((discussion) => {
      if (input.existingDiscussionIds.has(discussion.id)) {
        return false;
      }

      const rootComment = discussion.comments[0];
      if (!rootComment) {
        return false;
      }

      if (!rootComment.isBot) {
        return false;
      }

      return !isReviewSummaryNoteBody(rootComment.body);
    })
    .sort(compareDiscussionsByRecency);
  const usedDiscussionIds = new Set<string>();
  const matched: PublishedGitLabDraftMatch[] = [];
  const sortedPendingDraftDiscussions = [...input.pendingDraftDiscussions].sort(
    (left, right) =>
      Number(right.positionJson !== null) -
        Number(left.positionJson !== null) ||
      Number(right.id) - Number(left.id),
  );

  for (const pending of sortedPendingDraftDiscussions) {
    const markerMatches = availableDiscussions.filter((discussion) => {
      if (usedDiscussionIds.has(discussion.id)) {
        return false;
      }

      const rootComment = discussion.comments[0];
      if (!rootComment) {
        return false;
      }

      const rootDraftMarker = extractReviewDiscussionMarker(rootComment.body);
      return rootDraftMarker === pending.marker;
    });
    const fallbackMatches = markerMatches.length
      ? []
      : availableDiscussions.filter((discussion) => {
          if (usedDiscussionIds.has(discussion.id)) {
            return false;
          }

          const rootComment = discussion.comments[0];
          if (!rootComment) {
            return false;
          }

          const rootDraftMarker = extractReviewDiscussionMarker(
            rootComment.body,
          );
          if (rootDraftMarker !== null) {
            return false;
          }

          return (
            stripReviewDiscussionMarker(rootComment.body) === pending.body &&
            positionJsonMatches(rootComment.positionJson, pending.positionJson)
          );
        });
    const candidates =
      markerMatches.length > 0 ? markerMatches : fallbackMatches;
    if (candidates.length === 0) {
      continue;
    }

    const discussion = candidates[0];
    const rootComment = discussion?.comments[0];
    if (!discussion || !rootComment) {
      continue;
    }

    usedDiscussionIds.add(discussion.id);
    matched.push({
      pending,
      discussion,
      rootComment,
    });
  }

  return matched;
}

function isInvalidDiffPositionError(error: unknown): error is GitLabApiError {
  return (
    error instanceof GitLabApiError &&
    error.status === 400 &&
    /\bline_code\b|\bvalid line code\b|\bposition\b[\s\S]*\b(?:invalid|incomplete)\b/i.test(
      error.responseBody,
    )
  );
}

async function sleep(durationMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

function getGitLabPositionAnchor(
  finding: Pick<ReviewFinding, "anchor" | "suggestion">,
): LineAnchorLike | null {
  const anchor = finding.anchor ?? null;
  const suggestion = finding.suggestion ?? null;
  if (
    anchor &&
    suggestion &&
    anchor.side === "new" &&
    suggestion.startLine >= anchor.startLine &&
    suggestion.endLine <= anchor.endLine
  ) {
    return {
      ...anchor,
      startLine: suggestion.startLine,
      endLine: suggestion.endLine,
    };
  }

  return anchor;
}

function renderGitLabFindingBody(
  finding: Pick<ReviewFinding, "title" | "body" | "anchor" | "suggestion">,
  position: GitLabDiffPosition | null,
): string {
  return appendSuggestion(
    renderReviewFindingProse(finding),
    renderSuggestionMarkdown(
      finding.suggestion ?? null,
      finding.anchor ?? null,
      position,
    ),
  );
}
