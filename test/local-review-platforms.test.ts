import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "../src/logger.js";
import GitHubPlatform from "../src/platforms/github/platform.js";
import GitLabPlatform from "../src/platforms/gitlab/platform.js";
import { GitLabTriggerLifecycle } from "../src/platforms/gitlab/trigger-lifecycle.js";
import { NoOpPlatformTriggerLifecycle } from "../src/platforms/trigger-lifecycle.js";
import type { ResolvedTenant } from "../src/platforms/IPlatform.js";
import type {
  InteractionJobRecord,
  PlatformConnectionRecord,
  TenantRecord,
} from "../src/storage/contract/index.js";
import {
  createGitLabConnectionRecord,
  createGitLabTenantRecord,
} from "./helpers/gitlab-tenant.js";

const logger = createLogger("silent");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("platform local review jobs", () => {
  it("reconstructs GitLab comments with canonical dedupe and native lifecycle", async () => {
    stubGitLabApi({ noteBody: "@review-bot review this" });
    const platform = new GitLabPlatform(logger);
    const resolvedTenant = createGitLabResolvedTenant();
    const baseInput = {
      resolvedTenant,
      storage: {} as never,
      selector: {
        kind: "comment-url" as const,
        url: "https://gitlab.example.com/group/project/-/merge_requests/7#note_91",
      },
      createdAt: "2026-07-12T10:00:00.000Z",
    };

    const first = await platform.createLocalInteractionJob({
      ...baseInput,
      forceNew: false,
      requestId: "request-1",
    });
    const repeated = await platform.createLocalInteractionJob({
      ...baseInput,
      forceNew: false,
      requestId: "request-2",
    });
    const forced = await platform.createLocalInteractionJob({
      ...baseInput,
      forceNew: true,
      requestId: "request-3",
    });

    expect(repeated.dedupeKey).toBe(first.dedupeKey);
    expect(forced.dedupeKey).not.toBe(first.dedupeKey);
    expect(first).toMatchObject({
      codeReviewId: 7,
      commentId: 91,
      headSha: "head-sha",
    });
    expect(JSON.parse(first.triggerJson)).toMatchObject({
      kind: "gitlab-comment",
    });
    expect(
      platform.createTriggerLifecycle({
        resolvedTenant,
        job: createJob(first),
        logger,
      }),
    ).toBeInstanceOf(GitLabTriggerLifecycle);
  });

  it("rejects GitLab tenant mismatches and unrecognized comments clearly", async () => {
    stubGitLabApi({ noteBody: "ordinary comment" });
    const platform = new GitLabPlatform(logger);
    const input = {
      resolvedTenant: createGitLabResolvedTenant(),
      storage: {} as never,
      forceNew: false,
      requestId: "request-1",
      createdAt: "2026-07-12T10:00:00.000Z",
    };

    await expect(
      platform.createLocalInteractionJob({
        ...input,
        selector: {
          kind: "comment-url",
          url: "https://other.example.com/group/project/-/merge_requests/7#note_91",
        },
      }),
    ).rejects.toThrow("does not match the resolved tenant connection");
    await expect(
      platform.createLocalInteractionJob({
        ...input,
        selector: {
          kind: "comment-id",
          commentId: 91,
          codeReviewId: 7,
        },
      }),
    ).rejects.toThrow("not a recognized ReviewPhin review trigger");
  });

  it("creates fresh GitLab and GitHub text jobs with no-op lifecycle", async () => {
    stubGitLabApi({ noteBody: "" });
    const gitlab = new GitLabPlatform(logger);
    const gitlabTenant = createGitLabResolvedTenant();
    const gitlabFirst = await gitlab.createLocalInteractionJob({
      resolvedTenant: gitlabTenant,
      storage: {} as never,
      selector: { kind: "text", text: "Review auth.", codeReviewId: 7 },
      forceNew: false,
      requestId: "request-1",
      createdAt: "2026-07-12T10:00:00.000Z",
    });
    const gitlabSecond = await gitlab.createLocalInteractionJob({
      resolvedTenant: gitlabTenant,
      storage: {} as never,
      selector: { kind: "text", text: "Review auth.", codeReviewId: 7 },
      forceNew: false,
      requestId: "request-2",
      createdAt: "2026-07-12T10:00:01.000Z",
    });
    expect(gitlabSecond.dedupeKey).not.toBe(gitlabFirst.dedupeKey);
    expect(gitlabFirst.triggerJson).toBe(gitlabFirst.payloadJson);
    expect(
      gitlab.createTriggerLifecycle({
        resolvedTenant: gitlabTenant,
        job: createJob(gitlabFirst),
        logger,
      }),
    ).toBeInstanceOf(NoOpPlatformTriggerLifecycle);

    const githubTenant = createGitHubResolvedTenant();
    const github = createGitHubPlatform();
    const githubFirst = await github.createLocalInteractionJob({
      resolvedTenant: githubTenant,
      storage: {} as never,
      selector: { kind: "text", text: "Review auth.", codeReviewId: 42 },
      forceNew: false,
      requestId: "request-1",
      createdAt: "2026-07-12T10:00:00.000Z",
    });
    const githubSecond = await github.createLocalInteractionJob({
      resolvedTenant: githubTenant,
      storage: {} as never,
      selector: { kind: "text", text: "Review auth.", codeReviewId: 42 },
      forceNew: true,
      requestId: "request-2",
      createdAt: "2026-07-12T10:00:01.000Z",
    });
    expect(githubSecond.dedupeKey).not.toBe(githubFirst.dedupeKey);
    expect(githubFirst.triggerJson).toBe(githubFirst.payloadJson);
    expect(
      github.createTriggerLifecycle({
        resolvedTenant: githubTenant,
        job: createJob(githubFirst),
      }),
    ).toBeInstanceOf(NoOpPlatformTriggerLifecycle);
  });

  it("rejects GitHub URL repository and explicit pull request mismatches", async () => {
    const platform = createGitHubPlatform();
    const input = {
      resolvedTenant: createGitHubResolvedTenant(),
      storage: {} as never,
      forceNew: false,
      requestId: "request-1",
      createdAt: "2026-07-12T10:00:00.000Z",
    };

    await expect(
      platform.createLocalInteractionJob({
        ...input,
        selector: {
          kind: "comment-url",
          url: "https://github.com/other/repository/pull/42#issuecomment-91",
        },
      }),
    ).rejects.toThrow("repository does not match the resolved tenant");
    await expect(
      platform.createLocalInteractionJob({
        ...input,
        selector: {
          kind: "comment-url",
          url: "https://github.com/octo-org/reviewphin/pull/42#issuecomment-91",
          codeReviewId: 43,
        },
      }),
    ).rejects.toThrow("does not match GitHub comment URL pull request 42");
  });
});

function stubGitLabApi(options: { noteBody: string }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: string | URL | Request) => {
      const url = new URL(
        typeof request === "string"
          ? request
          : request instanceof URL
            ? request.toString()
            : request.url,
      );
      if (url.pathname.endsWith("/projects/123")) {
        return jsonResponse({
          id: 123,
          web_url: "https://gitlab.example.com/group/project",
          path_with_namespace: "group/project",
          http_url_to_repo: "https://gitlab.example.com/group/project.git",
        });
      }
      if (url.pathname.endsWith("/merge_requests/7")) {
        return jsonResponse({
          id: 700,
          iid: 7,
          project_id: 123,
          title: "Local review",
          description: "",
          web_url:
            "https://gitlab.example.com/group/project/-/merge_requests/7",
          source_branch: "feature",
          target_branch: "main",
          author: { id: 1, username: "developer", name: "Developer" },
          diff_refs: {
            base_sha: "base-sha",
            start_sha: "start-sha",
            head_sha: "head-sha",
          },
        });
      }
      if (url.pathname.endsWith("/merge_requests/7/versions")) {
        return jsonResponse([]);
      }
      if (url.pathname.endsWith("/merge_requests/7/notes")) {
        return jsonResponse([
          {
            id: 91,
            body: options.noteBody,
            author: { id: 1, username: "developer", name: "Developer" },
            created_at: "2026-07-12T09:00:00.000Z",
            updated_at: "2026-07-12T09:00:00.000Z",
            system: false,
          },
        ]);
      }
      if (url.pathname.endsWith("/merge_requests/7/discussions")) {
        return jsonResponse([]);
      }
      return new Response("not found", { status: 404 });
    }),
  );
}

function createGitLabResolvedTenant(): ResolvedTenant {
  return {
    tenant: createGitLabTenantRecord(),
    connection: createGitLabConnectionRecord(),
  };
}

function createGitHubPlatform(): GitHubPlatform {
  const request = vi.fn(async (route: string) => {
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
      return {
        data: {
          number: 42,
          title: "Local review",
          body: "",
          html_url: "https://github.com/octo-org/reviewphin/pull/42",
          user: { login: "developer" },
          head: { sha: "head-sha", ref: "feature" },
          base: { sha: "base-sha", ref: "main" },
        },
      };
    }
    throw new Error(`Unexpected GitHub route: ${route}`);
  });
  return new GitHubPlatform({
    logger,
    publicUrl: "https://review.example.com",
    createApp: () => ({
      octokit: { request: vi.fn() },
      getInstallationOctokit: vi.fn(async () => ({ request })),
    }),
  });
}

function createGitHubResolvedTenant(): ResolvedTenant {
  const tenant: TenantRecord = {
    id: "tenant-github",
    key: "https://api.github.com::987",
    platform: "github",
    platformConnectionId: "connection-github",
    platformConfigJson: JSON.stringify({
      repositoryId: 987,
      repositoryFullName: "octo-org/reviewphin",
    }),
    modelProfileName: null,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
  const connection: PlatformConnectionRecord = {
    id: "connection-github",
    name: "github",
    platform: "github",
    status: "ready",
    platformConnectionConfigJson: JSON.stringify({
      owner: "octo-org",
      apiUrl: "https://api.github.com",
      appId: 123,
      appSlug: "reviewphin-octo-org",
      appName: "ReviewPhin",
      clientId: "Iv1.client",
      clientSecret: "secret",
      webhookSecret: "secret",
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
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
  return { tenant, connection };
}

function createJob(input: {
  dedupeKey: string;
  codeReviewId: number;
  commentId: number | null;
  triggerJson: string;
  headSha: string;
  payloadJson: string;
}): InteractionJobRecord {
  return {
    id: "job-1",
    tenantId: "tenant-1",
    ...input,
    status: "queued",
    retryCount: 0,
    lastError: null,
    enqueuedAt: "2026-07-12T10:00:00.000Z",
    availableAt: "2026-07-12T10:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    claimToken: null,
    claimedBy: null,
    claimExpiresAt: null,
    latestInteractionRunId: null,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-next-page": "",
    },
  });
}
