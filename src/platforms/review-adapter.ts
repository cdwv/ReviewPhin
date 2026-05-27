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

export interface PlatformReviewThread {
  id: string;
  comments: PlatformReviewComment[];
  resolvable: boolean;
  resolved: boolean;
}

export interface PlatformSummaryNote {
  id: string;
  body: string;
  isBot: boolean;
  updatedAt: string | null;
}

export interface PlatformDraftThread {
  id: string;
  draftMarker: string;
  finding: ReviewFinding;
  body: string;
  positionJson: string | null;
}

export interface PlatformPublishedDraftThreadMatch<TPending extends PlatformDraftThread> {
  thread: PlatformReviewThread;
  pending: TPending;
  rootComment: PlatformReviewComment;
}

export interface PlatformReviewDiscussionAdapter {
  listThreads(options?: {
    noCache?: boolean | undefined;
  }): Promise<PlatformReviewThread[]>;
  listSummaryNotes(): Promise<PlatformSummaryNote[]>;
  replyToThread(
    threadId: string,
    body: string,
  ): Promise<PlatformReviewComment>;
  setThreadResolved(threadId: string, resolved: boolean): Promise<void>;
  updateComment(
    threadId: string,
    commentId: string,
    body: string,
  ): Promise<PlatformReviewComment>;
  createDraftThread(input: {
    finding: ReviewFinding;
    body: string;
    draftMarker: string;
  }): Promise<PlatformDraftThread>;
  publishDraftThreads(): Promise<void>;
  deleteDraftThread(draftThreadId: string): Promise<void>;
  matchPublishedDraftThreads<TPending extends PlatformDraftThread>(input: {
    pendingDraftThreads: ReadonlyArray<TPending>;
    existingThreadIds: ReadonlySet<string>;
    maxAttempts?: number | undefined;
  }): Promise<PlatformPublishedDraftThreadMatch<TPending>[]>;
  createSummaryNote(body: string): Promise<void>;
  updateSummaryNote(noteId: string, body: string): Promise<void>;
}
