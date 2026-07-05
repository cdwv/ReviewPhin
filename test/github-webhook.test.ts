import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { createLogger } from "../src/logger.js";
import type { GitHubApi } from "../src/platforms/github/client.js";
import { readyGitHubConnectionConfigSchema } from "../src/platforms/github/config.js";
import GitHubPlatform from "../src/platforms/github/platform.js";
import type {
  PlatformConnectionRecord,
  TenantRecord,
} from "../src/storage/contract/current.js";
import type { StorageHelpers } from "../src/storage/storage-helpers.js";
import { TenantRegistry } from "../src/tenants/tenant-registry.js";

const logger = createLogger("silent");
const repositoryId = 2468;
const installationId = 789;

describe("GitHub webhook resolution", () => {
  it("extracts typed delivery, event, action, installation, and repository context", () => {
    const platform = createPlatform(vi.fn(async () => true));
    const payload = createPayload();
    const request = createWebhookRequest(payload);

    expect(platform.parseWebhookPayload(payload, request)).toEqual({
      body: payload,
      deliveryId: "delivery-1",
      eventName: "check_run",
      action: "requested_action",
      installationId,
      repositoryId,
      requestedActionIdentifier: "run_review",
      checkRunId: 1357,
      checkRunHeadSha: "abc123",
      checkRunAppId: 123,
      pullRequestNumber: null,
      pullRequestHeadSha: null,
      issueIsPullRequest: false,
      commentId: null,
      commentBody: null,
      commentAuthorLogin: null,
      commentAuthorType: null,
      commentInReplyToId: null,
    });
  });

  it("accepts account-scoped GitHub App deliveries without repository context", async () => {
    const platform = createPlatform(vi.fn(async () => true));
    const payload = {
      action: "created",
      installation: { id: installationId },
      sender: { login: "octocat" },
    };
    const request = createWebhookRequest(payload, {
      eventName: "installation",
    });
    const parsed = platform.parseWebhookPayload(payload, request);

    expect(parsed).toMatchObject({
      deliveryId: "delivery-1",
      eventName: "installation",
      action: "created",
      installationId,
      repositoryId: null,
    });

    const pingPayload = {
      zen: "Keep it logically awesome.",
      hook: { id: 123 },
      sender: { login: "octocat" },
    };
    const parsedPing = platform.parseWebhookPayload(
      pingPayload,
      createWebhookRequest(pingPayload, {
        eventName: "ping",
      }),
    );
    expect(parsedPing).toMatchObject({
      eventName: "ping",
      action: null,
      installationId: null,
      repositoryId: null,
    });

    expect(platform.identifyTenantKey(parsed)).toBeNull();
    expect(platform.shouldIgnoreWebhookWithoutTenant(parsed)).toBe(true);

    const app = await createApp({
      logger,
      tenantRegistry: {
        resolveWebhookTenant: vi.fn(async () => null),
      } as never,
      reviewWorker: {
        classifyWebhookTrigger: vi.fn(),
        createInteractionJobFromWebhook: vi.fn(),
      } as never,
      queue: { enqueue: vi.fn() } as never,
      platforms: [platform],
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "x-github-delivery": "delivery-1",
        "x-github-event": "installation",
        "x-hub-signature-256": "sha256=signature",
      },
      payload,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      accepted: false,
      reason: "no-trigger",
    });
    await app.close();
  });

  it("resolves by repository tenant key and authenticates with the raw body", async () => {
    const verify = vi.fn(async () => true);
    const platform = createPlatform(verify);
    const tenant = createTenant();
    const connection = createConnection();
    const registry = createRegistry({ tenant, connection });
    const body = createPayload();
    const request = createWebhookRequest(body);
    const parsed = platform.parseWebhookPayload(body, request);

    await expect(
      registry.resolveWebhookTenant(platform, parsed, request),
    ).resolves.toEqual({ tenant, connection });
    expect(verify).toHaveBeenCalledWith(
      request.rawBody.toString("utf8"),
      "sha256=signature",
    );
  });

  it("rejects invalid signatures before accepting installation context", async () => {
    const verify = vi.fn(async () => false);
    const platform = createPlatform(verify);
    const registry = createRegistry({
      tenant: createTenant(),
      connection: createConnection({
        installationId: installationId + 1,
      }),
    });
    const body = createPayload();
    const request = createWebhookRequest(body);

    await expect(
      registry.resolveWebhookTenant(
        platform,
        platform.parseWebhookPayload(body, request),
        request,
      ),
    ).resolves.toBeNull();
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("rejects mismatched installations after signature verification", async () => {
    const verify = vi.fn(async () => true);
    const platform = createPlatform(verify);
    const registry = createRegistry({
      tenant: createTenant(),
      connection: createConnection({
        installationId: installationId + 1,
      }),
    });
    const body = createPayload();
    const request = createWebhookRequest(body);

    await expect(
      registry.resolveWebhookTenant(
        platform,
        platform.parseWebhookPayload(body, request),
        request,
      ),
    ).resolves.toBeNull();
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("rejects mismatched canonical repository metadata", async () => {
    const verify = vi.fn(async () => true);
    const platform = createPlatform(verify);
    const registry = createRegistry({
      tenant: createTenant({ configRepositoryId: repositoryId + 1 }),
      connection: createConnection(),
    });
    const body = createPayload();
    const request = createWebhookRequest(body);

    await expect(
      registry.resolveWebhookTenant(
        platform,
        platform.parseWebhookPayload(body, request),
        request,
      ),
    ).resolves.toBeNull();
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("rejects missing signatures, unknown tenants, and non-ready connections", async () => {
    const verify = vi.fn(async () => true);
    const platform = createPlatform(verify);
    const body = createPayload();
    const unsignedRequest = createWebhookRequest(body, {
      signature: undefined,
    });
    const parsed = platform.parseWebhookPayload(body, unsignedRequest);

    await expect(
      createRegistry({
        tenant: createTenant(),
        connection: createConnection(),
      }).resolveWebhookTenant(platform, parsed, unsignedRequest),
    ).resolves.toBeNull();
    await expect(
      createRegistry({
        tenant: null,
        connection: createConnection(),
      }).resolveWebhookTenant(platform, parsed, createWebhookRequest(body)),
    ).resolves.toBeNull();
    await expect(
      createRegistry({
        tenant: createTenant(),
        connection: {
          ...createConnection(),
          status: "setup_required",
        },
      }).resolveWebhookTenant(platform, parsed, createWebhookRequest(body)),
    ).resolves.toBeNull();
    expect(verify).not.toHaveBeenCalled();
  });

  it("rejects malformed persisted connection config without throwing", async () => {
    const platform = createPlatform(vi.fn(async () => true));
    const request = createWebhookRequest(createPayload());
    await expect(
      platform.isWebhookRequestAuthorized(
        {
          tenant: createTenant(),
          connection: {
            ...createConnection(),
            platformConnectionConfigJson: "{malformed",
          },
        },
        request,
      ),
    ).resolves.toBe(false);
  });

  it("returns the Fastify no-trigger response without creating a job", async () => {
    const platform = createPlatform(vi.fn(async () => true));
    const createInteractionJobFromWebhook = vi.fn();
    const app = await createApp({
      logger,
      tenantRegistry: {
        resolveWebhookTenant: vi.fn(async () => ({
          tenant: createTenant(),
          connection: createConnection(),
        })),
      } as never,
      reviewWorker: {
        classifyWebhookTrigger: vi.fn(async () => null),
        createInteractionJobFromWebhook,
      } as never,
      queue: { enqueue: vi.fn() } as never,
      platforms: [platform],
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "x-github-delivery": "delivery-1",
        "x-github-event": "check_run",
        "x-hub-signature-256": "sha256=signature",
      },
      payload: createPayload(),
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      accepted: false,
      reason: "no-trigger",
    });
    expect(createInteractionJobFromWebhook).not.toHaveBeenCalled();
    await app.close();
  });

  it("provisions a manual Check Run for pull request events without creating a job", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: { check_runs: [] } })
      .mockResolvedValueOnce({
        data: {
          id: 24680,
          head_sha: "new-head",
          external_id: "reviewphin:pull-request:42",
          app: { id: 123 },
        },
      });
    const platform = createPlatform(
      vi.fn(async () => true),
      request,
    );
    const createInteractionJobFromWebhook = vi.fn();
    const app = await createApp({
      logger,
      tenantRegistry: {
        resolveWebhookTenant: vi.fn(async () => ({
          tenant: createTenant(),
          connection: createConnection(),
        })),
      } as never,
      reviewWorker: {
        classifyWebhookTrigger: vi.fn(async () => null),
        createInteractionJobFromWebhook,
      } as never,
      queue: { enqueue: vi.fn() } as never,
      platforms: [platform],
    });
    const payload = createPullRequestPayload("opened", "new-head");

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "x-github-delivery": "delivery-pr-1",
        "x-github-event": "pull_request",
        "x-hub-signature-256": "sha256=signature",
      },
      payload,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      accepted: true,
      reason: "event-handled",
    });
    expect(request).toHaveBeenNthCalledWith(
      1,
      "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
      expect.objectContaining({
        ref: "new-head",
        check_name: "ReviewPhin",
        app_id: 123,
      }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "POST /repos/{owner}/{repo}/check-runs",
      expect.objectContaining({
        name: "ReviewPhin",
        head_sha: "new-head",
        external_id: "reviewphin:pull-request:42",
        status: "completed",
        conclusion: "neutral",
        actions: [
          expect.objectContaining({
            identifier: "run_review",
          }),
        ],
      }),
    );
    expect(createInteractionJobFromWebhook).not.toHaveBeenCalled();
    await app.close();
  });

  it("accepts only the ReviewPhin requested action from its own Check Run", async () => {
    const platform = createPlatform(vi.fn(async () => true));
    const resolvedTenant = {
      tenant: createTenant(),
      connection: createConnection(),
    };
    const payload = createPayload();
    const parsed = platform.parseWebhookPayload(
      payload,
      createWebhookRequest(payload),
    );

    await expect(
      platform.classifyWebhookTrigger(resolvedTenant, parsed),
    ).resolves.toEqual({
      kind: "check-run-requested-action",
      checkRunId: 1357,
      actionIdentifier: "run_review",
    });
    await expect(
      platform.classifyWebhookTrigger(resolvedTenant, {
        ...parsed,
        requestedActionIdentifier: "unknown",
      }),
    ).resolves.toBeNull();
    await expect(
      platform.classifyWebhookTrigger(resolvedTenant, {
        ...parsed,
        checkRunAppId: 999,
      }),
    ).resolves.toBeNull();
  });

  it("accepts slash commands and mentions in pull request issue comments", async () => {
    const platform = createPlatform(vi.fn(async () => true));
    const resolvedTenant = {
      tenant: createTenant(),
      connection: createConnection(),
    };

    for (const body of [
      "/reviewphin review",
      "@reviewphin review the latest changes",
      "@reviewphin-octo-org review",
    ]) {
      const webhookBody = createIssueCommentPayload(body);
      const parsed = platform.parseWebhookPayload(
        webhookBody,
        createWebhookRequest(webhookBody, {
          eventName: "issue_comment",
        }),
      );
      await expect(
        platform.classifyWebhookTrigger(resolvedTenant, parsed),
      ).resolves.toEqual({
        kind: "direct-mention",
        comment: {
          kind: "code-review-comment",
          commentId: 555,
        },
      });
    }
  });

  it("ignores ordinary issue comments, non-pull-request issues, and its own bot", async () => {
    const platform = createPlatform(vi.fn(async () => true));
    const resolvedTenant = {
      tenant: createTenant(),
      connection: createConnection(),
    };
    const payloads = [
      createIssueCommentPayload("ordinary comment"),
      createIssueCommentPayload("/reviewphin review", {
        pullRequest: false,
      }),
      createIssueCommentPayload("/reviewphin review", {
        authorLogin: "reviewphin-octo-org[bot]",
        authorType: "Bot",
      }),
    ];

    for (const webhookBody of payloads) {
      const parsed = platform.parseWebhookPayload(
        webhookBody,
        createWebhookRequest(webhookBody, {
          eventName: "issue_comment",
        }),
      );
      await expect(
        platform.classifyWebhookTrigger(resolvedTenant, parsed),
      ).resolves.toBeNull();
    }
  });

  it("treats replies to ReviewPhin inline findings as follow-up triggers", async () => {
    const request = vi.fn(async (route: string) => {
      expect(route).toBe(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
      );
      return {
        data: [
          createReviewComment(444, {
            body: "**Finding**\n\nBody\n\n<!-- reviewphin-finding:key -->",
            login: "reviewphin-octo-org[bot]",
            type: "Bot",
          }),
          createReviewComment(555, {
            body: "Can you explain?",
            login: "octocat",
            inReplyToId: 444,
          }),
        ],
      };
    });
    const platform = createPlatform(
      vi.fn(async () => true),
      request,
    );
    const resolvedTenant = {
      tenant: createTenant(),
      connection: createConnection(),
    };
    const webhookBody = createReviewCommentPayload("Can you explain?");
    const parsed = platform.parseWebhookPayload(
      webhookBody,
      createWebhookRequest(webhookBody, {
        eventName: "pull_request_review_comment",
      }),
    );

    await expect(
      platform.classifyWebhookTrigger(resolvedTenant, parsed),
    ).resolves.toEqual({
      kind: "follow-up-comment",
      comment: {
        kind: "discussion-comment",
        discussionId: "review-comment:444",
        commentId: 555,
      },
    });
  });

  it("ignores inline replies when the parent review comment has no author", async () => {
    const request = vi.fn(async (route: string) => {
      expect(route).toBe(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
      );
      return {
        data: [
          createReviewComment(444, {
            body: "**Finding**\n\nBody\n\n<!-- reviewphin-finding:key -->",
            login: null,
          }),
          createReviewComment(555, {
            body: "Can you explain?",
            login: "octocat",
            inReplyToId: 444,
          }),
        ],
      };
    });
    const platform = createPlatform(
      vi.fn(async () => true),
      request,
    );
    const resolvedTenant = {
      tenant: createTenant(),
      connection: createConnection(),
    };
    const webhookBody = createReviewCommentPayload("Can you explain?");
    const parsed = platform.parseWebhookPayload(
      webhookBody,
      createWebhookRequest(webhookBody, {
        eventName: "pull_request_review_comment",
      }),
    );

    await expect(
      platform.classifyWebhookTrigger(resolvedTenant, parsed),
    ).resolves.toBeNull();
  });

  it("ignores third-party bot replies to ReviewPhin inline findings", async () => {
    const request = vi.fn(async (route: string) => {
      expect(route).toBe(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
      );
      return {
        data: [
          createReviewComment(444, {
            body: "**Finding**\n\nBody\n\n<!-- reviewphin-finding:key -->",
            login: "reviewphin-octo-org[bot]",
            type: "Bot",
          }),
          createReviewComment(555, {
            body: "Automated dependency update note",
            login: "dependabot[bot]",
            type: "Bot",
            inReplyToId: 444,
          }),
        ],
      };
    });
    const platform = createPlatform(
      vi.fn(async () => true),
      request,
    );
    const resolvedTenant = {
      tenant: createTenant(),
      connection: createConnection(),
    };
    const webhookBody = createReviewCommentPayload(
      "Automated dependency update note",
      {
        authorLogin: "dependabot[bot]",
        authorType: "User",
      },
    );
    const parsed = platform.parseWebhookPayload(
      webhookBody,
      createWebhookRequest(webhookBody, {
        eventName: "pull_request_review_comment",
      }),
    );

    await expect(
      platform.classifyWebhookTrigger(resolvedTenant, parsed),
    ).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("creates deduplicated comment jobs against the current pull request head", async () => {
    const request = vi.fn(
      async (route: string, _parameters: Record<string, unknown>) => {
        if (route === "GET /repositories/{repository_id}") {
          return {
            data: {
              id: repositoryId,
              name: "reviewphin",
              full_name: "octo-org/reviewphin",
              private: true,
              html_url: "https://github.com/octo-org/reviewphin",
              owner: {
                login: "octo-org",
                id: 456,
                type: "Organization",
              },
            },
          };
        }
        expect(route).toBe("GET /repos/{owner}/{repo}/pulls/{pull_number}");
        return {
          data: {
            number: 42,
            title: "Feature",
            body: null,
            html_url: "https://github.com/octo-org/reviewphin/pull/42",
            user: { login: "octocat" },
            head: { sha: "current-head", ref: "feature" },
            base: { sha: "base-head", ref: "main" },
          },
        };
      },
    );
    const platform = createPlatform(
      vi.fn(async () => true),
      request,
    );
    const patch = vi.fn(async () => undefined);
    const storage = {
      stores: { tenants: { patch } },
    } as unknown as StorageHelpers;
    const resolvedTenant = {
      tenant: createTenant(),
      connection: createConnection(),
    };
    const webhookBody = createIssueCommentPayload("/reviewphin review");
    const parsed = platform.parseWebhookPayload(
      webhookBody,
      createWebhookRequest(webhookBody, {
        eventName: "issue_comment",
      }),
    );
    const trigger = await platform.classifyWebhookTrigger(
      resolvedTenant,
      parsed,
    );

    const job = await platform.createInteractionJob({
      resolvedTenant,
      payload: parsed,
      trigger: trigger!,
      storage,
    });

    expect(job).toMatchObject({
      codeReviewId: 42,
      commentId: 555,
      headSha: "current-head",
    });
    expect(JSON.parse(job.triggerJson)).toMatchObject({
      kind: "github-comment",
      eventName: "issue_comment",
      triggerKind: "direct-mention",
      commentId: 555,
      instruction: "review",
      comment: {
        kind: "code-review-comment",
        commentId: 555,
      },
    });
  });

  it("persists the root review comment target for GitHub follow-up jobs", async () => {
    const request = vi.fn(
      async (route: string, _parameters: Record<string, unknown>) => {
        if (
          route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments"
        ) {
          return {
            data: [
              createReviewComment(444, {
                body: "<!-- reviewphin-finding:finding-1 -->\nFinding",
                login: "reviewphin-octo-org[bot]",
                type: "Bot",
              }),
              createReviewComment(555, {
                body: "Can you explain?",
                login: "octocat",
                inReplyToId: 444,
              }),
            ],
          };
        }
        if (route === "GET /repositories/{repository_id}") {
          return {
            data: {
              id: repositoryId,
              name: "reviewphin",
              full_name: "octo-org/reviewphin",
              private: true,
              html_url: "https://github.com/octo-org/reviewphin",
              owner: {
                login: "octo-org",
                id: 456,
                type: "Organization",
              },
            },
          };
        }
        expect(route).toBe("GET /repos/{owner}/{repo}/pulls/{pull_number}");
        return {
          data: {
            number: 42,
            title: "Feature",
            body: null,
            html_url: "https://github.com/octo-org/reviewphin/pull/42",
            user: { login: "octocat" },
            head: { sha: "current-head", ref: "feature" },
            base: { sha: "base-head", ref: "main" },
          },
        };
      },
    );
    const platform = createPlatform(
      vi.fn(async () => true),
      request,
    );
    const storage = {
      stores: { tenants: { patch: vi.fn(async () => undefined) } },
    } as unknown as StorageHelpers;
    const resolvedTenant = {
      tenant: createTenant(),
      connection: createConnection(),
    };
    const webhookBody = createReviewCommentPayload("Can you explain?");
    const parsed = platform.parseWebhookPayload(
      webhookBody,
      createWebhookRequest(webhookBody, {
        eventName: "pull_request_review_comment",
      }),
    );
    const trigger = await platform.classifyWebhookTrigger(
      resolvedTenant,
      parsed,
    );

    const job = await platform.createInteractionJob({
      resolvedTenant,
      payload: parsed,
      trigger: trigger!,
      storage,
    });

    expect(JSON.parse(job.triggerJson)).toMatchObject({
      kind: "github-comment",
      triggerKind: "follow-up-comment",
      commentId: 555,
      instruction: "Can you explain?",
      comment: {
        kind: "discussion-comment",
        discussionId: "review-comment:444",
        commentId: 555,
      },
    });
  });

  it("creates a commentless deduplicated job from the canonical Check Run pull request", async () => {
    const request = vi.fn(
      async (route: string, parameters: Record<string, unknown>) => {
        if (route === "GET /repositories/{repository_id}") {
          return {
            data: {
              id: repositoryId,
              name: "reviewphin-renamed",
              full_name: "new-owner/reviewphin-renamed",
              private: true,
              html_url: "https://github.com/new-owner/reviewphin-renamed",
              owner: {
                login: "new-owner",
                id: 999,
                type: "Organization",
              },
            },
          };
        }
        if (route.includes("check-runs")) {
          expect(parameters).toMatchObject({
            owner: "new-owner",
            repo: "reviewphin-renamed",
          });
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
      },
    );
    const platform = createPlatform(
      vi.fn(async () => true),
      request,
    );
    const patch = vi.fn(async () => undefined);
    const storage = {
      stores: { tenants: { patch } },
    } as unknown as StorageHelpers;
    const resolvedTenant = {
      tenant: createTenant(),
      connection: createConnection(),
    };
    const payload = createPayload();
    const parsed = platform.parseWebhookPayload(
      payload,
      createWebhookRequest(payload),
    );
    const trigger = await platform.classifyWebhookTrigger(
      resolvedTenant,
      parsed,
    );
    expect(trigger).not.toBeNull();

    const first = await platform.createInteractionJob({
      resolvedTenant,
      payload: parsed,
      trigger: trigger!,
      storage,
    });
    const second = await platform.createInteractionJob({
      resolvedTenant,
      payload: parsed,
      trigger: trigger!,
      storage,
    });

    expect(first).toMatchObject({
      codeReviewId: 42,
      commentId: null,
      headSha: "abc123",
    });
    expect(JSON.parse(first.triggerJson)).toEqual({
      kind: "github-check-run",
      deliveryId: "delivery-1",
      checkRunId: 1357,
      actionIdentifier: "run_review",
      repositoryId,
    });
    expect(second.dedupeKey).toBe(first.dedupeKey);
    expect(patch).toHaveBeenCalledTimes(1);
  });
});

function createPlatform(
  verify: (payload: string, signature: string) => Promise<boolean>,
  request: GitHubApi["request"] = vi.fn(),
): GitHubPlatform {
  return new GitHubPlatform({
    logger,
    publicUrl: "https://review.example.com",
    createApp: () => ({
      octokit: { request: vi.fn() },
      webhooks: { verify },
      getInstallationOctokit: vi.fn(async () => ({ request })),
    }),
  });
}

function createPayload() {
  return {
    action: "requested_action",
    installation: {
      id: installationId,
    },
    repository: {
      id: repositoryId,
      full_name: "octo-org/reviewphin",
    },
    requested_action: {
      identifier: "run_review",
    },
    check_run: {
      id: 1357,
      head_sha: "abc123",
      app: {
        id: 123,
      },
    },
  };
}

function createPullRequestPayload(action: string, headSha: string) {
  return {
    action,
    installation: {
      id: installationId,
    },
    repository: {
      id: repositoryId,
      full_name: "octo-org/reviewphin",
    },
    pull_request: {
      number: 42,
      head: {
        sha: headSha,
      },
    },
  };
}

function createIssueCommentPayload(
  body: string,
  options: {
    pullRequest?: boolean;
    authorLogin?: string;
    authorType?: string;
  } = {},
) {
  return {
    action: "created",
    installation: { id: installationId },
    repository: {
      id: repositoryId,
      full_name: "octo-org/reviewphin",
    },
    issue: {
      number: 42,
      ...(options.pullRequest === false
        ? {}
        : { pull_request: { url: "https://api.github.com/pulls/42" } }),
    },
    comment: {
      id: 555,
      body,
      user: {
        id: 77,
        login: options.authorLogin ?? "octocat",
        type: options.authorType ?? "User",
      },
    },
  };
}

function createReviewCommentPayload(
  body: string,
  options: {
    authorLogin?: string;
    authorType?: string;
  } = {},
) {
  return {
    action: "created",
    installation: { id: installationId },
    repository: {
      id: repositoryId,
      full_name: "octo-org/reviewphin",
    },
    pull_request: {
      number: 42,
      head: { sha: "current-head" },
    },
    comment: {
      id: 555,
      body,
      in_reply_to_id: 444,
      user: {
        id: 77,
        login: options.authorLogin ?? "octocat",
        type: options.authorType ?? "User",
      },
    },
  };
}

function createReviewComment(
  id: number,
  options: {
    body: string;
    login: string | null;
    type?: string;
    inReplyToId?: number;
  },
) {
  return {
    id,
    body: options.body,
    html_url: `https://github.com/octo-org/reviewphin/pull/42#discussion_r${id}`,
    user:
      options.login === null
        ? null
        : {
            id,
            login: options.login,
            type: options.type ?? "User",
          },
    path: "src/index.ts",
    diff_hunk: "@@ -1 +1 @@",
    pull_request_review_id: 99,
    ...(options.inReplyToId ? { in_reply_to_id: options.inReplyToId } : {}),
    line: 1,
    original_line: 1,
    side: "RIGHT",
    commit_id: "current-head",
    original_commit_id: "base-head",
    created_at: "2026-06-14T00:00:00.000Z",
    updated_at: "2026-06-14T00:00:00.000Z",
  };
}

function createWebhookRequest(
  body: unknown,
  options: {
    signature?: string | undefined;
    eventName?: string | undefined;
  } = {
    signature: "sha256=signature",
  },
) {
  const headers: Record<string, string> = {
    "x-github-delivery": "delivery-1",
    "x-github-event": options.eventName ?? "check_run",
  };
  if (options.signature) {
    headers["x-hub-signature-256"] = options.signature;
  }
  return {
    headers,
    body,
    rawBody: Buffer.from(JSON.stringify(body)),
    pathSuffix: "",
  };
}

function createTenant(
  options: { configRepositoryId?: number } = {},
): TenantRecord {
  return {
    id: "tenant-github",
    key: `https://api.github.com::${repositoryId}`,
    platform: "github",
    platformConnectionId: "connection-github",
    platformConfigJson: JSON.stringify({
      repositoryId: options.configRepositoryId ?? repositoryId,
      repositoryFullName: "octo-org/reviewphin",
    }),
    modelProfileName: null,
    createdAt: "2026-06-11T00:00:00.000Z",
    updatedAt: "2026-06-11T00:00:00.000Z",
  };
}

function createConnection(
  options: { installationId?: number } = {},
): PlatformConnectionRecord {
  return {
    id: "connection-github",
    name: "github-main",
    platform: "github",
    status: "ready",
    platformConnectionConfigJson: JSON.stringify(
      readyGitHubConnectionConfigSchema.parse({
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
        installationId: options.installationId ?? installationId,
        installationAccountLogin: "octo-org",
        installationAccountId: 456,
        installationAccountType: "Organization",
        repositorySelection: "selected",
        accessibleRepositoryCount: 1,
      }),
    ),
    createdAt: "2026-06-11T00:00:00.000Z",
    updatedAt: "2026-06-11T00:00:00.000Z",
  };
}

function createRegistry(input: {
  tenant: TenantRecord | null;
  connection: PlatformConnectionRecord;
}): TenantRegistry {
  const tenant = input.tenant;
  return new TenantRegistry({
    storage: {
      stores: {
        tenants: {
          find: vi.fn(async (filters) =>
            tenant &&
            tenant.key === filters.key?.eq &&
            tenant.platform === filters.platform?.eq
              ? tenant
              : null,
          ),
        },
        platformConnections: {
          get: vi.fn(async (id) =>
            id === input.connection.id ? input.connection : null,
          ),
        },
      },
    } as never,
  });
}
