import { describe, expect, it, vi } from "vitest";

import {
  GitHubApiError,
  type GitHubPendingReviewComment,
  type GitHubIssueComment,
  type GitHubPullRequestReview,
  type GitHubReviewComment,
  type GitHubReviewThread,
} from "../src/platforms/github/client.js";
import { GitHubReviewPublicationAdapter } from "../src/platforms/github/review-publication-adapter.js";

describe("GitHubReviewPublicationAdapter", () => {
  it("publishes applyable suggestions in one COMMENT review and falls back to issue comments", async () => {
    const state = createState();
    const adapter = createAdapter(state);

    const result = await adapter.publishFindings({
      publicationKey: "job-1",
      existingDiscussionIds: new Set(),
      findings: [
        {
          identityKey: "inline",
          fingerprint: "inline-fingerprint",
          marker: "github:job-1:inline",
          finding: {
            title: "Return the computed value",
            body: "The current branch drops the result.",
            severity: "high",
            category: "bug",
            anchor: {
              path: "src/index.ts",
              startLine: 2,
              endLine: 2,
              side: "new",
            },
            suggestion: {
              startLine: 2,
              endLine: 2,
              replacement: "return value;",
            },
          },
        },
        {
          identityKey: "overview",
          fingerprint: "overview-fingerprint",
          marker: "github:job-1:overview",
          finding: {
            title: "Document the behavior",
            body: "The public behavior is not documented.",
            severity: "low",
            category: "maintainability",
          },
        },
      ],
    });

    expect(state.client.createPullRequestReview).toHaveBeenCalledOnce();
    expect(state.client.createPullRequestReview).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "<!-- reviewphin-publication:job-1 -->",
        comments: [
          expect.objectContaining({
            path: "src/index.ts",
            line: 2,
            side: "RIGHT",
            body: expect.stringContaining("```suggestion\nreturn value;\n```"),
          }),
        ],
      }),
    );
    expect(
      state.client.createPullRequestReview.mock.calls[0]?.[0].comments[0]?.body,
    ).not.toContain("suggestion:-");
    expect(
      state.client.createPullRequestReview.mock.calls[0]?.[0].comments[0],
    ).not.toHaveProperty("subjectType");
    expect(state.client.submitPullRequestReview).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: 500 }),
    );
    expect(state.client.createIssueComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(
          "<!-- reviewphin-finding:github:job-1:overview -->",
        ),
      }),
    );
    expect(result.findings).toHaveLength(2);
    expect(result.links).toContainEqual({
      label: "GitHub review",
      url: "https://github.com/octo/repo/pull/7#pullrequestreview-500",
    });
  });

  it("recovers submitted review comments while review threads are delayed", async () => {
    vi.useFakeTimers();
    try {
      const state = createState();
      let reviewThreadReads = 0;
      state.client.listReviewThreads.mockImplementation(async () => {
        reviewThreadReads += 1;
        return reviewThreadReads < 3 ? [] : state.reviewThreads;
      });
      const adapter = createAdapter(state);

      const publication = adapter.publishFindings({
        publicationKey: "job-delayed-thread",
        existingDiscussionIds: new Set(),
        findings: [
          {
            identityKey: "inline",
            fingerprint: "inline-fingerprint",
            marker: "github:job-delayed-thread:inline",
            finding: {
              title: "Return the computed value",
              body: "The current branch drops the result.",
              severity: "high",
              category: "bug",
              anchor: {
                path: "src/index.ts",
                startLine: 2,
                endLine: 2,
                side: "new",
              },
            },
          },
        ],
      });

      await vi.runAllTimersAsync();

      const result = await publication;
      expect(result.findings).toEqual([
        expect.objectContaining({
          identityKey: "inline",
          discussion: expect.objectContaining({
            id: "review-comment:600",
          }),
        }),
      ]);
      expect(reviewThreadReads).toBe(2);
      expect(state.client.createPullRequestReview).toHaveBeenCalledOnce();
      expect(state.client.submitPullRequestReview).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the exact new-side range for multi-line suggestions", async () => {
    const state = createState();
    const adapter = createAdapter(state);

    await adapter.publishFindings({
      publicationKey: "job-multiline",
      existingDiscussionIds: new Set(),
      findings: [
        {
          identityKey: "multiline",
          fingerprint: "multiline-fingerprint",
          marker: "github:job-multiline:multiline",
          finding: {
            title: "Return the computed value",
            body: "The replacement spans both changed lines.",
            severity: "high",
            category: "bug",
            anchor: {
              path: "src/index.ts",
              startLine: 2,
              endLine: 3,
              side: "new",
            },
            suggestion: {
              startLine: 2,
              endLine: 3,
              replacement: "const result = compute();\nreturn result;",
            },
          },
        },
      ],
    });

    expect(state.client.createPullRequestReview).toHaveBeenCalledWith(
      expect.objectContaining({
        comments: [
          expect.objectContaining({
            path: "src/index.ts",
            line: 3,
            side: "RIGHT",
            startLine: 2,
            startSide: "RIGHT",
            body: expect.stringContaining(
              "```suggestion\nconst result = compute();\nreturn result;\n```",
            ),
          }),
        ],
      }),
    );
  });

  it("falls back to marked issue comments for old-side and invalid anchors", async () => {
    const state = createState();
    const adapter = createAdapter(state);

    await adapter.publishFindings({
      publicationKey: "job-fallback",
      existingDiscussionIds: new Set(),
      findings: [
        {
          identityKey: "old-side",
          fingerprint: "old-side-fingerprint",
          marker: "github:job-fallback:old-side",
          finding: {
            title: "Old-side finding",
            body: "This line exists only on the old side.",
            severity: "medium",
            category: "bug",
            anchor: {
              path: "src/index.ts",
              startLine: 1,
              endLine: 1,
              side: "old",
            },
            suggestion: {
              startLine: 1,
              endLine: 1,
              replacement: "const value = computeSafely();",
            },
          },
        },
        {
          identityKey: "invalid-range",
          fingerprint: "invalid-range-fingerprint",
          marker: "github:job-fallback:invalid-range",
          finding: {
            title: "Invalid range",
            body: "This line is outside the visible patch.",
            severity: "low",
            category: "maintainability",
            anchor: {
              path: "src/index.ts",
              startLine: 99,
              endLine: 99,
              side: "new",
            },
          },
        },
      ],
    });

    expect(state.client.createPullRequestReview).not.toHaveBeenCalled();
    expect(state.client.submitPullRequestReview).not.toHaveBeenCalled();
    expect(state.client.createIssueComment).toHaveBeenCalledTimes(2);
    for (const call of state.client.createIssueComment.mock.calls) {
      expect(call[0].body).toContain("<!-- reviewphin-finding:");
      expect(call[0].body).not.toContain("```suggestion");
    }
  });

  it("continues fallback findings with linked issue comments", async () => {
    const state = createState();
    const adapter = createAdapter(state);
    const published = await adapter.publishFindings({
      publicationKey: "job-fallback-reply",
      existingDiscussionIds: new Set(),
      findings: [
        {
          identityKey: "overview",
          fingerprint: "overview-fingerprint",
          marker: "github:job-fallback-reply:overview",
          finding: {
            title: "Document the behavior",
            body: "The public behavior is not documented.",
            severity: "low",
            category: "maintainability",
          },
        },
      ],
    });
    const discussionId = published.findings[0]!.discussion.id;

    await adapter.mutateDiscussion({
      kind: "reply-text",
      discussionId,
      body: "The follow-up review still needs this documentation.",
    });
    await adapter.mutateDiscussion({
      kind: "reply-finding",
      discussionId,
      finding: {
        title: "Clarify the edge case",
        body: "Document what happens when the input is empty.",
        severity: "low",
        category: "maintainability",
      },
    });

    expect(state.client.createIssueComment).toHaveBeenCalledTimes(3);
    expect(state.client.createIssueComment.mock.calls[1]?.[0].body).toContain(
      "<!-- reviewphin-finding-reply:700 -->",
    );
    expect(state.client.createIssueComment.mock.calls[2]?.[0].body).toContain(
      "**Clarify the edge case**",
    );
    const discussions = await adapter.loadDiscussions({ fresh: true });
    expect(discussions).toContainEqual(
      expect.objectContaining({
        id: discussionId,
        comments: expect.arrayContaining([
          expect.objectContaining({ id: "700" }),
          expect.objectContaining({ id: "701" }),
          expect.objectContaining({ id: "702" }),
        ]),
      }),
    );
  });

  it("synthesizes review-comment discussions while GitHub review threads are delayed", async () => {
    const state = createState();
    const adapter = createAdapter(state);
    state.reviewComments.push(
      {
        id: 600,
        body: [
          "**Delayed inline finding**",
          "",
          "The GraphQL thread is not visible yet.",
          "",
          "<!-- reviewphin-finding:github:job-delayed:inline -->",
        ].join("\n"),
        html_url: "https://github.com/octo/repo/pull/7#discussion_r600",
        user: { id: 1, login: "reviewphin[bot]", type: "Bot" },
        path: "src/index.ts",
        diff_hunk: "@@ -1,1 +1,2 @@",
        pull_request_review_id: 500,
        line: 2,
        side: "RIGHT",
        commit_id: "head-sha",
        original_commit_id: "head-sha",
        created_at: "2026-06-14T00:00:00.000Z",
        updated_at: "2026-06-14T00:00:00.000Z",
      },
      {
        id: 601,
        body: "Can you expand on this?",
        html_url: "https://github.com/octo/repo/pull/7#discussion_r601",
        user: { id: 2, login: "octocat", type: "User" },
        path: "src/index.ts",
        diff_hunk: "@@ -1,1 +1,2 @@",
        pull_request_review_id: 501,
        in_reply_to_id: 600,
        line: 2,
        side: "RIGHT",
        commit_id: "head-sha",
        original_commit_id: "head-sha",
        created_at: "2026-06-14T00:01:00.000Z",
        updated_at: "2026-06-14T00:01:00.000Z",
      },
    );
    state.client.replyToReviewComment.mockImplementation(
      async ({ commentId, body }) => ({
        id: 602,
        body,
        html_url: "https://github.com/octo/repo/pull/7#discussion_r602",
        user: { id: 1, login: "reviewphin[bot]", type: "Bot" },
        path: "src/index.ts",
        diff_hunk: "@@ -1,1 +1,2 @@",
        pull_request_review_id: 502,
        in_reply_to_id: commentId,
        line: 2,
        side: "RIGHT",
        commit_id: "head-sha",
        original_commit_id: "head-sha",
        created_at: "2026-06-14T00:02:00.000Z",
        updated_at: "2026-06-14T00:02:00.000Z",
      }),
    );

    const discussions = await adapter.loadDiscussions({ fresh: true });

    expect(discussions).toContainEqual(
      expect.objectContaining({
        id: "review-comment:600",
        resolvable: false,
        comments: [
          expect.objectContaining({ id: "600", isBot: true }),
          expect.objectContaining({ id: "601", isBot: false }),
        ],
      }),
    );

    await adapter.mutateDiscussion({
      kind: "reply-text",
      discussionId: "review-comment:600",
      body: "Expanded explanation.",
    });

    expect(state.client.replyToReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({
        commentId: 600,
        body: "Expanded explanation.",
      }),
    );
  });

  it("recovers a submitted publication without creating duplicate comments", async () => {
    const state = createState();
    const adapter = createAdapter(state);
    const publications = [
      {
        identityKey: "inline",
        fingerprint: "inline-fingerprint",
        marker: "github:job-1:inline",
        finding: {
          title: "Return the computed value",
          body: "The current branch drops the result.",
          severity: "high" as const,
          category: "bug" as const,
          anchor: {
            path: "src/index.ts",
            startLine: 2,
            endLine: 2,
            side: "new" as const,
          },
        },
      },
      {
        identityKey: "overview",
        fingerprint: "overview-fingerprint",
        marker: "github:job-1:overview",
        finding: {
          title: "Document the behavior",
          body: "The public behavior is not documented.",
          severity: "low" as const,
          category: "maintainability" as const,
        },
      },
    ];

    await adapter.publishFindings({
      publicationKey: "job-1",
      existingDiscussionIds: new Set(),
      findings: publications,
    });
    state.client.createPullRequestReview.mockClear();
    state.client.submitPullRequestReview.mockClear();
    state.client.createIssueComment.mockClear();

    const recovered = await adapter.publishFindings({
      publicationKey: "job-1",
      existingDiscussionIds: new Set(),
      findings: publications,
    });

    expect(recovered.findings).toHaveLength(2);
    expect(state.client.createPullRequestReview).not.toHaveBeenCalled();
    expect(state.client.submitPullRequestReview).not.toHaveBeenCalled();
    expect(state.client.createIssueComment).not.toHaveBeenCalled();
  });

  it("recovers an already submitted marked review by stable finding markers", async () => {
    const state = createState();
    state.reviews.push({
      id: 900,
      body: "<!-- reviewphin-publication:job-recovered -->",
      html_url: "https://github.com/octo/repo/pull/7#pullrequestreview-900",
      user: { id: 1, login: "reviewphin[bot]", type: "Bot" },
      state: "COMMENTED",
      commit_id: "head-sha",
      submitted_at: "2026-06-14T00:01:00.000Z",
    });
    state.reviewComments.push({
      id: 901,
      body: [
        "**Recovered finding**",
        "",
        "Already published.",
        "",
        "<!-- reviewphin-finding:github:job-recovered:inline -->",
      ].join("\n"),
      html_url: "https://github.com/octo/repo/pull/7#discussion_r901",
      user: { id: 1, login: "reviewphin[bot]", type: "Bot" },
      path: "src/index.ts",
      diff_hunk: "@@ -1,1 +1,3 @@",
      pull_request_review_id: 900,
      line: 2,
      side: "RIGHT",
      commit_id: "head-sha",
      original_commit_id: "head-sha",
      created_at: "2026-06-14T00:00:00.000Z",
      updated_at: "2026-06-14T00:00:00.000Z",
    });
    state.reviewThreads.push({
      id: "PRRT_901",
      isResolved: false,
      isOutdated: false,
      viewerCanResolve: true,
      viewerCanUnresolve: false,
      comments: {
        nodes: [{ id: "PRRC_901", databaseId: 901 }],
      },
    });
    const adapter = createAdapter(state);

    const recovered = await adapter.publishFindings({
      publicationKey: "job-recovered",
      existingDiscussionIds: new Set(),
      findings: [
        {
          identityKey: "inline",
          fingerprint: "inline-fingerprint",
          marker: "github:job-recovered:inline",
          finding: {
            title: "Recovered finding",
            body: "Already published.",
            severity: "high",
            category: "bug",
            anchor: {
              path: "src/index.ts",
              startLine: 2,
              endLine: 2,
              side: "new",
            },
          },
        },
      ],
    });

    expect(state.client.createPullRequestReview).not.toHaveBeenCalled();
    expect(state.client.submitPullRequestReview).not.toHaveBeenCalled();
    expect(state.client.createIssueComment).not.toHaveBeenCalled();
    expect(recovered.links).toContainEqual({
      label: "GitHub review",
      url: "https://github.com/octo/repo/pull/7#pullrequestreview-900",
    });
  });

  it("resolves only ReviewPhin-owned GraphQL threads", async () => {
    const state = createState();
    const adapter = createAdapter(state);
    await adapter.publishFindings({
      publicationKey: "job-1",
      existingDiscussionIds: new Set(),
      findings: [
        {
          identityKey: "inline",
          fingerprint: "inline-fingerprint",
          marker: "github:job-1:inline",
          finding: {
            title: "Return the computed value",
            body: "The current branch drops the result.",
            severity: "high",
            category: "bug",
            anchor: {
              path: "src/index.ts",
              startLine: 2,
              endLine: 2,
              side: "new",
            },
          },
        },
      ],
    });

    await adapter.mutateDiscussion({
      kind: "set-resolved",
      discussionId: "PRRT_600",
      resolved: true,
    });

    expect(state.client.setReviewThreadResolved).toHaveBeenCalledWith(
      "PRRT_600",
      true,
    );
  });

  it("resolves ReviewPhin-owned outdated GraphQL threads when GitHub permits it", async () => {
    const state = createState();
    const adapter = createAdapter(state);
    await adapter.publishFindings({
      publicationKey: "job-1",
      existingDiscussionIds: new Set(),
      findings: [
        {
          identityKey: "inline",
          fingerprint: "inline-fingerprint",
          marker: "github:job-1:inline",
          finding: {
            title: "Return the computed value",
            body: "The current branch drops the result.",
            severity: "high",
            category: "bug",
            anchor: {
              path: "src/index.ts",
              startLine: 2,
              endLine: 2,
              side: "new",
            },
          },
        },
      ],
    });
    state.reviewThreads[0]!.isOutdated = true;
    state.reviewThreads[0]!.viewerCanResolve = true;

    const discussions = await adapter.loadDiscussions({ fresh: true });
    expect(discussions[0]).toMatchObject({
      id: "PRRT_600",
      resolvable: true,
    });

    await adapter.mutateDiscussion({
      kind: "set-resolved",
      discussionId: "PRRT_600",
      resolved: true,
    });

    expect(state.client.setReviewThreadResolved).toHaveBeenCalledWith(
      "PRRT_600",
      true,
    );
  });

  it("keeps bot-owned GraphQL review threads resolvable even when capability flags are false", async () => {
    const state = createState();
    const adapter = createAdapter(state);
    await adapter.publishFindings({
      publicationKey: "job-1",
      existingDiscussionIds: new Set(),
      findings: [
        {
          identityKey: "inline",
          fingerprint: "inline-fingerprint",
          marker: "github:job-1:inline",
          finding: {
            title: "Return the computed value",
            body: "The current branch drops the result.",
            severity: "high",
            category: "bug",
            anchor: {
              path: "src/index.ts",
              startLine: 2,
              endLine: 2,
              side: "new",
            },
          },
        },
      ],
    });
    state.reviewThreads[0]!.viewerCanResolve = false;
    state.reviewThreads[0]!.viewerCanUnresolve = false;

    await expect(adapter.loadDiscussions({ fresh: true })).resolves.toEqual([
      expect.objectContaining({
        id: "PRRT_600",
        resolvable: true,
      }),
    ]);

    await adapter.mutateDiscussion({
      kind: "set-resolved",
      discussionId: "PRRT_600",
      resolved: true,
    });

    expect(state.client.setReviewThreadResolved).toHaveBeenCalledWith(
      "PRRT_600",
      true,
    );
  });

  it("reports skipped resolution when GitHub rejects a native review thread mutation", async () => {
    const state = createState();
    const adapter = createAdapter(state);
    await adapter.publishFindings({
      publicationKey: "job-1",
      existingDiscussionIds: new Set(),
      findings: [
        {
          identityKey: "inline",
          fingerprint: "inline-fingerprint",
          marker: "github:job-1:inline",
          finding: {
            title: "Return the computed value",
            body: "The current branch drops the result.",
            severity: "high",
            category: "bug",
            anchor: {
              path: "src/index.ts",
              startLine: 2,
              endLine: 2,
              side: "new",
            },
          },
        },
      ],
    });
    state.client.setReviewThreadResolved.mockRejectedValueOnce(
      new GitHubApiError("GitHub review thread PRRT_600 request failed", null, {
        cause: new Error("Resource not accessible by integration"),
      }),
    );

    await expect(
      adapter.mutateDiscussion({
        kind: "set-resolved",
        discussionId: "PRRT_600",
        resolved: true,
      }),
    ).resolves.toEqual({
      skipped: true,
      skipReason: "Resource not accessible by integration",
    });
    expect(state.client.setReviewThreadResolved).toHaveBeenCalledWith(
      "PRRT_600",
      true,
    );
  });

  it.each([
    [
      "rate limit",
      new GitHubApiError(
        "GitHub review thread PRRT_600 request failed with status 429",
        429,
      ),
    ],
    [
      "server failure",
      new GitHubApiError(
        "GitHub review thread PRRT_600 request failed with status 500",
        500,
      ),
    ],
    [
      "network failure",
      new GitHubApiError("GitHub review thread PRRT_600 request failed", null, {
        cause: new TypeError("fetch failed"),
      }),
    ],
  ])("propagates transient GitHub %s errors", async (_label, error) => {
    const state = createState();
    const adapter = createAdapter(state);
    await adapter.publishFindings({
      publicationKey: "job-transient-resolution",
      existingDiscussionIds: new Set(),
      findings: [
        {
          identityKey: "inline",
          fingerprint: "inline-fingerprint",
          marker: "github:job-transient-resolution:inline",
          finding: {
            title: "Return the computed value",
            body: "The current branch drops the result.",
            severity: "high",
            category: "bug",
            anchor: {
              path: "src/index.ts",
              startLine: 2,
              endLine: 2,
              side: "new",
            },
          },
        },
      ],
    });
    state.client.setReviewThreadResolved.mockRejectedValueOnce(error);

    await expect(
      adapter.mutateDiscussion({
        kind: "set-resolved",
        discussionId: "PRRT_600",
        resolved: true,
      }),
    ).rejects.toBe(error);
  });

  it("creates then updates the marked summary issue comment", async () => {
    const state = createState();
    const adapter = createAdapter(state);

    const created = await adapter.upsertSummary({
      body: "<!-- reviewphin-review-summary -->\nSummary one",
    });
    const updated = await adapter.upsertSummary({
      body: "<!-- reviewphin-review-summary -->\nSummary two",
    });

    expect(created.action).toBe("created");
    expect(updated.action).toBe("updated");
    expect(state.client.createIssueComment).toHaveBeenCalledOnce();
    expect(state.client.updateIssueComment).toHaveBeenCalledOnce();
  });
});

function createAdapter(state: ReturnType<typeof createState>) {
  return new GitHubReviewPublicationAdapter({
    client: state.client as never,
    repositoryFullName: "octo/repo",
    pullRequestNumber: 7,
    headSha: "head-sha",
    files: [
      {
        sha: "blob",
        filename: "src/index.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        blob_url: "https://github.com/octo/repo/blob/head/src/index.ts",
        raw_url: "https://github.com/octo/repo/raw/head/src/index.ts",
        contents_url:
          "https://api.github.com/repos/octo/repo/contents/src/index.ts",
        patch:
          "@@ -1,1 +1,3 @@\n const value = compute();\n+value;\n+consume(value);",
      },
    ],
    issueComments: state.issueComments,
    reviews: state.reviews,
    reviewComments: state.reviewComments,
    reviewThreads: state.reviewThreads,
    botLogin: "reviewphin[bot]",
  });
}

function createState() {
  const issueComments: GitHubIssueComment[] = [];
  const reviews: GitHubPullRequestReview[] = [];
  const reviewComments: GitHubReviewComment[] = [];
  const reviewThreads: GitHubReviewThread[] = [];
  let nextIssueCommentId = 700;

  const client = {
    listIssueComments: vi.fn(async () => issueComments),
    listPullRequestReviews: vi.fn(async () => reviews),
    listReviewComments: vi.fn(async () => reviewComments),
    listReviewThreads: vi.fn(async () => reviewThreads),
    createPullRequestReview: vi.fn(async (input) => {
      const review: GitHubPullRequestReview = {
        id: 500,
        body: input.body,
        html_url: "https://github.com/octo/repo/pull/7#pullrequestreview-500",
        user: { id: 1, login: "reviewphin[bot]", type: "Bot" },
        state: "PENDING",
        commit_id: input.commitId,
        submitted_at: null,
      };
      reviews.push(review);
      input.comments.forEach(
        (comment: GitHubPendingReviewComment, index: number) => {
          reviewComments.push({
            id: 600 + index,
            body: comment.body,
            html_url: `https://github.com/octo/repo/pull/7#discussion_r${600 + index}`,
            user: { id: 1, login: "reviewphin[bot]", type: "Bot" },
            path: comment.path,
            diff_hunk: "@@ -1,1 +1,2 @@",
            pull_request_review_id: review.id,
            line: comment.line ?? null,
            side: comment.side ?? null,
            start_line: comment.startLine ?? null,
            start_side: comment.startSide ?? null,
            commit_id: "head-sha",
            original_commit_id: "head-sha",
            created_at: "2026-06-14T00:00:00.000Z",
            updated_at: "2026-06-14T00:00:00.000Z",
          });
        },
      );
      return review;
    }),
    submitPullRequestReview: vi.fn(async ({ reviewId }) => {
      const review = reviews.find((entry) => entry.id === reviewId)!;
      review.state = "COMMENTED";
      review.submitted_at = "2026-06-14T00:01:00.000Z";
      const comments = reviewComments.filter(
        (entry) => entry.pull_request_review_id === reviewId,
      );
      reviewThreads.push(
        ...comments.map((comment, index) => ({
          id: `PRRT_${600 + index}`,
          isResolved: false,
          isOutdated: false,
          viewerCanResolve: true,
          viewerCanUnresolve: false,
          comments: {
            nodes: [
              {
                id: `PRRC_${comment.id}`,
                databaseId: comment.id,
              },
            ],
          },
        })),
      );
      return review;
    }),
    deletePendingPullRequestReview: vi.fn(async () => undefined),
    createIssueComment: vi.fn(async ({ body }) => {
      const id = nextIssueCommentId++;
      const comment: GitHubIssueComment = {
        id,
        body,
        html_url: `https://github.com/octo/repo/pull/7#issuecomment-${id}`,
        user: { id: 1, login: "reviewphin[bot]", type: "Bot" },
        created_at: "2026-06-14T00:00:00.000Z",
        updated_at: "2026-06-14T00:00:00.000Z",
      };
      issueComments.push(comment);
      return comment;
    }),
    updateIssueComment: vi.fn(async ({ commentId, body }) => {
      const comment = issueComments.find((entry) => entry.id === commentId)!;
      comment.body = body;
      comment.updated_at = "2026-06-14T00:02:00.000Z";
      return comment;
    }),
    updateReviewComment: vi.fn(),
    replyToReviewComment: vi.fn(),
    setReviewThreadResolved: vi.fn(async () => undefined),
  };
  return { client, issueComments, reviews, reviewComments, reviewThreads };
}
