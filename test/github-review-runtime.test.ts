import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitHubPlatformReviewRuntime } from "../src/platforms/github/review-runtime.js";
import GitHubPlatform from "../src/platforms/github/platform.js";
import {
  createDisabledProjectMemoryBackend,
  type ProjectMemoryBackend,
} from "../src/memory/backend.js";
import type { GitHubClient } from "../src/platforms/github/client.js";
import type {
  DiscussionMappingRecord,
  InteractionJobRecord,
  PlatformConnectionRecord,
  TenantRecord,
} from "../src/storage/contract/current.js";
import type { StorageHelpers } from "../src/storage/storage-helpers.js";
import { createLogger } from "../src/logger.js";

const tempRoots: string[] = [];

describe("GitHubPlatformReviewRuntime", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("is constructed through the GitHub platform boundary", () => {
    const platform = new GitHubPlatform({
      logger: createLogger("silent"),
      publicUrl: "https://review.example.com",
      createApp: () => ({
        octokit: { request: vi.fn() },
        getInstallationOctokit: vi.fn(),
      }),
    });
    const runtime = platform.createReviewRuntime({
      storage: {} as StorageHelpers,
      logger: createLogger("silent"),
      resolvedTenant: {
        tenant: createTenant("octo-org/reviewphin"),
        connection: createConnection(),
      },
      interactionJobId: "job-github",
      workspaceRoot: "tmp",
      memoryEnabled: false,
    });

    expect(runtime).toBeInstanceOf(GitHubPlatformReviewRuntime);
  });

  it("hydrates pull request context through the canonical repository id", async () => {
    const workspaceRoot = await createTempRoot();
    const archive = await createRepositoryArchive();
    const tenant = createTenant("old-owner/old-name");
    const patch = vi.fn(async () => undefined);
    const createCodeReviewSnapshot = vi.fn(async (input) => ({
      id: "snapshot-github",
      ...input,
      createdAt: "2026-06-11T00:00:00.000Z",
    }));
    const client = createClient({
      archive,
      threadResolved: true,
      threadOutdated: true,
      resolveRepositoryById: vi.fn(async () => ({
        id: 2468,
        name: "reviewphin",
        fullName: "octo-org/reviewphin",
        private: true,
        htmlUrl: "https://github.com/octo-org/reviewphin",
        ownerLogin: "octo-org",
        ownerId: 456,
        ownerType: "Organization",
      })),
    });
    const runtime = createRuntime({
      workspaceRoot,
      tenant,
      client,
      patch,
      createCodeReviewSnapshot,
      projectMemoryBackend: {
        getCapability: async () => ({
          implemented: true,
          available: true,
        }),
        load: async () => ({
          enabled: true,
          page: {
            title: "Reviewphin memory",
            slug: "reviewphin-memory",
            format: "markdown",
            content:
              "## Remembered project knowledge\n- Use provider-owned memory.",
          },
          entries: [{ text: "Use provider-owned memory." }],
        }),
        saveEntries: async () => {
          throw new Error("not used");
        },
      },
    });
    const job = createJob();

    const routing = await runtime.loadRoutingContext(job);
    expect(routing).toMatchObject({
      codeReviewId: 42,
      changedFileCount: 2,
      commentCount: 2,
      discussionCount: 1,
      projectMemory: {
        enabled: true,
        entries: [{ text: "Use provider-owned memory." }],
      },
      summaryContext: {
        codeReview: {
          id: 42,
          title: "Add GitHub review runtime",
          sourceBranch: "feature/github-runtime",
          targetBranch: "main",
        },
        changes: [
          {
            oldPath: "src/runtime.ts",
            newPath: "src/runtime.ts",
            newFile: false,
            renamedFile: false,
            deletedFile: false,
          },
          {
            oldPath: "old-name.ts",
            newPath: "new-name.ts",
            renamedFile: true,
          },
        ],
      },
    });
    expect(patch).toHaveBeenCalledWith({
      id: tenant.id,
      value: {
        platformConfigJson: JSON.stringify({
          repositoryId: 2468,
          repositoryFullName: "octo-org/reviewphin",
        }),
        updatedAt: expect.any(String),
      },
    });
    expect(client.getPullRequest).toHaveBeenCalledWith(
      "octo-org/reviewphin",
      42,
    );
    expect(client.downloadRepositoryArchive).toHaveBeenCalledWith(
      "octo-org/reviewphin",
      "head-sha",
    );
    expect(
      await readFile(
        join(routing.workspace.rootPath, ".github", "copilot-instructions.md"),
        "utf8",
      ),
    ).toBe("Use repository instructions.\n");

    const hydrated = await runtime.hydrate({ job, context: routing });
    expect(createCodeReviewSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        interactionJobId: job.id,
        tenantId: tenant.id,
        codeReviewId: 42,
        headSha: "head-sha",
        instructionsJson: "[]",
        workspaceStrategy: "archive",
        projectMemoryJson: JSON.stringify({
          enabled: true,
          page: {
            title: "Reviewphin memory",
            slug: "reviewphin-memory",
            format: "markdown",
            content:
              "## Remembered project knowledge\n- Use provider-owned memory.",
          },
          entries: [{ text: "Use provider-owned memory." }],
        }),
      }),
    );
    expect(
      (
        hydrated.platformContext as {
          snapshot: { id: string };
        }
      ).snapshot.id,
    ).toBe("snapshot-github");

    const priorDiscussions = runtime.buildProviderDiscussions({
      context: hydrated,
      mappings: [],
    });
    expect(priorDiscussions).toEqual([
      expect.objectContaining({
        platformDiscussionId: "PRRT_thread_300",
        platformCommentId: 300,
        title: "Finding body",
        anchor: {
          path: "src/runtime.ts",
          startLine: 12,
          endLine: 12,
          side: "new",
        },
        resolvable: true,
        resolved: true,
        humanReplies: [
          {
            platformCommentId: 301,
            authorUsername: "reviewer",
            body: "Reply",
          },
        ],
      }),
    ]);

    const trigger = runtime.buildReviewTriggerContext({
      job,
      payload: {},
      context: hydrated,
      priorDiscussions,
      mappings: [],
    });
    expect(trigger).toEqual({
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

    const commentTrigger = runtime.buildReviewTriggerContext({
      job: {
        ...job,
        commentId: 100,
        triggerJson: JSON.stringify({
          kind: "github-comment",
          deliveryId: "delivery-comment",
          eventName: "issue_comment",
          triggerKind: "direct-mention",
          commentId: 100,
          repositoryId: 2468,
          pullRequestNumber: 42,
          authorUsername: "octocat",
          body: "/reviewphin review",
          instruction: "review",
        }),
      },
      payload: {},
      context: hydrated,
      priorDiscussions,
      mappings: [],
    });
    expect(commentTrigger).toMatchObject({
      kind: "direct-mention",
      commentId: 100,
      instruction: "review",
      responseTarget: {
        kind: "code-review-comment",
        commentId: 100,
      },
    });

    const followUpTrigger = runtime.buildReviewTriggerContext({
      job: {
        ...job,
        commentId: 301,
        triggerJson: JSON.stringify({
          kind: "github-comment",
          deliveryId: "delivery-follow-up",
          eventName: "pull_request_review_comment",
          triggerKind: "follow-up-comment",
          commentId: 301,
          repositoryId: 2468,
          pullRequestNumber: 42,
          authorUsername: "reviewer",
          body: "Can you explain?",
          instruction: "Can you explain?",
        }),
      },
      payload: {},
      context: hydrated,
      priorDiscussions,
      mappings: [],
    });
    expect(followUpTrigger).toMatchObject({
      kind: "follow-up-comment",
      commentId: 301,
      targetPlatformDiscussionId: "PRRT_thread_300",
      responseTarget: {
        kind: "finding-discussion-reply",
        discussionId: "PRRT_thread_300",
        commentId: 301,
      },
    });

    const followUpMapping = createDiscussionMapping();
    vi.mocked(client.listReviewThreads).mockResolvedValueOnce([]);
    const routingWithoutThread = await runtime.loadRoutingContext(job);
    const priorDiscussionsWithoutThread = runtime.buildProviderDiscussions({
      context: routingWithoutThread,
      mappings: [followUpMapping],
    });
    expect(priorDiscussionsWithoutThread).toEqual([
      expect.objectContaining({
        discussionId: "mapping-github",
        platformDiscussionId: "review-comment:300",
        platformCommentId: 300,
        title: "Finding body",
        resolvable: false,
        resolved: false,
        humanReplies: [
          {
            platformCommentId: 301,
            authorUsername: "reviewer",
            body: "Reply",
          },
        ],
      }),
    ]);
    const freshDelayedPromptContext = runtime.buildPromptContext({
      attachments: [],
      attachmentIssues: [],
      interactionRunId: "run-github-delayed-fresh",
      tenant,
      job,
      runArtifacts: {
        runDirectory: join(workspaceRoot, "run-github-delayed-fresh"),
      } as never,
      trigger,
      context: routingWithoutThread,
      mappings: [followUpMapping],
      priorFindings: [],
      previousInteraction: null,
    });
    expect(freshDelayedPromptContext.priorDiscussions).toEqual([
      expect.objectContaining({
        discussionId: "mapping-github",
        platformDiscussionId: "review-comment:300",
        platformCommentId: 300,
      }),
    ]);
    expect(freshDelayedPromptContext.discussions).toEqual([
      expect.objectContaining({
        id: "review-comment:300",
        comments: [
          expect.objectContaining({ id: 300, isBot: true }),
          expect.objectContaining({ id: 301, isBot: false }),
        ],
      }),
    ]);
    const persistedFollowUpJob = {
      ...job,
      commentId: 301,
      triggerJson: JSON.stringify({
        kind: "github-comment",
        deliveryId: "delivery-follow-up",
        eventName: "pull_request_review_comment",
        triggerKind: "follow-up-comment",
        commentId: 301,
        repositoryId: 2468,
        pullRequestNumber: 42,
        authorUsername: "reviewer",
        body: "Can you explain?",
        instruction: "Can you explain?",
        comment: {
          kind: "discussion-comment",
          discussionId: "review-comment:300",
          commentId: 301,
        },
      }),
    };
    const persistedFollowUpTrigger = runtime.buildReviewTriggerContext({
      job: persistedFollowUpJob,
      payload: {},
      context: routingWithoutThread,
      priorDiscussions: priorDiscussionsWithoutThread,
      mappings: [followUpMapping],
    });
    expect(persistedFollowUpTrigger).toMatchObject({
      kind: "follow-up-comment",
      commentId: 301,
      targetDiscussionId: "mapping-github",
      targetPlatformDiscussionId: "review-comment:300",
      responseTarget: {
        kind: "finding-discussion-reply",
        discussionId: "review-comment:300",
        commentId: 301,
      },
    });
    const fallbackPromptContext = runtime.buildPromptContext({
      attachments: [],
      attachmentIssues: [],
      interactionRunId: "run-github-follow-up",
      tenant,
      job: persistedFollowUpJob,
      runArtifacts: {
        runDirectory: join(workspaceRoot, "run-github-follow-up"),
      } as never,
      trigger: persistedFollowUpTrigger,
      context: routingWithoutThread,
      mappings: [followUpMapping],
      priorFindings: [],
      previousInteraction: null,
    });
    expect(fallbackPromptContext.scope).toMatchObject({
      mode: "follow-up-discussion",
      targetDiscussion: {
        discussionId: "mapping-github",
        platformDiscussionId: "review-comment:300",
        platformCommentId: 300,
      },
    });
    expect(fallbackPromptContext.priorDiscussions).toEqual([
      expect.objectContaining({
        discussionId: "mapping-github",
        humanReplies: [
          {
            platformCommentId: 301,
            authorUsername: "reviewer",
            body: "Reply",
          },
        ],
      }),
    ]);

    const promptContext = runtime.buildPromptContext({
      attachments: [],
      attachmentIssues: [],
      interactionRunId: "run-github",
      tenant,
      job,
      runArtifacts: {
        runDirectory: join(workspaceRoot, "run-github"),
      } as never,
      trigger,
      context: hydrated,
      mappings: [],
      priorFindings: [],
      previousInteraction: null,
    });
    expect(promptContext.workspacePath).toBe(hydrated.workspace.rootPath);
    expect(promptContext.trigger.kind).toBe("manual-review");
    expect(promptContext.discussions).toHaveLength(1);
    expect(promptContext.discussions[0]).toMatchObject({
      id: "PRRT_thread_300",
      resolved: true,
      comments: [
        {
          id: 300,
          resolvable: true,
          resolved: true,
        },
        {
          id: 301,
          resolvable: true,
          resolved: true,
        },
      ],
    });
    expect(promptContext.comments.map((comment) => comment.body)).toEqual([
      "Issue comment",
      "Review body",
    ]);
    expect(
      runtime.locateTriggerCommentReference({
        context: hydrated,
        commentId: 100,
      }),
    ).toEqual({ kind: "code-review-comment", commentId: 100 });
    expect(
      runtime.locateTriggerCommentReference({
        context: hydrated,
        commentId: 301,
      }),
    ).toEqual({
      kind: "discussion-comment",
      discussionId: "PRRT_thread_300",
      commentId: 301,
    });
    await expect(
      runtime.resolveTriggerCommentReference({
        codeReviewId: 42,
        commentId: 301,
      }),
    ).resolves.toEqual({
      kind: "discussion-comment",
      discussionId: "PRRT_thread_300",
      commentId: 301,
    });

    vi.mocked(client.listIssueComments).mockClear();
    vi.mocked(client.listReviewComments).mockClear();
    vi.mocked(client.listReviewThreads).mockClear();
    await expect(
      runtime.resolveTriggerCommentReference({
        codeReviewId: 42,
        commentId: 301,
        triggerJson: JSON.stringify({
          kind: "github-comment",
          deliveryId: "delivery-follow-up",
          eventName: "pull_request_review_comment",
          triggerKind: "follow-up-comment",
          commentId: 301,
          repositoryId: 2468,
          pullRequestNumber: 42,
          authorUsername: "reviewer",
          body: "Can you explain?",
          instruction: "Can you explain?",
          comment: {
            kind: "discussion-comment",
            discussionId: "review-comment:300",
            commentId: 301,
          },
        }),
      }),
    ).resolves.toEqual({
      kind: "discussion-comment",
      discussionId: "review-comment:300",
      commentId: 301,
    });
    expect(client.listIssueComments).not.toHaveBeenCalled();
    expect(client.listReviewComments).not.toHaveBeenCalled();
    expect(client.listReviewThreads).not.toHaveBeenCalled();

    const issueTarget = {
      kind: "code-review-comment" as const,
      locationType: "code-review-comment" as const,
      triggerKind: "direct-mention" as const,
      commentId: 100,
      authorUsername: "octocat",
      body: "Issue comment",
      instruction: "Reply",
    };
    const threadTarget = {
      kind: "discussion-reply" as const,
      locationType: "discussion-comment" as const,
      triggerKind: "follow-up-comment" as const,
      commentId: 301,
      discussionId: "PRRT_thread_300",
      authorUsername: "reviewer",
      body: "Reply",
      instruction: "Reply",
    };
    const chatterGuard = { assertOwned: vi.fn() };
    await expect(
      runtime.publishChatterReplies({
        codeReviewId: 42,
        plannedTargets: [issueTarget, threadTarget],
        result: {
          replies: [
            { target: issueTarget, replyBody: "Issue response" },
            { target: threadTarget, replyBody: "Thread response" },
          ],
        },
        guard: chatterGuard,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        target: issueTarget,
        status: "published",
        commentId: 101,
      }),
      expect.objectContaining({
        target: threadTarget,
        status: "published",
        commentId: 302,
      }),
    ]);
    expect(client.replyToReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({
        commentId: 300,
        body: "Thread response",
      }),
    );
    vi.mocked(client.listReviewThreads).mockResolvedValueOnce([]);
    vi.mocked(client.replyToReviewComment).mockClear();
    const delayedThreadTarget = {
      ...threadTarget,
      kind: "finding-discussion-reply" as const,
      locationType: "finding-discussion" as const,
      discussionId: "review-comment:300",
    };
    await expect(
      runtime.publishChatterReplies({
        codeReviewId: 42,
        plannedTargets: [delayedThreadTarget],
        result: {
          replies: [
            {
              target: delayedThreadTarget,
              replyBody: "Delayed thread response",
            },
          ],
        },
        guard: chatterGuard,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        target: delayedThreadTarget,
        status: "published",
        commentId: 302,
      }),
    ]);
    expect(client.replyToReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({
        commentId: 300,
        body: "Delayed thread response",
      }),
    );

    vi.mocked(client.createIssueComment).mockClear();
    const leaseLost = new Error("lease lost");
    const expiringGuard = {
      assertOwned: vi
        .fn()
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => {
          throw leaseLost;
        }),
    };
    await expect(
      runtime.publishChatterReplies({
        codeReviewId: 42,
        plannedTargets: [issueTarget],
        result: {
          replies: [
            { target: issueTarget, replyBody: "First response" },
            { target: issueTarget, replyBody: "Stale response" },
          ],
        },
        guard: expiringGuard,
      }),
    ).rejects.toBe(leaseLost);
    expect(client.createIssueComment).toHaveBeenCalledTimes(1);

    const adapter = runtime.createReviewPublicationAdapter({
      context: hydrated,
    });
    await expect(adapter.loadDiscussions()).resolves.toHaveLength(1);
    await expect(adapter.upsertSummary({ body: "summary" })).resolves.toEqual(
      expect.objectContaining({
        action: "created",
        url: expect.stringContaining("issuecomment-"),
      }),
    );

    await runtime.cleanupWorkspace(hydrated.workspace);
    await expect(
      readFile(join(hydrated.workspace.rootPath, "src", "runtime.ts")),
    ).rejects.toThrow();
  });

  it("rejects a pull request whose current head differs from the job", async () => {
    const workspaceRoot = await createTempRoot();
    const client = createClient({
      archive: Buffer.alloc(0),
      pullRequestHeadSha: "new-head",
    });
    const runtime = createRuntime({
      workspaceRoot,
      tenant: createTenant("octo-org/reviewphin"),
      client,
      patch: vi.fn(),
      createCodeReviewSnapshot: vi.fn(),
    });

    await expect(runtime.loadRoutingContext(createJob())).rejects.toThrow(
      "head new-head does not match review job head head-sha",
    );
    expect(client.downloadRepositoryArchive).not.toHaveBeenCalled();
  });
});

function createRuntime(input: {
  workspaceRoot: string;
  tenant: TenantRecord;
  client: ReturnType<typeof createClient>;
  patch: ReturnType<typeof vi.fn>;
  createCodeReviewSnapshot: ReturnType<typeof vi.fn>;
  projectMemoryBackend?: ProjectMemoryBackend;
}) {
  return new GitHubPlatformReviewRuntime({
    storage: {
      stores: {
        tenants: {
          patch: input.patch,
        },
      },
      createCodeReviewSnapshot: input.createCodeReviewSnapshot,
    } as unknown as StorageHelpers,
    logger: createLogger("silent"),
    resolvedTenant: {
      tenant: input.tenant,
      connection: createConnection(),
    },
    workspaceRoot: input.workspaceRoot,
    client: input.client as unknown as GitHubClient,
    projectMemoryBackend:
      input.projectMemoryBackend ?? createDisabledProjectMemoryBackend(),
  });
}

function createClient(input: {
  archive: Buffer;
  pullRequestHeadSha?: string;
  threadResolved?: boolean;
  threadOutdated?: boolean;
  resolveRepositoryById?: ReturnType<typeof vi.fn>;
}) {
  return {
    resolveRepositoryById:
      input.resolveRepositoryById ??
      vi.fn(async () => ({
        id: 2468,
        name: "reviewphin",
        fullName: "octo-org/reviewphin",
        private: true,
        htmlUrl: "https://github.com/octo-org/reviewphin",
        ownerLogin: "octo-org",
        ownerId: 456,
        ownerType: "Organization",
      })),
    getPullRequest: vi.fn(async () => ({
      number: 42,
      title: "Add GitHub review runtime",
      body: "Implements read-only hydration.",
      html_url: "https://github.com/octo-org/reviewphin/pull/42",
      user: { login: "octocat" },
      head: {
        sha: input.pullRequestHeadSha ?? "head-sha",
        ref: "feature/github-runtime",
      },
      base: { sha: "base-sha", ref: "main" },
    })),
    listPullRequestFiles: vi.fn(async () => [
      {
        sha: "blob-1",
        filename: "src/runtime.ts",
        status: "modified" as const,
        additions: 2,
        deletions: 1,
        changes: 3,
        blob_url:
          "https://github.com/octo-org/reviewphin/blob/head/src/runtime.ts",
        raw_url:
          "https://github.com/octo-org/reviewphin/raw/head/src/runtime.ts",
        contents_url:
          "https://api.github.com/repos/octo-org/reviewphin/contents/src/runtime.ts",
        patch: "@@ -1 +1 @@",
      },
      {
        sha: "blob-2",
        filename: "new-name.ts",
        previous_filename: "old-name.ts",
        status: "renamed" as const,
        additions: 1,
        deletions: 1,
        changes: 2,
        blob_url:
          "https://github.com/octo-org/reviewphin/blob/head/new-name.ts",
        raw_url: "https://github.com/octo-org/reviewphin/raw/head/new-name.ts",
        contents_url:
          "https://api.github.com/repos/octo-org/reviewphin/contents/new-name.ts",
      },
    ]),
    listIssueComments: vi.fn(async () => [
      {
        id: 100,
        body: "Issue comment",
        html_url:
          "https://github.com/octo-org/reviewphin/pull/42#issuecomment-100",
        user: { id: 10, login: "octocat", type: "User" },
        created_at: "2026-06-11T00:00:00.000Z",
        updated_at: "2026-06-11T00:00:00.000Z",
      },
    ]),
    listPullRequestReviews: vi.fn(async () => [
      {
        id: 200,
        body: "Review body",
        html_url:
          "https://github.com/octo-org/reviewphin/pull/42#pullrequestreview-200",
        user: { id: 11, login: "reviewer", type: "User" },
        state: "COMMENTED",
        commit_id: "head-sha",
        submitted_at: "2026-06-11T00:00:00.000Z",
      },
    ]),
    listReviewComments: vi.fn(async () => [
      {
        id: 301,
        body: "Reply",
        html_url:
          "https://github.com/octo-org/reviewphin/pull/42#discussion_r301",
        user: { id: 11, login: "reviewer", type: "User" },
        path: "src/runtime.ts",
        diff_hunk: "@@ -10,3 +10,4 @@",
        pull_request_review_id: 200,
        in_reply_to_id: 300,
        line: 12,
        side: "RIGHT" as const,
        commit_id: "head-sha",
        original_commit_id: "head-sha",
        created_at: "2026-06-11T00:01:00.000Z",
        updated_at: "2026-06-11T00:01:00.000Z",
      },
      {
        id: 300,
        body: "Finding body\n\n<!-- reviewphin-finding:github:job-github:finding-1 -->",
        html_url:
          "https://github.com/octo-org/reviewphin/pull/42#discussion_r300",
        user: {
          id: 12,
          login: "reviewphin-octo-org[bot]",
          type: "Bot",
        },
        path: "src/runtime.ts",
        diff_hunk: "@@ -10,3 +10,4 @@",
        pull_request_review_id: 200,
        line: 12,
        side: "RIGHT" as const,
        commit_id: "head-sha",
        original_commit_id: "head-sha",
        created_at: "2026-06-11T00:00:00.000Z",
        updated_at: "2026-06-11T00:00:00.000Z",
      },
    ]),
    listReviewThreads: vi.fn(async () => [
      {
        id: "PRRT_thread_300",
        isResolved: input.threadResolved ?? false,
        isOutdated: input.threadOutdated ?? false,
        viewerCanResolve: !(input.threadResolved ?? false),
        viewerCanUnresolve: input.threadResolved ?? false,
        comments: {
          nodes: [
            { id: "PRRC_300", databaseId: 300 },
            { id: "PRRC_301", databaseId: 301 },
          ],
        },
      },
    ]),
    createIssueComment: vi.fn(async ({ body }) => ({
      id: 101,
      body,
      html_url:
        "https://github.com/octo-org/reviewphin/pull/42#issuecomment-101",
      user: {
        id: 12,
        login: "reviewphin-octo-org[bot]",
        type: "Bot",
      },
      created_at: "2026-06-11T00:02:00.000Z",
      updated_at: "2026-06-11T00:02:00.000Z",
    })),
    replyToReviewComment: vi.fn(async ({ body }) => ({
      id: 302,
      body,
      html_url:
        "https://github.com/octo-org/reviewphin/pull/42#discussion_r302",
      user: {
        id: 12,
        login: "reviewphin-octo-org[bot]",
        type: "Bot",
      },
      path: "src/runtime.ts",
      diff_hunk: "@@ -10,3 +10,4 @@",
      pull_request_review_id: 200,
      in_reply_to_id: 300,
      line: 12,
      side: "RIGHT" as const,
      commit_id: "head-sha",
      original_commit_id: "head-sha",
      created_at: "2026-06-11T00:02:00.000Z",
      updated_at: "2026-06-11T00:02:00.000Z",
    })),
    downloadRepositoryArchive: vi.fn(async () => input.archive),
  };
}

async function createRepositoryArchive(): Promise<Buffer> {
  const sourceRoot = await createTempRoot();
  const repositoryRoot = join(sourceRoot, "octo-org-reviewphin-head");
  await mkdir(join(repositoryRoot, ".github"), { recursive: true });
  await mkdir(join(repositoryRoot, "src"), { recursive: true });
  await writeFile(
    join(repositoryRoot, ".github", "copilot-instructions.md"),
    "Use repository instructions.\n",
  );
  await writeFile(join(repositoryRoot, "src", "runtime.ts"), "export {};\n");
  const archivePath = join(sourceRoot, "repository.tar.gz");
  await tar.c({ cwd: sourceRoot, gzip: true, file: archivePath }, [
    "octo-org-reviewphin-head",
  ]);
  return readFile(archivePath);
}

async function createTempRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "reviewphin-github-runtime-"));
  tempRoots.push(path);
  return path;
}

function createTenant(repositoryFullName: string): TenantRecord {
  return {
    id: "tenant-github",
    key: "https://api.github.com::2468",
    platform: "github",
    platformConnectionId: "connection-github",
    platformConfigJson: JSON.stringify({
      repositoryId: 2468,
      repositoryFullName,
    }),
    modelProfileName: null,
    createdAt: "2026-06-11T00:00:00.000Z",
    updatedAt: "2026-06-11T00:00:00.000Z",
  };
}

function createConnection(): PlatformConnectionRecord {
  return {
    id: "connection-github",
    name: "github-main",
    platform: "github",
    status: "ready",
    platformConnectionConfigJson: JSON.stringify({
      owner: "octo-org",
      apiUrl: "https://api.github.com",
      appId: 123,
      appSlug: "reviewphin-octo-org",
      appName: "ReviewPhin octo-org",
      clientId: "Iv1.client",
      clientSecret: "client-secret",
      webhookSecret: "webhook-secret",
      privateKey: "private-key",
      ownerLogin: "octo-org",
      ownerId: 456,
      ownerType: "Organization",
      permissions: {
        checks: "write",
        contents: "read",
        metadata: "read",
        pull_requests: "write",
      },
      events: ["check_run", "pull_request"],
      installationId: 789,
      installationAccountLogin: "octo-org",
      installationAccountId: 456,
      installationAccountType: "Organization",
      repositorySelection: "selected",
      accessibleRepositoryCount: 1,
    }),
    createdAt: "2026-06-11T00:00:00.000Z",
    updatedAt: "2026-06-11T00:00:00.000Z",
  };
}

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
    headSha: "head-sha",
    status: "queued",
    payloadJson: "{}",
    retryCount: 0,
    lastError: null,
    enqueuedAt: "2026-06-11T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
  };
}

function createDiscussionMapping(): DiscussionMappingRecord {
  return {
    id: "mapping-github",
    tenantId: "tenant-github",
    codeReviewId: 42,
    identityKey: "finding-1",
    findingFingerprint: "fingerprint-1",
    title: "Finding body",
    severity: "medium",
    category: "correctness",
    body: "Finding body",
    platformDiscussionId: "PRRT_thread_300",
    platformCommentId: 300,
    anchorJson: JSON.stringify({
      path: "src/runtime.ts",
      startLine: 12,
      endLine: 12,
      side: "new",
    }),
    positionJson: null,
    botDiscussion: true,
    botComment: true,
    commentAuthorId: 12,
    commentAuthorUsername: "reviewphin-octo-org[bot]",
    status: "open",
    lastInteractionRunId: "run-previous",
    createdAt: "2026-06-11T00:00:00.000Z",
    updatedAt: "2026-06-11T00:00:00.000Z",
  };
}
