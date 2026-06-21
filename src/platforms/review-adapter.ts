import type { ReviewAnchor, ReviewFinding } from "../review/types.js";

export interface PlatformPublicationLink {
  label: string;
  url: string;
}

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
  url: string | null;
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
  url: string | null;
}

export type PlatformDiscussionMutation =
  | {
      kind: "update-finding";
      discussionId: string;
      commentId: string;
      finding: ReviewFinding;
    }
  | {
      kind: "reply-finding";
      discussionId: string;
      finding: ReviewFinding;
    }
  | {
      kind: "reply-text";
      discussionId: string;
      body: string;
    }
  | {
      kind: "set-resolved";
      discussionId: string;
      resolved: boolean;
    };

export interface PlatformDiscussionMutationResult {
  discussion?: PlatformReviewDiscussion | undefined;
  comment?: PlatformReviewComment | undefined;
}

export interface PlatformFindingPublication {
  finding: ReviewFinding;
  identityKey: string;
  fingerprint: string;
  marker: string;
}

export interface PlatformPublishedFinding {
  identityKey: string;
  discussion: PlatformReviewDiscussion;
  rootComment: PlatformReviewComment;
  url: string | null;
}

export interface PlatformFindingsPublicationResult {
  findings: PlatformPublishedFinding[];
  links: PlatformPublicationLink[];
}

export interface PlatformSummaryPublication {
  comment: PlatformSummaryComment;
  url: string | null;
  action: "created" | "updated";
}

export interface PlatformReviewPublicationAdapter {
  loadDiscussions(options?: {
    fresh?: boolean | undefined;
  }): Promise<PlatformReviewDiscussion[]>;
  mutateDiscussion(
    mutation: PlatformDiscussionMutation,
  ): Promise<PlatformDiscussionMutationResult>;
  publishFindings(input: {
    publicationKey: string;
    findings: PlatformFindingPublication[];
    existingDiscussionIds: ReadonlySet<string>;
  }): Promise<PlatformFindingsPublicationResult>;
  upsertSummary(input: { body: string }): Promise<PlatformSummaryPublication>;
}
