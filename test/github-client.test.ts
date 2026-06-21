import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  GitHubApiError,
  GitHubClient,
} from "../src/platforms/github/client.js";
import {
  githubConnectionRegistrationSchema,
  readyGitHubConnectionConfigSchema,
} from "../src/platforms/github/config.js";

describe("GitHubClient", () => {
  it("delegates webhook signature verification to Octokit", async () => {
    const verify = vi.fn(async () => true);
    const client = new GitHubClient({
      config: createReadyConfig(),
      createApp: () => ({
        octokit: { request: vi.fn() },
        webhooks: { verify },
        getInstallationOctokit: vi.fn(),
      }),
    });

    await expect(
      client.verifyWebhookSignature('{"action":"requested_action"}', "sig"),
    ).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith('{"action":"requested_action"}', "sig");
  });

  it("verifies a real GitHub webhook HMAC through Octokit", async () => {
    const payload = '{"action":"requested_action"}';
    const webhookSecret = "real-webhook-secret";
    const signature = `sha256=${createHmac("sha256", webhookSecret).update(payload).digest("hex")}`;
    const client = new GitHubClient({
      config: createReadyConfig({ webhookSecret }),
    });

    await expect(
      client.verifyWebhookSignature(payload, signature),
    ).resolves.toBe(true);
    await expect(
      client.verifyWebhookSignature(payload, "sha256=invalid"),
    ).resolves.toBe(false);
  });

  it("uses the configured app credentials, API URL, and installation", async () => {
    const request = vi.fn(async () => ({
      data: createRepository(),
    }));
    const getInstallationOctokit = vi.fn(async () => ({ request }));
    const createApp = vi.fn(() => ({
      octokit: { request: vi.fn() },
      getInstallationOctokit,
    }));
    const client = new GitHubClient({
      config: createReadyConfig(),
      createApp,
    });

    await expect(
      client.resolveRepository("octo-org", "reviewphin"),
    ).resolves.toEqual({
      id: 2468,
      name: "reviewphin",
      fullName: "octo-org/reviewphin",
      private: true,
      htmlUrl: "https://github.com/octo-org/reviewphin",
      ownerLogin: "octo-org",
      ownerId: 456,
      ownerType: "Organization",
    });
    expect(createApp).toHaveBeenCalledWith({
      appId: 123,
      privateKey: "private-key",
      clientId: "Iv1.client",
      clientSecret: "client-secret",
      webhookSecret: "webhook-secret",
      apiUrl: "https://api.github.com",
    });
    expect(getInstallationOctokit).toHaveBeenCalledWith(789);
    expect(request).toHaveBeenCalledWith("GET /repos/{owner}/{repo}", {
      owner: "octo-org",
      repo: "reviewphin",
    });
  });

  it("reports repositories unavailable to the configured installation", async () => {
    const client = new GitHubClient({
      config: createReadyConfig(),
      createApp: () => ({
        octokit: { request: vi.fn() },
        getInstallationOctokit: vi.fn(async () => ({
          request: vi.fn(async () => {
            throw new Error("Not Found");
          }),
        })),
      }),
    });

    await expect(
      client.resolveRepository("octo-org", "missing"),
    ).rejects.toThrow(
      "Repository octo-org/missing is not accessible to GitHub App installation 789",
    );
  });

  it("resolves the current repository name from its canonical numeric id", async () => {
    const request = vi.fn(async () => ({
      data: createRepository({
        name: "renamed",
        full_name: "new-owner/renamed",
        html_url: "https://github.com/new-owner/renamed",
        owner: {
          login: "new-owner",
          id: 999,
          type: "Organization",
        },
      }),
    }));
    const client = createClientWithInstallationRequest(request);

    await expect(client.resolveRepositoryById(2468)).resolves.toMatchObject({
      id: 2468,
      fullName: "new-owner/renamed",
      ownerLogin: "new-owner",
    });
    expect(request).toHaveBeenCalledWith("GET /repositories/{repository_id}", {
      repository_id: 2468,
    });
  });

  it("reads pull request metadata through the installation client", async () => {
    const request = vi.fn(async () => ({
      data: createPullRequest(),
    }));
    const client = createClientWithInstallationRequest(request);

    await expect(
      client.getPullRequest("octo-org/reviewphin", 42),
    ).resolves.toMatchObject({
      number: 42,
      title: "Add GitHub review runtime",
      head: { sha: "head-sha", ref: "feature/github-runtime" },
      base: { sha: "base-sha", ref: "main" },
    });
    expect(request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner: "octo-org",
        repo: "reviewphin",
        pull_number: 42,
      },
    );
  });

  it("paginates open pull requests", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      ...createPullRequest(),
      number: index + 1,
    }));
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: firstPage })
      .mockResolvedValueOnce({
        data: [{ ...createPullRequest(), number: 101 }],
      });
    const client = createClientWithInstallationRequest(request);

    const pullRequests = await client.listOpenPullRequests(
      "octo-org/reviewphin",
    );

    expect(pullRequests).toHaveLength(101);
    expect(request).toHaveBeenNthCalledWith(
      2,
      "GET /repos/{owner}/{repo}/pulls",
      {
        owner: "octo-org",
        repo: "reviewphin",
        state: "open",
        sort: "created",
        direction: "asc",
        per_page: 100,
        page: 2,
      },
    );
  });

  it("paginates pull request files until a partial page", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      createPullRequestFile(`src/file-${index}.ts`),
    );
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: firstPage })
      .mockResolvedValueOnce({
        data: [createPullRequestFile("src/final.ts")],
      });
    const client = createClientWithInstallationRequest(request);

    const files = await client.listPullRequestFiles("octo-org/reviewphin", 42);

    expect(files).toHaveLength(101);
    expect(files.at(-1)?.filename).toBe("src/final.ts");
    expect(request).toHaveBeenNthCalledWith(
      2,
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      {
        owner: "octo-org",
        repo: "reviewphin",
        pull_number: 42,
        per_page: 100,
        page: 2,
      },
    );
  });

  it("reads issue comments, reviews, and review comments", async () => {
    const request = vi.fn(async (route: string) => {
      if (route.includes("/issues/")) {
        return { data: [createIssueComment()] };
      }
      if (route.endsWith("/reviews")) {
        return { data: [createPullRequestReview()] };
      }
      return { data: [createReviewComment()] };
    });
    const client = createClientWithInstallationRequest(request);

    const [comments, reviews, reviewComments] = await Promise.all([
      client.listIssueComments("octo-org/reviewphin", 42),
      client.listPullRequestReviews("octo-org/reviewphin", 42),
      client.listReviewComments("octo-org/reviewphin", 42),
    ]);

    expect(comments[0]).toMatchObject({ id: 1, body: "Issue comment" });
    expect(reviews[0]).toMatchObject({ id: 2, state: "APPROVED" });
    expect(reviewComments[0]).toMatchObject({
      id: 3,
      path: "src/runtime.ts",
      line: 12,
    });
  });

  it("lists and creates issue comment reactions", async () => {
    const request = vi.fn(async (route: string) => {
      if (route.startsWith("GET")) {
        return { data: [createReaction("eyes")] };
      }
      return { data: createReaction("hooray") };
    });
    const client = createClientWithInstallationRequest(request);

    await expect(
      client.listIssueCommentReactions("octo-org/reviewphin", 555),
    ).resolves.toMatchObject([{ content: "eyes" }]);
    await expect(
      client.createIssueCommentReaction({
        repositoryFullName: "octo-org/reviewphin",
        commentId: 555,
        content: "hooray",
      }),
    ).resolves.toMatchObject({ content: "hooray" });

    expect(request).toHaveBeenNthCalledWith(
      1,
      "GET /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions",
      {
        owner: "octo-org",
        repo: "reviewphin",
        comment_id: 555,
        per_page: 100,
        page: 1,
      },
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions",
      {
        owner: "octo-org",
        repo: "reviewphin",
        comment_id: 555,
        content: "hooray",
      },
    );
  });

  it("downloads repository archives as buffers", async () => {
    const request = vi.fn(async () => ({
      data: Uint8Array.from([31, 139, 8, 0]),
    }));
    const client = createClientWithInstallationRequest(request);

    await expect(
      client.downloadRepositoryArchive("octo-org/reviewphin", "head-sha"),
    ).resolves.toEqual(Buffer.from([31, 139, 8, 0]));
  });

  it("translates GitHub API failures with their status", async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });
    const client = createClientWithInstallationRequest(request);

    const error = await client
      .getPullRequest("octo-org/reviewphin", 42)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({
      status: 404,
      message:
        "GitHub pull request octo-org/reviewphin#42 request failed with status 404",
    });
  });

  it("resolves one pull request from an app-owned Check Run head", async () => {
    const request = vi.fn(async (route: string) => {
      if (route.includes("check-runs")) {
        return {
          data: {
            id: 1357,
            head_sha: "abc123",
            app: { id: 123 },
            pull_requests: [{ number: 42, head: { sha: "abc123" } }],
          },
        };
      }
      return {
        data: {
          number: 42,
          head: { sha: "abc123" },
        },
      };
    });
    const client = createClientWithInstallationRequest(request);

    await expect(
      client.resolveCheckRunPullRequest({
        repositoryFullName: "octo-org/reviewphin",
        checkRunId: 1357,
        expectedAppId: 123,
      }),
    ).resolves.toEqual({
      checkRunId: 1357,
      headSha: "abc123",
      pullRequestNumber: 42,
    });
  });

  it("rejects foreign, missing, ambiguous, and stale Check Run pull requests", async () => {
    const createClient = (checkRun: Record<string, unknown>, head = "abc123") =>
      createClientWithInstallationRequest(
        vi.fn(async (route: string) =>
          route.includes("check-runs")
            ? { data: checkRun }
            : { data: { number: 42, head: { sha: head } } },
        ),
      );
    const base = {
      id: 1357,
      head_sha: "abc123",
      app: { id: 123 },
    };

    await expect(
      createClient({
        ...base,
        app: { id: 999 },
        pull_requests: [{ number: 42 }],
      }).resolveCheckRunPullRequest({
        repositoryFullName: "octo-org/reviewphin",
        checkRunId: 1357,
        expectedAppId: 123,
      }),
    ).rejects.toThrow("belongs to GitHub App 999");
    for (const pullRequests of [[], [{ number: 41 }, { number: 42 }]]) {
      await expect(
        createClient({
          ...base,
          pull_requests: pullRequests,
        }).resolveCheckRunPullRequest({
          repositoryFullName: "octo-org/reviewphin",
          checkRunId: 1357,
          expectedAppId: 123,
        }),
      ).rejects.toThrow("must reference exactly one pull request");
    }
    await expect(
      createClient(
        { ...base, pull_requests: [{ number: 42 }] },
        "new-head",
      ).resolveCheckRunPullRequest({
        repositoryFullName: "octo-org/reviewphin",
        checkRunId: 1357,
        expectedAppId: 123,
      }),
    ).rejects.toThrow("does not match pull request 42 head");
  });

  it("updates Check Run progress and preserves the action on terminal states", async () => {
    const request = vi.fn(async () => ({ data: {} }));
    const client = createClientWithInstallationRequest(request);

    await client.updateCheckRun({
      repositoryFullName: "octo-org/reviewphin",
      checkRunId: 1357,
      state: { status: "in_progress", summary: "Running" },
    });
    await client.updateCheckRun({
      repositoryFullName: "octo-org/reviewphin",
      checkRunId: 1357,
      state: {
        status: "completed",
        conclusion: "failure",
        summary: "Failed",
      },
    });

    const calls = request.mock.calls as unknown as Array<
      [string, Record<string, unknown>]
    >;
    expect(calls[0]?.[1]).toMatchObject({
      check_run_id: 1357,
      status: "in_progress",
      output: { title: "Review in progress", summary: "Running" },
    });
    expect(calls[1]?.[1]).toMatchObject({
      check_run_id: 1357,
      status: "completed",
      conclusion: "failure",
      output: { title: "Review failed", summary: "Failed" },
      actions: [
        {
          label: "Run Review",
          identifier: "run_review",
        },
      ],
    });
  });

  it("creates one neutral manual Check Run for a pull request head", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: { check_runs: [] } })
      .mockResolvedValueOnce({
        data: {
          id: 24680,
          head_sha: "head-sha",
          external_id: "reviewphin:pull-request:42",
          app: { id: 123 },
        },
      });
    const client = createClientWithInstallationRequest(request);

    await expect(
      client.ensurePullRequestCheckRun({
        repositoryFullName: "octo-org/reviewphin",
        pullRequestNumber: 42,
        headSha: "head-sha",
        expectedAppId: 123,
      }),
    ).resolves.toEqual({
      checkRunId: 24680,
      created: true,
    });
    expect(request).toHaveBeenNthCalledWith(
      2,
      "POST /repos/{owner}/{repo}/check-runs",
      expect.objectContaining({
        name: "ReviewPhin",
        head_sha: "head-sha",
        external_id: "reviewphin:pull-request:42",
        status: "completed",
        conclusion: "neutral",
        output: {
          title: "Review ready",
          summary: "Use Run Review to request a ReviewPhin code review.",
        },
        actions: [
          {
            label: "Run Review",
            description: "Request a ReviewPhin code review",
            identifier: "run_review",
          },
        ],
      }),
    );
    const createdAction = (
      request.mock.calls[1]?.[1] as {
        actions: Array<{
          label: string;
          description: string;
          identifier: string;
        }>;
      }
    ).actions[0]!;
    expect(createdAction.label.length).toBeLessThanOrEqual(40);
    expect(createdAction.description.length).toBeLessThanOrEqual(40);
    expect(createdAction.identifier.length).toBeLessThanOrEqual(40);
  });

  it("reuses the same-head Check Run and creates a new run for a new head", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          check_runs: [
            {
              id: 1357,
              head_sha: "head-one",
              external_id: "reviewphin:pull-request:42",
              app: { id: 123 },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ data: { check_runs: [] } })
      .mockResolvedValueOnce({
        data: {
          id: 2468,
          head_sha: "head-two",
          external_id: "reviewphin:pull-request:42",
          app: { id: 123 },
        },
      });
    const client = createClientWithInstallationRequest(request);

    await expect(
      client.ensurePullRequestCheckRun({
        repositoryFullName: "octo-org/reviewphin",
        pullRequestNumber: 42,
        headSha: "head-one",
        expectedAppId: 123,
      }),
    ).resolves.toEqual({
      checkRunId: 1357,
      created: false,
    });
    await expect(
      client.ensurePullRequestCheckRun({
        repositoryFullName: "octo-org/reviewphin",
        pullRequestNumber: 42,
        headSha: "head-two",
        expectedAppId: 123,
      }),
    ).resolves.toEqual({
      checkRunId: 2468,
      created: true,
    });

    expect(
      request.mock.calls.filter(
        ([route]) => route === "POST /repos/{owner}/{repo}/check-runs",
      ),
    ).toHaveLength(1);
  });

  it("creates and submits a pending review with modern line ranges", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          ...createPullRequestReview(),
          id: 22,
          state: "PENDING",
          submitted_at: null,
        },
      })
      .mockResolvedValueOnce({
        data: {
          ...createPullRequestReview(),
          id: 22,
          state: "COMMENTED",
        },
      });
    const client = createClientWithInstallationRequest(request);

    await client.createPullRequestReview({
      repositoryFullName: "octo-org/reviewphin",
      pullRequestNumber: 42,
      commitId: "head-sha",
      body: "<!-- publication -->",
      comments: [
        {
          path: "src/runtime.ts",
          body: "Finding",
          line: 14,
          side: "RIGHT",
          startLine: 12,
          startSide: "RIGHT",
        },
      ],
    });
    await client.submitPullRequestReview({
      repositoryFullName: "octo-org/reviewphin",
      pullRequestNumber: 42,
      reviewId: 22,
    });

    expect(request).toHaveBeenNthCalledWith(
      1,
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      expect.objectContaining({
        commit_id: "head-sha",
        comments: [
          {
            path: "src/runtime.ts",
            body: "Finding",
            line: 14,
            side: "RIGHT",
            start_line: 12,
            start_side: "RIGHT",
          },
        ],
      }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/events",
      expect.objectContaining({
        review_id: 22,
        event: "COMMENT",
      }),
    );
  });

  it("reads and resolves GraphQL review threads", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "PRRT_1",
                      isResolved: false,
                      isOutdated: false,
                      comments: {
                        nodes: [{ id: "PRRC_1", databaseId: 10 }],
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          data: {
            resolveReviewThread: {
              thread: { id: "PRRT_1", isResolved: true },
            },
          },
        },
      });
    const client = createClientWithInstallationRequest(request);

    await expect(
      client.listReviewThreads("octo-org/reviewphin", 42),
    ).resolves.toEqual([
      expect.objectContaining({ id: "PRRT_1", isResolved: false }),
    ]);
    await client.setReviewThreadResolved("PRRT_1", true);

    expect(request).toHaveBeenNthCalledWith(
      1,
      "POST /graphql",
      expect.objectContaining({
        variables: {
          owner: "octo-org",
          repository: "reviewphin",
          pullRequestNumber: 42,
          cursor: null,
        },
      }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "POST /graphql",
      expect.objectContaining({
        variables: { input: { threadId: "PRRT_1" } },
      }),
    );
  });
});

describe("GitHub connection config", () => {
  it("normalizes GitHub.com API URL and rejects GitHub Enterprise Server", () => {
    expect(
      githubConnectionRegistrationSchema.parse({
        owner: "octo-org",
        apiUrl: "https://api.github.com/",
      }),
    ).toEqual({
      owner: "octo-org",
      apiUrl: "https://api.github.com",
    });
    expect(() =>
      githubConnectionRegistrationSchema.parse({
        owner: "octo-org",
        apiUrl: "https://github.example.com/api/v3",
      }),
    ).toThrow("GitHub Enterprise Server is not supported yet");
  });
});

function createReadyConfig(input: { webhookSecret?: string } = {}) {
  return readyGitHubConnectionConfigSchema.parse({
    owner: "octo-org",
    apiUrl: "https://api.github.com",
    appId: 123,
    appSlug: "reviewphin-octo-org",
    appName: "ReviewPhin octo-org",
    clientId: "Iv1.client",
    clientSecret: "client-secret",
    webhookSecret: input.webhookSecret ?? "webhook-secret",
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
  });
}

function createRepository(overrides: Record<string, unknown> = {}) {
  return {
    id: 2468,
    name: "reviewphin",
    full_name: "octo-org/reviewphin",
    private: true,
    html_url: "https://github.com/octo-org/reviewphin",
    owner: {
      login: "octo-org",
      id: 456,
      type: "Organization",
    },
    ...overrides,
  };
}

function createPullRequest() {
  return {
    number: 42,
    title: "Add GitHub review runtime",
    body: "Implements read-only hydration.",
    html_url: "https://github.com/octo-org/reviewphin/pull/42",
    user: { login: "octocat" },
    head: { sha: "head-sha", ref: "feature/github-runtime" },
    base: { sha: "base-sha", ref: "main" },
  };
}

function createPullRequestFile(filename: string) {
  return {
    sha: "blob-sha",
    filename,
    status: "modified",
    additions: 2,
    deletions: 1,
    changes: 3,
    blob_url: `https://github.com/octo-org/reviewphin/blob/head/${filename}`,
    raw_url: `https://github.com/octo-org/reviewphin/raw/head/${filename}`,
    contents_url: `https://api.github.com/repos/octo-org/reviewphin/contents/${filename}`,
    patch: "@@ -1 +1 @@",
  };
}

function createIssueComment() {
  return {
    id: 1,
    body: "Issue comment",
    html_url: "https://github.com/octo-org/reviewphin/pull/42#issuecomment-1",
    user: { id: 10, login: "octocat", type: "User" },
    created_at: "2026-06-11T00:00:00.000Z",
    updated_at: "2026-06-11T00:00:00.000Z",
  };
}

function createPullRequestReview() {
  return {
    id: 2,
    body: "Looks good",
    html_url:
      "https://github.com/octo-org/reviewphin/pull/42#pullrequestreview-2",
    user: { id: 11, login: "reviewer", type: "User" },
    state: "APPROVED",
    commit_id: "head-sha",
    submitted_at: "2026-06-11T00:00:00.000Z",
  };
}

function createReviewComment() {
  return {
    id: 3,
    body: "Inline comment",
    html_url: "https://github.com/octo-org/reviewphin/pull/42#discussion_r3",
    user: { id: 11, login: "reviewer", type: "User" },
    path: "src/runtime.ts",
    diff_hunk: "@@ -10,3 +10,4 @@",
    pull_request_review_id: 2,
    line: 12,
    side: "RIGHT",
    commit_id: "head-sha",
    original_commit_id: "head-sha",
    created_at: "2026-06-11T00:00:00.000Z",
    updated_at: "2026-06-11T00:00:00.000Z",
  };
}

function createReaction(content: "eyes" | "hooray") {
  return {
    id: 101,
    content,
    user: { id: 10, login: "reviewphin-octo[bot]", type: "Bot" },
    created_at: "2026-06-11T00:00:00.000Z",
  };
}

function createClientWithInstallationRequest(
  request: ReturnType<typeof vi.fn>,
) {
  return new GitHubClient({
    config: createReadyConfig(),
    createApp: () => ({
      octokit: { request: vi.fn() },
      getInstallationOctokit: vi.fn(async () => ({ request })),
    }),
  });
}
