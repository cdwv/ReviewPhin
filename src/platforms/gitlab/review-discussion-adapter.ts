import type { Logger } from "pino";

import { buildDiffPosition } from "./positions.js";
import { buildFilePosition } from "./positions.js";
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
  stripReviewDiscussionMarker,
} from "../../review/discussion-format.js";
import { isReviewSummaryNoteBody } from "../../review/summary.js";
import type { ReviewFinding } from "../../review/types.js";
import type {
  PlatformDraftDiscussion,
  PlatformPublishedDraftDiscussionMatch,
  PlatformReviewComment,
  PlatformReviewDiscussionAdapter,
  PlatformReviewDiscussion,
  PlatformSummaryComment,
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

export class GitLabReviewDiscussionAdapter implements PlatformReviewDiscussionAdapter {
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

  public async listDiscussions(options?: {
    noCache?: boolean | undefined;
  }): Promise<PlatformReviewDiscussion[]> {
    const discussions = options?.noCache
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

  public async listSummaryComments(): Promise<PlatformSummaryComment[]> {
    return this.context.notes.map((note) => ({
      id: String(note.id),
      body: note.body,
      isBot: isBotUser(note.author, this.botUserId),
      updatedAt: note.updated_at ?? null,
    }));
  }

  public async replyToDiscussion(
    discussionId: string,
    body: string,
  ): Promise<PlatformReviewComment> {
    const note = await this.client.replyToDiscussion(
      getGitLabTenantConfig(this.tenant).projectId,
      this.context.mergeRequest.iid,
      discussionId,
      body,
    );
    return toPlatformReviewComment(note, this.botUserId);
  }

  public async setDiscussionResolved(
    discussionId: string,
    resolved: boolean,
  ): Promise<void> {
    await this.client.resolveDiscussion(
      getGitLabTenantConfig(this.tenant).projectId,
      this.context.mergeRequest.iid,
      discussionId,
      resolved,
    );
  }

  public async updateComment(
    discussionId: string,
    commentId: string,
    body: string,
  ): Promise<PlatformReviewComment> {
    const note = await this.client.updateDiscussionNote(
      getGitLabTenantConfig(this.tenant).projectId,
      this.context.mergeRequest.iid,
      discussionId,
      Number(commentId),
      body,
    );
    return toPlatformReviewComment(note, this.botUserId);
  }

  public async createDraftDiscussion(input: {
    finding: ReviewFinding;
    body: string;
    draftMarker: string;
  }): Promise<PlatformDraftDiscussion> {
    const context = this.requireHydratedContext();
    const position = input.finding.anchor
      ? buildDiffPosition(
          input.finding.anchor,
          context.changes as GitLabMergeRequestChange[],
          context.latestVersion as GitLabMergeRequestVersion | null,
        )
      : null;
    const fallbackPosition = input.finding.anchor
      ? buildFilePosition(
          input.finding.anchor,
          context.changes as GitLabMergeRequestChange[],
          context.latestVersion as GitLabMergeRequestVersion | null,
        )
      : null;
    const noteBody = appendReviewDiscussionMarker(
      input.body,
      input.draftMarker,
    );
    const draftNote = await this.createGitLabDraftDiscussion({
      finding: input.finding,
      noteBody,
      position,
      fallbackPosition:
        position?.position_type === "file" ? null : fallbackPosition,
    });

    return {
      id: String(draftNote.draftNote.id),
      draftMarker: input.draftMarker,
      finding: input.finding,
      body: input.body,
      positionJson: draftNote.position
        ? JSON.stringify(draftNote.position)
        : null,
    };
  }

  public async publishDraftDiscussions(): Promise<void> {
    await this.client.bulkPublishCodeReviewDraftNotes(
      getGitLabTenantConfig(this.tenant).projectId,
      this.context.mergeRequest.iid,
    );
  }

  public async deleteDraftDiscussion(draftDiscussionId: string): Promise<void> {
    await this.client.deleteCodeReviewDraftNote(
      getGitLabTenantConfig(this.tenant).projectId,
      this.context.mergeRequest.iid,
      Number(draftDiscussionId),
    );
  }

  public async matchPublishedDraftDiscussions<
    TPending extends PlatformDraftDiscussion,
  >(input: {
    pendingDraftDiscussions: ReadonlyArray<TPending>;
    existingDiscussionIds: ReadonlySet<string>;
    maxAttempts?: number | undefined;
  }): Promise<PlatformPublishedDraftDiscussionMatch<TPending>[]> {
    const maxAttempts = input.maxAttempts ?? 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const liveDiscussions = await this.listDiscussions({ noCache: true });
      const matched = matchPublishedDraftDiscussions({
        pendingDraftDiscussions: input.pendingDraftDiscussions,
        discussions: liveDiscussions,
        existingDiscussionIds: input.existingDiscussionIds,
      });
      if (matched.length === input.pendingDraftDiscussions.length) {
        return matched;
      }

      lastError = new Error(
        `Expected ${input.pendingDraftDiscussions.length} published draft discussions but matched ${matched.length}`,
      );
      if (attempt < maxAttempts) {
        await sleep(250 * attempt);
      }
    }

    throw lastError ?? new Error("Failed to match published draft discussions");
  }

  public async createSummaryComment(body: string): Promise<void> {
    await this.client.createCodeReviewComment(
      getGitLabTenantConfig(this.tenant).projectId,
      this.context.mergeRequest.iid,
      body,
    );
  }

  public async updateSummaryComment(
    commentId: string,
    body: string,
  ): Promise<void> {
    await this.client.updateCodeReviewComment(
      getGitLabTenantConfig(this.tenant).projectId,
      this.context.mergeRequest.iid,
      Number(commentId),
      body,
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
    noteBody: string;
    position: GitLabDiffPosition | null;
    fallbackPosition: GitLabDiffPosition | null;
  }): Promise<{
    draftNote: GitLabDraftNote;
    position: GitLabDiffPosition | null;
  }> {
    const initialPosition = input.position ?? input.fallbackPosition;
    if (!initialPosition) {
      return {
        draftNote: await this.client.createCodeReviewDraftNote(
          getGitLabTenantConfig(this.tenant).projectId,
          this.context.mergeRequest.iid,
          {
            note: input.noteBody,
          },
        ),
        position: null,
      };
    }

    try {
      return {
        draftNote: await this.client.createCodeReviewDraftNote(
          getGitLabTenantConfig(this.tenant).projectId,
          this.context.mergeRequest.iid,
          {
            note: input.noteBody,
            position: initialPosition,
          },
        ),
        position: initialPosition,
      };
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

        return {
          draftNote: await this.client.createCodeReviewDraftNote(
            getGitLabTenantConfig(this.tenant).projectId,
            this.context.mergeRequest.iid,
            {
              note: input.noteBody,
              position: input.fallbackPosition,
            },
          ),
          position: input.fallbackPosition,
        };
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

      return {
        draftNote: await this.client.createCodeReviewDraftNote(
          getGitLabTenantConfig(this.tenant).projectId,
          this.context.mergeRequest.iid,
          {
            note: input.noteBody,
          },
        ),
        position: null,
      };
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

function matchPublishedDraftDiscussions<
  TPending extends PlatformDraftDiscussion,
>(input: {
  pendingDraftDiscussions: ReadonlyArray<TPending>;
  discussions: ReadonlyArray<PlatformReviewDiscussion>;
  existingDiscussionIds: ReadonlySet<string>;
}): PlatformPublishedDraftDiscussionMatch<TPending>[] {
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
  const matched: PlatformPublishedDraftDiscussionMatch<TPending>[] = [];
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
      return rootDraftMarker === pending.draftMarker;
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
