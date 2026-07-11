import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewWorker } from "../src/jobs/review-worker.js";
import { createLogger } from "../src/logger.js";
import type { GitHubApi } from "../src/platforms/github/client.js";
import GitHubPlatform from "../src/platforms/github/platform.js";
import { DiscussionReconciler } from "../src/reconcile/discussion-reconciler.js";
import type {
  InteractionJobRecord,
  PlatformConnectionRecord,
  TenantRecord,
} from "../src/storage/contract/current.js";
import type { StorageHelpers } from "../src/storage/storage-helpers.js";
import { createClaimContext } from "./helpers/claim.js";
import { overridePlatformRuntime } from "./helpers/platform-runtime.js";

const tempRoots: string[] = [];

describe("GitHub requested-action happy path", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("publishes findings and summary before completing the Check Run with links", async () => {
    const root = await mkdtemp(join(tmpdir(), "reviewphin-github-e2e-"));
    tempRoots.push(root);
    const tenant = createTenant();
    const connection = createConnection();
    const job = createJob();
    const github = createGitHubApiState();
    const storage = createStorage(job);
    const logger = createLogger("silent");
    const platform = new GitHubPlatform({
      logger,
      publicUrl: "https://review.example.com",
      createApp: () => ({
        octokit: { request: vi.fn() },
        getInstallationOctokit: vi.fn(async () => github.api),
      }),
    });
    const routingContext = createRoutingContext({
      tenant,
      job,
      workspaceRoot: root,
    });
    const review = vi.fn(async () => ({
      overview: {
        summary: "One correctness issue found.",
        overallSeverity: "high" as const,
      },
      findings: [
        {
          title: "Return the computed value",
          body: "The changed branch drops the result.",
          severity: "high" as const,
          category: "bug" as const,
          anchor: {
            path: "src/index.ts",
            startLine: 2,
            endLine: 2,
            side: "new" as const,
          },
          suggestion: {
            startLine: 2,
            endLine: 2,
            replacement: "return value;",
          },
        },
      ],
      priorDispositions: [],
    }));
    const reconciler = new DiscussionReconciler({ storage, logger });
    const worker = new ReviewWorker({
      storage,
      tenantRegistry: {
        getResolvedTenantById: vi.fn(async () => ({ tenant, connection })),
      } as never,
      reviewProviderFactory: {
        createProvider: vi.fn(() => ({
          name: "copilot-sdk",
          review,
        })),
      },
      chatterRunnerFactory: {
        createRunner: vi.fn(() => ({
          run: vi.fn(),
          sessionPaths: {
            memory: ["copilot", "chatter", "memory"],
            reply: ["copilot", "chatter", "reply"],
          },
        })),
      } as never,
      reconciler,
      logger,
      runLogDir: join(root, "run-logs"),
      workspaceRoot: join(root, "workspaces"),
      memoryEnabled: false,
      maxJobRetries: 0,
      retryBackoffMs: 1000,
      platformResolver: () => platform,
      reviewRuntimeFactory: (input) =>
        overridePlatformRuntime(
          platform.createReviewRuntime({
            storage: input.storage,
            logger: input.logger,
            resolvedTenant: {
              tenant: input.tenant,
              connection: input.connection,
            },
            interactionJobId: input.interactionJobId,
            workspaceRoot: input.workspaceRoot,
            memoryEnabled: input.memoryEnabled,
            interactionRunId: input.interactionRunId,
            runArtifacts: input.runArtifacts,
          }),
          {
            loadRoutingContext: vi.fn(async () => routingContext),
            hydrate: vi.fn(async () => routingContext),
            cleanupWorkspace: vi.fn(async () => {}),
          },
        ),
    });

    const webhookBody = {
      action: "requested_action",
      installation: { id: 789 },
      repository: { id: 2468, full_name: "octo/repo" },
      requested_action: { identifier: "run_review" },
      check_run: {
        id: 1357,
        head_sha: "head-sha",
        app: { id: 123 },
      },
    };
    const payload = platform.parseWebhookPayload(webhookBody, {
      headers: {
        "x-github-delivery": "delivery-1",
        "x-github-event": "check_run",
      },
      body: webhookBody,
      rawBody: Buffer.from(JSON.stringify(webhookBody)),
      pathSuffix: "",
    });
    const resolvedTenant = { tenant, connection };
    const trigger = await worker.classifyWebhookTrigger(
      payload,
      resolvedTenant,
    );
    expect(trigger).toEqual({
      kind: "check-run-requested-action",
      checkRunId: 1357,
      actionIdentifier: "run_review",
    });
    const created = await worker.createInteractionJobFromWebhook(
      payload,
      resolvedTenant,
      trigger!,
    );
    expect(created).toMatchObject({
      created: true,
      job: {
        codeReviewId: 42,
        commentId: null,
        headSha: "head-sha",
      },
    });

    await expect(
      worker.processClaimedJob(
        created.job as never,
        createClaimContext(created.job.id),
      ),
    ).resolves.toBeUndefined();

    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: expect.objectContaining({
          kind: "manual-review",
          provider: "github",
          source: "check-run-requested-action",
        }),
      }),
      expect.any(Object),
    );
    expect(github.createdReviewPayloads).toEqual([
      expect.objectContaining({
        body: "<!-- reviewphin-publication:job-github -->",
        comments: [
          expect.objectContaining({
            path: "src/index.ts",
            line: 2,
            side: "RIGHT",
            body: expect.stringContaining(
              "```suggestion\nreturn value;\n```",
            ),
          }),
        ],
      }),
    ]);
    expect(github.submittedReviewEvents).toEqual(["COMMENT"]);
    expect(github.issueComments).toHaveLength(1);
    expect(github.issueComments[0]?.body).toContain(
      "<!-- reviewphin-review-summary -->",
    );

    const completed = github.checkRunUpdates.find(
      (update) => update.status === "completed",
    );
    expect(completed).toMatchObject({
      conclusion: "success",
      actions: [
        expect.objectContaining({
          identifier: "run_review",
        }),
      ],
    });
    expect(completed?.output.summary).toContain("One correctness issue found.");
    expect(completed?.output.summary).toContain(
      "https://github.com/octo/repo/pull/42#pullrequestreview-500",
    );
    expect(completed?.output.summary).toContain(
      "https://github.com/octo/repo/pull/42#issuecomment-700",
    );
    expect(
      github.issueCommentCreatedOrder[0] ?? Number.MAX_SAFE_INTEGER,
    ).toBeLessThan(
      github.completedCheckRunOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });
});

function createStorage(job: InteractionJobRecord): StorageHelpers {
  const mappings: unknown[] = [];
  return {
    stores: {
      interactionJobs: {
        get: vi.fn(async () => job),
        createInteractionRunForClaim: vi.fn(async () => ({
          id: "run-github",
          interactionJobId: job.id,
          tenantId: job.tenantId,
          provider: "copilot-sdk",
          model: null,
          modelProfileName: null,
          providerBaseUrl: null,
          providerType: null,
          textGenerationModel: null,
          status: "in_progress" as const,
          resultJson: null,
          error: null,
          startedAt: "2026-06-14T00:00:00.000Z",
          finishedAt: null,
        })),
        replaceReviewFindingsForClaim: vi.fn(async () => true),
        transitionInteractionRunForClaim: vi.fn(async () => true),
        upsertInteractionRunMetricsForClaim: vi.fn(async () => true),
        updateReviewFindingStatusForClaim: vi.fn(async () => true),
        upsertDiscussionMappingForClaim: vi.fn(async ({ mapping }) => {
          const record = {
            id: "mapping-github",
            ...mapping,
            createdAt: "2026-06-14T00:00:00.000Z",
            updatedAt: "2026-06-14T00:00:00.000Z",
          };
          mappings.push(record);
          return record;
        }),
        transitionClaim: vi.fn(async () => true),
      },
      discussionMappings: {
        list: vi.fn(async () => mappings),
      },
      modelProfiles: {
        get: vi.fn(async () => null),
        find: vi.fn(async () => null),
      },
    },
    createOrGetInteractionJob: vi.fn(async (input) => ({
      created: true,
      job: {
        ...job,
        ...input,
      },
    })),
    getModelProfileByName: vi.fn(async () => null),
    getDefaultModelProfile: vi.fn(async () => null),
    getLatestCompletedInteractionForCodeReview: vi.fn(async () => null),
    listPriorReviewFindings: vi.fn(async () => []),
    listLatestReviewFindings: vi.fn(async () => []),
  } as unknown as StorageHelpers;
}

function createRoutingContext(input: {
  tenant: TenantRecord;
  job: InteractionJobRecord;
  workspaceRoot: string;
}) {
  const pullRequest = {
    number: 42,
    title: "Fix computed return value",
    body: "Returns the computed value.",
    html_url: "https://github.com/octo/repo/pull/42",
    user: { login: "octocat" },
    head: { sha: "head-sha", ref: "feature/fix-return" },
    base: { sha: "base-sha", ref: "main" },
  };
  const files = [
    {
      sha: "blob",
      filename: "src/index.ts",
      status: "modified" as const,
      additions: 1,
      deletions: 0,
      changes: 1,
      blob_url: "https://github.com/octo/repo/blob/head/src/index.ts",
      raw_url: "https://github.com/octo/repo/raw/head/src/index.ts",
      contents_url:
        "https://api.github.com/repos/octo/repo/contents/src/index.ts",
      patch: "@@ -1,1 +1,2 @@\n const value = compute();\n+value;",
    },
  ];
  return {
    codeReviewId: 42,
    summaryContext: {
      codeReview: {
        id: 42,
        title: pullRequest.title,
        description: pullRequest.body,
        webUrl: pullRequest.html_url,
        authorUsername: "octocat",
        sourceBranch: pullRequest.head.ref,
        targetBranch: pullRequest.base.ref,
      },
      changes: [
        {
          oldPath: "src/index.ts",
          newPath: "src/index.ts",
          diff: files[0]!.patch,
          newFile: false,
          renamedFile: false,
          deletedFile: false,
        },
      ],
    },
    workspace: {
      rootPath: input.workspaceRoot,
      cleanupRoot: input.workspaceRoot,
      strategy: "archive" as const,
    },
    projectMemory: {
      enabled: false,
      page: null,
      entries: [],
    },
    changedFileCount: 1,
    commentCount: 0,
    discussionCount: 0,
    platformContext: {
      tenant: input.tenant,
      job: input.job,
      repositoryFullName: "octo/repo",
      pullRequest,
      files,
      issueComments: [],
      reviews: [],
      reviewComments: [],
      reviewThreads: [],
      workspace: {
        rootPath: input.workspaceRoot,
        cleanupRoot: input.workspaceRoot,
        strategy: "archive" as const,
      },
      projectMemory: {
        enabled: false,
        page: null,
        entries: [],
      },
    },
  };
}

function createGitHubApiState() {
  const reviews: Array<Record<string, unknown>> = [];
  const reviewComments: Array<Record<string, unknown>> = [];
  const reviewThreads: Array<Record<string, unknown>> = [];
  const issueComments: Array<Record<string, unknown>> = [];
  const createdReviewPayloads: Array<Record<string, unknown>> = [];
  const submittedReviewEvents: string[] = [];
  const checkRunUpdates: Array<{
    status: string;
    conclusion?: string;
    output: { title: string; summary: string };
    actions?: unknown[];
  }> = [];
  const issueCommentCreatedOrder: number[] = [];
  const completedCheckRunOrder: number[] = [];
  let operationOrder = 0;

  const api: GitHubApi = {
    request: vi.fn(async (route, parameters = {}) => {
      if (route === "GET /repositories/{repository_id}") {
        return {
          data: {
            id: 2468,
            name: "repo",
            full_name: "octo/repo",
            private: true,
            html_url: "https://github.com/octo/repo",
            owner: { login: "octo", id: 99, type: "Organization" },
          },
        };
      }
      if (
        route === "GET /repos/{owner}/{repo}/check-runs/{check_run_id}"
      ) {
        return {
          data: {
            id: 1357,
            head_sha: "head-sha",
            app: { id: 123 },
            pull_requests: [{ number: 42, head: { sha: "head-sha" } }],
          },
        };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        return {
          data: {
            number: 42,
            head: { sha: "head-sha" },
          },
        };
      }
      if (
        route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments"
      ) {
        return { data: issueComments };
      }
      if (
        route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews"
      ) {
        return { data: reviews };
      }
      if (
        route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments"
      ) {
        return { data: reviewComments };
      }
      if (route === "POST /graphql") {
        return {
          data: {
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: reviewThreads,
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          },
        };
      }
      if (
        route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews"
      ) {
        createdReviewPayloads.push(parameters);
        const review = {
          id: 500,
          body: parameters.body,
          html_url:
            "https://github.com/octo/repo/pull/42#pullrequestreview-500",
          user: { id: 1, login: "reviewphin-octo[bot]", type: "Bot" },
          state: "PENDING",
          commit_id: "head-sha",
          submitted_at: null,
        };
        reviews.push(review);
        for (const [index, comment] of (
          parameters.comments as Array<Record<string, unknown>>
        ).entries()) {
          reviewComments.push({
            id: 600 + index,
            body: comment.body,
            html_url: `https://github.com/octo/repo/pull/42#discussion_r${600 + index}`,
            user: { id: 1, login: "reviewphin-octo[bot]", type: "Bot" },
            path: comment.path,
            diff_hunk: "@@ -1,1 +1,2 @@",
            pull_request_review_id: 500,
            line: comment.line,
            side: comment.side,
            start_line: comment.start_line ?? null,
            start_side: comment.start_side ?? null,
            commit_id: "head-sha",
            original_commit_id: "head-sha",
            created_at: "2026-06-14T00:00:00.000Z",
            updated_at: "2026-06-14T00:00:00.000Z",
          });
        }
        return { data: review };
      }
      if (
        route ===
        "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/events"
      ) {
        submittedReviewEvents.push(String(parameters.event));
        reviews[0]!.state = "COMMENTED";
        reviews[0]!.submitted_at = "2026-06-14T00:01:00.000Z";
        reviewThreads.push({
          id: "PRRT_600",
          isResolved: false,
          isOutdated: false,
          viewerCanResolve: true,
          viewerCanUnresolve: false,
          comments: {
            nodes: [{ id: "PRRC_600", databaseId: 600 }],
          },
        });
        return { data: reviews[0] };
      }
      if (
        route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments"
      ) {
        const comment = {
          id: 700,
          body: parameters.body,
          html_url:
            "https://github.com/octo/repo/pull/42#issuecomment-700",
          user: { id: 1, login: "reviewphin-octo[bot]", type: "Bot" },
          created_at: "2026-06-14T00:02:00.000Z",
          updated_at: "2026-06-14T00:02:00.000Z",
        };
        issueComments.push(comment);
        issueCommentCreatedOrder.push(++operationOrder);
        return { data: comment };
      }
      if (
        route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}"
      ) {
        const update = parameters as unknown as {
          status: string;
          conclusion?: string;
          output: { title: string; summary: string };
          actions?: unknown[];
        };
        checkRunUpdates.push(update);
        operationOrder += 1;
        if (update.status === "completed") {
          completedCheckRunOrder.push(operationOrder);
        }
        return { data: {} };
      }
      throw new Error(`Unexpected GitHub route ${route}`);
    }),
  };

  return {
    api,
    issueComments,
    createdReviewPayloads,
    submittedReviewEvents,
    checkRunUpdates,
    issueCommentCreatedOrder,
    completedCheckRunOrder,
  };
}

function createTenant(): TenantRecord {
  return {
    id: "tenant-github",
    key: "https://api.github.com::2468",
    platform: "github",
    platformConnectionId: "connection-github",
    platformConfigJson: JSON.stringify({
      repositoryId: 2468,
      repositoryFullName: "octo/repo",
    }),
    modelProfileName: null,
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z",
  };
}

function createConnection(): PlatformConnectionRecord {
  return {
    id: "connection-github",
    name: "github-main",
    platform: "github",
    status: "ready",
    platformConnectionConfigJson: JSON.stringify({
      owner: "octo",
      apiUrl: "https://api.github.com",
      appId: 123,
      appSlug: "reviewphin-octo",
      appName: "ReviewPhin octo",
      clientId: "Iv1.client",
      clientSecret: "client-secret",
      webhookSecret: "webhook-secret",
      privateKey: "private-key",
      ownerLogin: "octo",
      ownerId: 99,
      ownerType: "Organization",
      permissions: {
        checks: "write",
        metadata: "read",
        pull_requests: "write",
      },
      events: ["check_run", "pull_request"],
      installationId: 789,
      installationAccountLogin: "octo",
      installationAccountId: 99,
      installationAccountType: "Organization",
      repositorySelection: "selected",
      accessibleRepositoryCount: 1,
    }),
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z",
  };
}

function createJob(): InteractionJobRecord {
  return {
    id: "job-github",
    availableAt: "2026-06-14T00:00:00.000Z",
    claimToken: null,
    claimedBy: null,
    claimExpiresAt: null,
    latestInteractionRunId: null,
    tenantId: "tenant-github",
    dedupeKey: "delivery-1",
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
    payloadJson: JSON.stringify({
      eventName: "check_run",
      action: "requested_action",
    }),
    retryCount: 0,
    lastError: null,
    enqueuedAt: "2026-06-14T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
  };
}
