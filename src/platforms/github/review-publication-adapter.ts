import type {
  PlatformDiscussionMutation,
  PlatformDiscussionMutationResult,
  PlatformFindingPublication,
  PlatformFindingsPublicationResult,
  PlatformReviewComment,
  PlatformReviewDiscussion,
  PlatformReviewPublicationAdapter,
  PlatformSummaryComment,
  PlatformSummaryPublication,
} from "../review-adapter.js";
import {
  findLatestReviewSummaryNote,
  isReviewSummaryNoteBody,
} from "../../review/summary.js";
import type { ReviewAnchor, ReviewFinding } from "../../review/types.js";
import {
  GitHubApiError,
  type GitHubClient,
  type GitHubIssueComment,
  type GitHubPendingReviewComment,
  type GitHubPullRequestFile,
  type GitHubPullRequestReview,
  type GitHubReviewComment,
  type GitHubReviewThread,
} from "./client.js";

const PUBLICATION_MARKER_PREFIX = "reviewphin-publication:";
const FINDING_MARKER_PREFIX = "reviewphin-finding:";
const FINDING_MARKER_PATTERN = /<!--\s*reviewphin-finding:([^>]+?)\s*-->/;
const FINDING_REPLY_MARKER_PREFIX = "reviewphin-finding-reply:";
const FINDING_REPLY_MARKER_PATTERN =
  /<!--\s*reviewphin-finding-reply:(\d+)\s*-->/;
const PUBLISHED_FINDING_MATCH_MAX_ATTEMPTS = 3;

export class GitHubReviewPublicationAdapter implements PlatformReviewPublicationAdapter {
  public constructor(
    private readonly input: {
      client: GitHubClient;
      repositoryFullName: string;
      pullRequestNumber: number;
      headSha: string;
      files: GitHubPullRequestFile[];
      issueComments: GitHubIssueComment[];
      reviews: GitHubPullRequestReview[];
      reviewComments: GitHubReviewComment[];
      reviewThreads: GitHubReviewThread[];
      botLogin: string;
    },
  ) {}

  public async loadDiscussions(options?: {
    fresh?: boolean | undefined;
  }): Promise<PlatformReviewDiscussion[]> {
    if (!options?.fresh) {
      return this.buildDiscussions({
        issueComments: this.input.issueComments,
        reviewComments: this.input.reviewComments,
        reviewThreads: this.input.reviewThreads,
      });
    }
    const [issueComments, reviewComments, reviewThreads] = await Promise.all([
      this.input.client.listIssueComments(
        this.input.repositoryFullName,
        this.input.pullRequestNumber,
      ),
      this.input.client.listReviewComments(
        this.input.repositoryFullName,
        this.input.pullRequestNumber,
      ),
      this.input.client.listReviewThreads(
        this.input.repositoryFullName,
        this.input.pullRequestNumber,
      ),
    ]);
    return this.buildDiscussions({
      issueComments,
      reviewComments,
      reviewThreads,
    });
  }

  public async mutateDiscussion(
    mutation: PlatformDiscussionMutation,
  ): Promise<PlatformDiscussionMutationResult> {
    const issueCommentId = parseIssueDiscussionId(mutation.discussionId);
    if (issueCommentId !== null) {
      const issueComments = await this.input.client.listIssueComments(
        this.input.repositoryFullName,
        this.input.pullRequestNumber,
      );
      const rootComment = issueComments.find(
        (entry) => entry.id === issueCommentId,
      );
      const findingMarker = rootComment
        ? extractFindingMarker(rootComment.body ?? "")
        : null;
      if (
        !rootComment ||
        !isGitHubBot(rootComment.user?.login ?? null, this.input.botLogin) ||
        !findingMarker
      ) {
        throw new Error(
          `Refusing to mutate GitHub issue-comment finding ${issueCommentId} because it is not owned by ReviewPhin`,
        );
      }
      switch (mutation.kind) {
        case "update-finding": {
          const comment = await this.input.client.updateIssueComment({
            repositoryFullName: this.input.repositoryFullName,
            commentId: issueCommentId,
            body: appendFindingMarker(
              renderGitHubFindingBody(mutation.finding, {
                includeSuggestion: false,
              }),
              findingMarker,
            ),
          });
          return {
            comment: toPlatformIssueComment(comment, this.input.botLogin),
          };
        }
        case "reply-finding":
        case "reply-text": {
          const body =
            mutation.kind === "reply-text"
              ? mutation.body
              : renderGitHubFindingBody(mutation.finding, {
                  includeSuggestion: false,
                });
          const comment = await this.input.client.createIssueComment({
            repositoryFullName: this.input.repositoryFullName,
            issueNumber: this.input.pullRequestNumber,
            body: appendFindingReplyMarker(body, issueCommentId),
          });
          return {
            comment: toPlatformIssueComment(comment, this.input.botLogin),
          };
        }
        case "set-resolved":
          throw new Error(
            `GitHub issue-comment finding ${issueCommentId} cannot be resolved natively`,
          );
      }
    }

    switch (mutation.kind) {
      case "set-resolved":
        await this.assertDiscussionBotOwned(mutation.discussionId);
        try {
          await this.input.client.setReviewThreadResolved(
            mutation.discussionId,
            mutation.resolved,
          );
          return {};
        } catch (error) {
          const skipReason = getPermanentGitHubResolutionFailure(error);
          if (!skipReason) {
            throw error;
          }
          return {
            skipped: true,
            skipReason,
          };
        }
      case "update-finding": {
        const existing = this.findReviewComment(Number(mutation.commentId));
        this.assertBotOwned(existing);
        const comment = await this.input.client.updateReviewComment({
          repositoryFullName: this.input.repositoryFullName,
          commentId: existing.id,
          body: withExistingFindingMarker(
            renderGitHubFindingBody(mutation.finding, {
              includeSuggestion: canRenderSuggestion(mutation.finding),
            }),
            existing.body,
          ),
        });
        return {
          comment: toPlatformReviewComment(
            comment,
            this.input.botLogin,
            false,
            true,
          ),
        };
      }
      case "reply-finding":
      case "reply-text": {
        const discussion = (await this.loadDiscussions({ fresh: true })).find(
          (entry) => entry.id === mutation.discussionId,
        );
        const rootComment = discussion?.comments[0];
        if (!rootComment) {
          throw new Error(
            `GitHub review thread ${mutation.discussionId} has no root comment`,
          );
        }
        const comment = await this.input.client.replyToReviewComment({
          repositoryFullName: this.input.repositoryFullName,
          pullRequestNumber: this.input.pullRequestNumber,
          commentId: Number(rootComment.id),
          body:
            mutation.kind === "reply-text"
              ? mutation.body
              : renderGitHubFindingBody(mutation.finding, {
                  includeSuggestion: false,
                }),
        });
        return {
          comment: toPlatformReviewComment(
            comment,
            this.input.botLogin,
            false,
            true,
          ),
        };
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

    const recovered = await this.findPublishedFindings(input.findings);
    if (recovered.length === input.findings.length) {
      return this.buildPublicationResult(
        recovered,
        this.findReviewUrl(recovered),
      );
    }

    const inline: Array<{
      publication: PlatformFindingPublication;
      comment: GitHubPendingReviewComment;
    }> = [];
    const issue: PlatformFindingPublication[] = [];
    for (const publication of input.findings) {
      const comment = this.buildPendingReviewComment(publication);
      if (comment) {
        inline.push({ publication, comment });
      } else {
        issue.push(publication);
      }
    }

    let reviewUrl: string | null = null;
    if (inline.length > 0) {
      const review = await this.findOrCreateReview({
        publicationKey: input.publicationKey,
        comments: inline.map((entry) => entry.comment),
      });
      if (review.state.toUpperCase() === "PENDING") {
        try {
          await this.input.client.submitPullRequestReview({
            repositoryFullName: this.input.repositoryFullName,
            pullRequestNumber: this.input.pullRequestNumber,
            reviewId: review.id,
          });
        } catch (error) {
          const reviews = await this.input.client.listPullRequestReviews(
            this.input.repositoryFullName,
            this.input.pullRequestNumber,
          );
          const recoveredReview = reviews.find(
            (entry) => entry.id === review.id,
          );
          if (!recoveredReview || recoveredReview.state === "PENDING") {
            throw error;
          }
          reviewUrl = recoveredReview.html_url;
        }
      }
      reviewUrl ??= review.html_url;
    }

    for (const publication of issue) {
      const existing = await this.findIssueFinding(publication.marker);
      if (existing) {
        continue;
      }
      await this.input.client.createIssueComment({
        repositoryFullName: this.input.repositoryFullName,
        issueNumber: this.input.pullRequestNumber,
        body: appendFindingMarker(
          renderGitHubFindingBody(publication.finding, {
            includeSuggestion: false,
          }),
          publication.marker,
        ),
      });
    }

    const published = await this.waitForPublishedFindings(input.findings);
    if (published.length !== input.findings.length) {
      throw new Error(
        `GitHub published ${published.length} of ${input.findings.length} findings`,
      );
    }
    return this.buildPublicationResult(published, reviewUrl);
  }

  public async upsertSummary(input: {
    body: string;
  }): Promise<PlatformSummaryPublication> {
    const comments = await this.input.client.listIssueComments(
      this.input.repositoryFullName,
      this.input.pullRequestNumber,
    );
    const summaries = comments.map((comment) =>
      toPlatformSummaryComment(comment, this.input.botLogin),
    );
    const existing = findLatestReviewSummaryNote(
      summaries,
      (comment) => comment.isBot,
    );
    const published = existing
      ? await this.input.client.updateIssueComment({
          repositoryFullName: this.input.repositoryFullName,
          commentId: Number(existing.id),
          body: input.body,
        })
      : await this.input.client.createIssueComment({
          repositoryFullName: this.input.repositoryFullName,
          issueNumber: this.input.pullRequestNumber,
          body: input.body,
        });
    const comment = toPlatformSummaryComment(published, this.input.botLogin);
    return {
      comment,
      url: comment.url,
      action: existing ? "updated" : "created",
    };
  }

  private async findOrCreateReview(input: {
    publicationKey: string;
    comments: GitHubPendingReviewComment[];
  }): Promise<GitHubPullRequestReview> {
    const marker = publicationMarker(input.publicationKey);
    const reviews = await this.input.client.listPullRequestReviews(
      this.input.repositoryFullName,
      this.input.pullRequestNumber,
    );
    const existing = reviews.find(
      (review) =>
        isGitHubBot(review.user?.login ?? null, this.input.botLogin) &&
        review.body?.includes(marker),
    );
    if (existing) {
      return existing;
    }
    for (const review of reviews) {
      if (
        review.state.toUpperCase() === "PENDING" &&
        isGitHubBot(review.user?.login ?? null, this.input.botLogin) &&
        review.body?.includes(`<!-- ${PUBLICATION_MARKER_PREFIX}`)
      ) {
        await this.input.client.deletePendingPullRequestReview({
          repositoryFullName: this.input.repositoryFullName,
          pullRequestNumber: this.input.pullRequestNumber,
          reviewId: review.id,
        });
      }
    }
    return this.input.client.createPullRequestReview({
      repositoryFullName: this.input.repositoryFullName,
      pullRequestNumber: this.input.pullRequestNumber,
      commitId: this.input.headSha,
      body: marker,
      comments: input.comments,
    });
  }

  private buildPendingReviewComment(
    publication: PlatformFindingPublication,
  ): GitHubPendingReviewComment | null {
    const anchor = publication.finding.anchor;
    const file = anchor
      ? this.input.files.find(
          (entry) =>
            entry.filename === anchor.path ||
            entry.previous_filename === anchor.path,
        )
      : null;
    if (!anchor || !file) {
      return null;
    }
    const body = appendFindingMarker(
      renderGitHubFindingBody(publication.finding, {
        includeSuggestion: canRenderSuggestion(publication.finding),
      }),
      publication.marker,
    );
    if (anchor.side !== "new" || !diffContainsRange(file.patch, anchor)) {
      return null;
    }
    return {
      path: file.filename,
      body,
      line: anchor.endLine,
      side: "RIGHT",
      ...(anchor.startLine !== anchor.endLine
        ? { startLine: anchor.startLine, startSide: "RIGHT" }
        : {}),
    };
  }

  private async findPublishedFindings(
    publications: PlatformFindingPublication[],
  ): Promise<
    Array<{
      publication: PlatformFindingPublication;
      discussion: PlatformReviewDiscussion;
      rootComment: PlatformReviewComment;
    }>
  > {
    const discussions = await this.loadDiscussions({ fresh: true });
    const result = [];
    for (const publication of publications) {
      const discussion = discussions.find((entry) =>
        entry.comments.some(
          (comment) =>
            extractFindingMarker(comment.body) === publication.marker,
        ),
      );
      const rootComment = discussion?.comments.find(
        (comment) => extractFindingMarker(comment.body) === publication.marker,
      );
      if (discussion && rootComment) {
        result.push({ publication, discussion, rootComment });
      }
    }
    return result;
  }

  private async waitForPublishedFindings(
    publications: PlatformFindingPublication[],
  ): ReturnType<GitHubReviewPublicationAdapter["findPublishedFindings"]> {
    let published: Awaited<
      ReturnType<GitHubReviewPublicationAdapter["findPublishedFindings"]>
    > = [];
    for (
      let attempt = 1;
      attempt <= PUBLISHED_FINDING_MATCH_MAX_ATTEMPTS;
      attempt += 1
    ) {
      published = await this.findPublishedFindings(publications);
      if (published.length === publications.length) {
        return published;
      }
      if (attempt < PUBLISHED_FINDING_MATCH_MAX_ATTEMPTS) {
        await sleep(250 * attempt);
      }
    }
    return published;
  }

  private buildPublicationResult(
    published: Array<{
      publication: PlatformFindingPublication;
      discussion: PlatformReviewDiscussion;
      rootComment: PlatformReviewComment;
    }>,
    reviewUrl: string | null,
  ): PlatformFindingsPublicationResult {
    const urls = new Set(
      published
        .map((entry) => entry.rootComment.url)
        .filter((url): url is string => Boolean(url)),
    );
    return {
      findings: published.map((entry) => ({
        identityKey: entry.publication.identityKey,
        discussion: entry.discussion,
        rootComment: entry.rootComment,
        url: entry.rootComment.url,
      })),
      links: [...urls]
        .map((url, index) => ({
          label: `GitHub finding ${index + 1}`,
          url,
        }))
        .concat(reviewUrl ? [{ label: "GitHub review", url: reviewUrl }] : []),
    };
  }

  private async findIssueFinding(
    marker: string,
  ): Promise<GitHubIssueComment | null> {
    const comments = await this.input.client.listIssueComments(
      this.input.repositoryFullName,
      this.input.pullRequestNumber,
    );
    return (
      comments.find(
        (comment) =>
          isGitHubBot(comment.user?.login ?? null, this.input.botLogin) &&
          extractFindingMarker(comment.body ?? "") === marker,
      ) ?? null
    );
  }

  private buildDiscussions(input: {
    issueComments: GitHubIssueComment[];
    reviewComments: GitHubReviewComment[];
    reviewThreads: GitHubReviewThread[];
  }): PlatformReviewDiscussion[] {
    const reviewCommentById = new Map(
      input.reviewComments.map((comment) => [comment.id, comment]),
    );
    const reviewDiscussions = input.reviewThreads
      .map((thread) => {
        const comments = thread.comments.nodes
          .map((node) => reviewCommentById.get(node.databaseId))
          .filter((comment): comment is GitHubReviewComment => Boolean(comment))
          .map((comment) =>
            toPlatformReviewComment(
              comment,
              this.input.botLogin,
              thread.isResolved,
              canMutateReviewThreadResolution(thread),
            ),
          );
        if (comments.length === 0) {
          return null;
        }
        return {
          id: thread.id,
          comments,
          resolvable: canMutateReviewThreadResolution(thread),
          resolved: thread.isResolved,
        };
      })
      .filter(
        (discussion): discussion is PlatformReviewDiscussion =>
          discussion !== null,
      );
    const fallbackReviewDiscussions =
      buildGitHubReviewCommentFallbackDiscussions(
        input.reviewComments,
        input.reviewThreads,
        this.input.botLogin,
      );
    const issueDiscussions = buildGitHubIssueCommentDiscussions(
      input.issueComments,
      this.input.botLogin,
    );
    return [
      ...reviewDiscussions,
      ...fallbackReviewDiscussions,
      ...issueDiscussions,
    ];
  }

  private findReviewComment(commentId: number): GitHubReviewComment {
    const comment = this.input.reviewComments.find(
      (entry) => entry.id === commentId,
    );
    if (!comment) {
      throw new Error(`GitHub review comment ${commentId} was not found`);
    }
    return comment;
  }

  private assertBotOwned(comment: GitHubReviewComment): void {
    if (!isGitHubBot(comment.user?.login ?? null, this.input.botLogin)) {
      throw new Error(
        `Refusing to update GitHub review comment ${comment.id} because it is not owned by ReviewPhin`,
      );
    }
  }

  private async assertDiscussionBotOwned(discussionId: string): Promise<void> {
    const discussion = (await this.loadDiscussions({ fresh: true })).find(
      (entry) => entry.id === discussionId,
    );
    if (!discussion?.comments[0]?.isBot) {
      throw new Error(
        `Refusing to mutate GitHub review thread ${discussionId} because it is not owned by ReviewPhin`,
      );
    }
  }

  private findReviewUrl(
    published: Array<{
      rootComment: PlatformReviewComment;
    }>,
  ): string | null {
    for (const entry of published) {
      const comment = this.input.reviewComments.find(
        (candidate) => String(candidate.id) === entry.rootComment.id,
      );
      const review = this.input.reviews.find(
        (candidate) => candidate.id === comment?.pull_request_review_id,
      );
      if (review) {
        return review.html_url;
      }
    }
    return null;
  }
}

function getPermanentGitHubResolutionFailure(error: unknown): string | null {
  if (!(error instanceof GitHubApiError)) {
    return null;
  }

  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    if (current.message.includes("Resource not accessible by integration")) {
      return current.message;
    }
    current = current.cause;
  }
  return null;
}

export function renderGitHubFindingBody(
  finding: Pick<ReviewFinding, "title" | "body" | "anchor" | "suggestion">,
  options: {
    includeSuggestion: boolean;
    marker?: string | undefined;
  },
): string {
  let body = `**${finding.title.trim()}**\n\n${finding.body.trim()}`;
  if (options.includeSuggestion && finding.suggestion) {
    body += `\n\n\`\`\`suggestion\n${finding.suggestion.replacement
      .replace(/\r\n/g, "\n")
      .trimEnd()}\n\`\`\``;
  }
  return options.marker ? appendFindingMarker(body, options.marker) : body;
}

function canRenderSuggestion(
  finding: Pick<ReviewFinding, "anchor" | "suggestion">,
): boolean {
  return Boolean(
    finding.anchor &&
    finding.anchor.side === "new" &&
    finding.suggestion &&
    finding.anchor.startLine === finding.suggestion.startLine &&
    finding.anchor.endLine === finding.suggestion.endLine,
  );
}

function diffContainsRange(
  patch: string | undefined,
  anchor: ReviewAnchor,
): boolean {
  if (!patch) {
    return false;
  }
  const available = new Set<number>();
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (anchor.side === "new") {
        available.add(newLine);
      }
      newLine += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      if (anchor.side === "old") {
        available.add(oldLine);
      }
      oldLine += 1;
      continue;
    }
    if (!line.startsWith("\\")) {
      available.add(anchor.side === "new" ? newLine : oldLine);
      oldLine += 1;
      newLine += 1;
    }
  }
  for (let line = anchor.startLine; line <= anchor.endLine; line += 1) {
    if (!available.has(line)) {
      return false;
    }
  }
  return true;
}

function toPlatformReviewComment(
  comment: GitHubReviewComment,
  botLogin: string,
  resolved: boolean,
  resolvable: boolean,
): PlatformReviewComment {
  return {
    id: String(comment.id),
    body: comment.body,
    authorId: comment.user ? String(comment.user.id) : null,
    authorUsername: comment.user?.login ?? null,
    isBot: isGitHubBot(comment.user?.login ?? null, botLogin),
    resolvable,
    resolved,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    anchor: toReviewAnchor(comment),
    positionJson: JSON.stringify({
      path: comment.path,
      line: comment.line ?? null,
      originalLine: comment.original_line ?? null,
      side: comment.side ?? null,
      startLine: comment.start_line ?? null,
      originalStartLine: comment.original_start_line ?? null,
      startSide: comment.start_side ?? null,
      commitId: comment.commit_id,
      originalCommitId: comment.original_commit_id,
      diffHunk: comment.diff_hunk,
    }),
    url: comment.html_url,
  };
}

function toPlatformIssueComment(
  comment: GitHubIssueComment,
  botLogin: string,
): PlatformReviewComment {
  return {
    id: String(comment.id),
    body: comment.body ?? "",
    authorId: comment.user ? String(comment.user.id) : null,
    authorUsername: comment.user?.login ?? null,
    isBot: isGitHubBot(comment.user?.login ?? null, botLogin),
    resolvable: false,
    resolved: false,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    anchor: null,
    positionJson: JSON.stringify({ subjectType: "issue-comment" }),
    url: comment.html_url,
  };
}

function toPlatformSummaryComment(
  comment: GitHubIssueComment,
  botLogin: string,
): PlatformSummaryComment {
  return {
    id: String(comment.id),
    body: comment.body ?? "",
    isBot: isGitHubBot(comment.user?.login ?? null, botLogin),
    updatedAt: comment.updated_at,
    url: comment.html_url,
  };
}

function toReviewAnchor(comment: GitHubReviewComment): ReviewAnchor | null {
  const side = comment.side ?? comment.start_side;
  const endLine =
    side === "LEFT"
      ? (comment.original_line ?? comment.line)
      : (comment.line ?? comment.original_line);
  const startLine =
    side === "LEFT"
      ? (comment.original_start_line ?? comment.start_line ?? endLine)
      : (comment.start_line ?? comment.original_start_line ?? endLine);
  if (!side || !startLine || !endLine) {
    return null;
  }
  return {
    path: comment.path,
    startLine: Math.min(startLine, endLine),
    endLine: Math.max(startLine, endLine),
    side: side === "LEFT" ? "old" : "new",
  };
}

function appendFindingMarker(body: string, marker: string): string {
  return `${body.trim()}\n\n<!-- ${FINDING_MARKER_PREFIX}${marker} -->`;
}

function appendFindingReplyMarker(body: string, rootCommentId: number): string {
  return `${body.trim()}\n\n<!-- ${FINDING_REPLY_MARKER_PREFIX}${rootCommentId} -->`;
}

function withExistingFindingMarker(body: string, existingBody: string): string {
  const marker = extractFindingMarker(existingBody);
  return marker ? appendFindingMarker(body, marker) : body;
}

function extractFindingMarker(body: string): string | null {
  return FINDING_MARKER_PATTERN.exec(body)?.[1]?.trim() ?? null;
}

function extractFindingReplyRootId(body: string): number | null {
  const match = FINDING_REPLY_MARKER_PATTERN.exec(body);
  return match?.[1] ? Number(match[1]) : null;
}

function publicationMarker(publicationKey: string): string {
  return `<!-- ${PUBLICATION_MARKER_PREFIX}${publicationKey} -->`;
}

function issueDiscussionId(commentId: number): string {
  return `issue-comment:${commentId}`;
}

function reviewCommentDiscussionId(rootCommentId: number): string {
  return `review-comment:${rootCommentId}`;
}

function parseIssueDiscussionId(value: string): number | null {
  const match = /^issue-comment:(\d+)$/.exec(value);
  return match ? Number(match[1]) : null;
}

function isGitHubBot(login: string | null, botLogin: string): boolean {
  return login?.toLowerCase() === botLogin;
}

function canMutateReviewThreadResolution(thread: GitHubReviewThread): boolean {
  return isNativeReviewThreadId(thread.id);
}

function isNativeReviewThreadId(threadId: string): boolean {
  return threadId.startsWith("PRRT_");
}

async function sleep(durationMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

export function buildGitHubIssueCommentDiscussions(
  issueComments: GitHubIssueComment[],
  botLogin: string,
): PlatformReviewDiscussion[] {
  const roots = issueComments.filter(
    (comment) =>
      !isReviewSummaryNoteBody(comment.body ?? "") &&
      extractFindingMarker(comment.body ?? "") !== null,
  );
  const commentsByRootId = new Map(
    roots.map((root) => [root.id, [root] as GitHubIssueComment[]]),
  );
  for (const comment of issueComments) {
    const rootId = extractFindingReplyRootId(comment.body ?? "");
    const discussionComments =
      rootId === null ? undefined : commentsByRootId.get(rootId);
    if (
      discussionComments &&
      isGitHubBot(comment.user?.login ?? null, botLogin)
    ) {
      discussionComments.push(comment);
    }
  }
  return roots.map((root) => ({
    id: issueDiscussionId(root.id),
    comments: (commentsByRootId.get(root.id) ?? [root]).map((comment) =>
      toPlatformIssueComment(comment, botLogin),
    ),
    resolvable: false,
    resolved: false,
  }));
}

export function buildGitHubReviewCommentFallbackDiscussions(
  reviewComments: GitHubReviewComment[],
  reviewThreads: GitHubReviewThread[],
  botLogin: string,
): PlatformReviewDiscussion[] {
  const threadedCommentIds = new Set(
    reviewThreads.flatMap((thread) =>
      thread.comments.nodes.map((node) => node.databaseId),
    ),
  );
  const commentsById = new Map(
    reviewComments.map((comment) => [comment.id, comment] as const),
  );
  const commentsByRootId = new Map<number, GitHubReviewComment[]>();
  for (const comment of reviewComments) {
    const rootId = comment.in_reply_to_id ?? comment.id;
    const root = commentsById.get(rootId);
    if (
      !root ||
      threadedCommentIds.has(comment.id) ||
      threadedCommentIds.has(rootId) ||
      !isGitHubBot(root.user?.login ?? null, botLogin) ||
      extractFindingMarker(root.body) === null
    ) {
      continue;
    }
    const comments = commentsByRootId.get(rootId) ?? [];
    comments.push(comment);
    commentsByRootId.set(rootId, comments);
  }
  return [...commentsByRootId.entries()].map(([rootId, comments]) => ({
    id: reviewCommentDiscussionId(rootId),
    comments: comments
      .sort((left, right) => left.id - right.id)
      .map((comment) =>
        toPlatformReviewComment(comment, botLogin, false, false),
      ),
    resolvable: false,
    resolved: false,
  }));
}
