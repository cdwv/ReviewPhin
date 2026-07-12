import { describe, expect, it, vi } from "vitest";

import {
  buildGitHubCheckRunReviewTriggerContext,
  GitHubCheckRunTriggerLifecycle,
  GitHubCommentTriggerLifecycle,
} from "../src/platforms/github/trigger-lifecycle.js";
import type { InteractionJobRecord } from "../src/storage/contract/current.js";

describe("GitHub Check Run trigger lifecycle", () => {
  it("maps worker lifecycle states to Check Run updates", async () => {
    const updateCheckRun = vi.fn(async () => {});
    const lifecycle = new GitHubCheckRunTriggerLifecycle(
      { updateCheckRun } as never,
      {
        repositoryId: 2468,
        repositoryFullName: "octo-org/reviewphin",
      },
      createJob(),
    );

    await lifecycle.queued();
    await lifecycle.inProgress();
    await lifecycle.retry("temporary");
    await lifecycle.completed({
      summary: "Two findings were published.",
      links: [
        {
          label: "Review summary",
          url: "https://github.com/octo-org/reviewphin/pull/42#issuecomment-1",
        },
      ],
    });
    await lifecycle.failed("terminal");

    const calls = updateCheckRun.mock.calls as unknown as Array<
      [{ state: Record<string, unknown> }]
    >;
    expect(calls.map(([input]) => input.state)).toEqual([
      expect.objectContaining({ status: "queued" }),
      expect.objectContaining({ status: "in_progress" }),
      expect.objectContaining({
        status: "queued",
        summary: expect.stringContaining("temporary"),
      }),
      expect.objectContaining({
        status: "completed",
        conclusion: "success",
        summary: expect.stringContaining("Review summary"),
      }),
      expect.objectContaining({
        status: "completed",
        conclusion: "failure",
        summary: expect.stringContaining("terminal"),
      }),
    ]);
    expect(updateCheckRun).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: "octo-org/reviewphin",
        checkRunId: 1357,
      }),
    );
  });

  it("builds a manual review trigger from provider-owned job identity", () => {
    expect(buildGitHubCheckRunReviewTriggerContext(createJob())).toEqual({
      kind: "manual-review",
      provider: "github",
      source: "check-run-requested-action",
      instruction: null,
      metadata: {
        deliveryId: "delivery-1",
        checkRunId: 1357,
        actionIdentifier: "run_review",
        repositoryId: 2468,
      },
    });
  });

  it("rejects trigger identities for another repository", () => {
    expect(
      () =>
        new GitHubCheckRunTriggerLifecycle(
          { updateCheckRun: vi.fn() } as never,
          {
            repositoryId: 9999,
            repositoryFullName: "octo-org/other",
          },
          createJob(),
        ),
    ).toThrow("does not match tenant repository");
  });
});

describe("GitHub comment trigger lifecycle", () => {
  it("adds PR comment reactions as review jobs progress", async () => {
    const listIssueCommentReactions = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 1,
          content: "eyes",
          user: { id: 10, login: "reviewphin-octo[bot]", type: "Bot" },
          created_at: "2026-06-11T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const createIssueCommentReaction = vi.fn(async () => ({
      id: 2,
      content: "eyes",
      user: { id: 10, login: "reviewphin-octo[bot]", type: "Bot" },
      created_at: "2026-06-11T00:00:00.000Z",
    }));
    const lifecycle = new GitHubCommentTriggerLifecycle(
      { listIssueCommentReactions, createIssueCommentReaction } as never,
      {
        repositoryId: 2468,
        repositoryFullName: "octo-org/reviewphin",
      },
      createCommentJob("issue_comment"),
      "reviewphin-octo[bot]",
    );

    await lifecycle.queued();
    await lifecycle.inProgress();
    await lifecycle.completed();
    await lifecycle.failed();

    const reactionInputs = (
      createIssueCommentReaction.mock.calls as unknown as Array<[unknown]>
    ).map(([input]) => input);
    expect(reactionInputs).toEqual([
      expect.objectContaining({ commentId: 555, content: "eyes" }),
      expect.objectContaining({ commentId: 555, content: "hooray" }),
      expect.objectContaining({ commentId: 555, content: "confused" }),
    ]);
  });

  it("ignores reactions with missing users while deduping bot reactions", async () => {
    const listIssueCommentReactions = vi.fn(async () => [
      {
        id: 1,
        content: "eyes",
        user: null,
        created_at: "2026-06-11T00:00:00.000Z",
      },
    ]);
    const createIssueCommentReaction = vi.fn(async () => ({
      id: 2,
      content: "eyes",
      user: { id: 10, login: "reviewphin-octo[bot]", type: "Bot" },
      created_at: "2026-06-11T00:00:00.000Z",
    }));
    const lifecycle = new GitHubCommentTriggerLifecycle(
      { listIssueCommentReactions, createIssueCommentReaction } as never,
      {
        repositoryId: 2468,
        repositoryFullName: "octo-org/reviewphin",
      },
      createCommentJob("issue_comment"),
      "reviewphin-octo[bot]",
    );

    await lifecycle.queued();

    expect(createIssueCommentReaction).toHaveBeenCalledWith(
      expect.objectContaining({ commentId: 555, content: "eyes" }),
    );
  });

  it("skips inline review comment reactions like GitLab discussion comments", async () => {
    const listIssueCommentReactions = vi.fn();
    const createIssueCommentReaction = vi.fn();
    const lifecycle = new GitHubCommentTriggerLifecycle(
      { listIssueCommentReactions, createIssueCommentReaction } as never,
      {
        repositoryId: 2468,
        repositoryFullName: "octo-org/reviewphin",
      },
      createCommentJob("pull_request_review_comment"),
      "reviewphin-octo[bot]",
    );

    await lifecycle.queued();
    await lifecycle.completed();
    await lifecycle.failed();

    expect(listIssueCommentReactions).not.toHaveBeenCalled();
    expect(createIssueCommentReaction).not.toHaveBeenCalled();
  });
});

function createJob(): InteractionJobRecord {
  return {
    id: "job-github",
    availableAt: "2026-06-11T00:00:00.000Z",
    claimToken: null,
    claimedBy: null,
    claimExpiresAt: null,
    latestInteractionRunId: null,
    tenantId: "tenant-github",
    dedupeKey: "dedupe",
    codeReviewId: 42,
    commentId: null,
    triggerJson: JSON.stringify({
      kind: "github-check-run",
      deliveryId: "delivery-1",
      checkRunId: 1357,
      actionIdentifier: "run_review",
      repositoryId: 2468,
    }),
    headSha: "abc123",
    status: "queued",
    payloadJson: "{}",
    retryCount: 0,
    lastError: null,
    enqueuedAt: "2026-06-11T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
  };
}

function createCommentJob(
  eventName: "issue_comment" | "pull_request_review_comment",
): InteractionJobRecord {
  return {
    id: "job-github-comment",
    availableAt: "2026-06-11T00:00:00.000Z",
    claimToken: null,
    claimedBy: null,
    claimExpiresAt: null,
    latestInteractionRunId: null,
    tenantId: "tenant-github",
    dedupeKey: "dedupe-comment",
    codeReviewId: 42,
    commentId: 555,
    triggerJson: JSON.stringify({
      kind: "github-comment",
      deliveryId: "delivery-comment",
      eventName,
      triggerKind: "direct-mention",
      commentId: 555,
      repositoryId: 2468,
      pullRequestNumber: 42,
      authorUsername: "octocat",
      body: "/reviewphin review",
      instruction: "review",
    }),
    headSha: "abc123",
    status: "queued",
    payloadJson: "{}",
    retryCount: 0,
    lastError: null,
    enqueuedAt: "2026-06-11T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
  };
}
