import type { ReviewAnchor, ReviewFinding } from "../review/types.js";

export interface PlatformReviewComment {
  id: string;
  body: string;
  authorId: string | null;
  authorUsername: string | null;
  isBot: boolean;
  resolvable: boolean;
  resolved: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  anchor: ReviewAnchor | null;
  positionJson: string | null;
}

export interface PlatformReviewDiscussion {
  id: string;
  comments: PlatformReviewComment[];
  resolvable: boolean;
  resolved: boolean;
}

export interface PlatformSummaryComment {
  id: string;
  body: string;
  isBot: boolean;
  updatedAt: string | null;
}

export interface PlatformDraftDiscussion {
  id: string;
  draftMarker: string;
  finding: ReviewFinding;
  body: string;
  positionJson: string | null;
}

export interface PlatformPublishedDraftDiscussionMatch<
  TPending extends PlatformDraftDiscussion,
> {
  discussion: PlatformReviewDiscussion;
  pending: TPending;
  rootComment: PlatformReviewComment;
}

export interface PlatformReviewDiscussionAdapter {
  listDiscussions(options?: {
    noCache?: boolean | undefined;
  }): Promise<PlatformReviewDiscussion[]>;
  listSummaryComments(): Promise<PlatformSummaryComment[]>;
  replyToDiscussion(
    discussionId: string,
    body: string,
  ): Promise<PlatformReviewComment>;
  setDiscussionResolved(discussionId: string, resolved: boolean): Promise<void>;
  updateComment(
    discussionId: string,
    commentId: string,
    body: string,
  ): Promise<PlatformReviewComment>;
  createDraftDiscussion(input: {
    finding: ReviewFinding;
    body: string;
    draftMarker: string;
  }): Promise<PlatformDraftDiscussion>;
  publishDraftDiscussions(): Promise<void>;
  deleteDraftDiscussion(draftDiscussionId: string): Promise<void>;
  matchPublishedDraftDiscussions<
    TPending extends PlatformDraftDiscussion,
  >(input: {
    pendingDraftDiscussions: ReadonlyArray<TPending>;
    existingDiscussionIds: ReadonlySet<string>;
    maxAttempts?: number | undefined;
  }): Promise<PlatformPublishedDraftDiscussionMatch<TPending>[]>;
  createSummaryComment(body: string): Promise<void>;
  updateSummaryComment(commentId: string, body: string): Promise<void>;
}
