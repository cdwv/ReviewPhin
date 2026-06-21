import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";
import { createLogger } from "../src/logger.js";
import { readyGitHubConnectionConfigSchema } from "../src/platforms/github/config.js";
import GitHubPlatform from "../src/platforms/github/platform.js";
import {
  getGitHubTenantConfig,
  githubTenantConfigSchema,
  githubTenantRegistrationSchema,
} from "../src/platforms/github/tenant-config.js";
import type {
  PlatformConnectionRecord,
  TenantRecord,
} from "../src/storage/contract/current.js";

const logger = createLogger("silent");

describe("GitHub tenant registration", () => {
  it("accepts owner/repository and replaces it with canonical API metadata", async () => {
    const request = vi.fn(async (route: string) => ({
      data: route === "GET /repos/{owner}/{repo}" ? createRepository() : [],
    }));
    const platform = createPlatform(request);
    const connection = createConnection();
    const tenantConfig: Record<string, unknown> =
      githubTenantRegistrationSchema.parse({
        repository: "octo-org/original-name",
      });

    await platform.onBeforeAddTenant(tenantConfig, connection);

    expect(request).toHaveBeenCalledWith("GET /repos/{owner}/{repo}", {
      owner: "octo-org",
      repo: "original-name",
    });
    expect(tenantConfig).toEqual({
      repositoryId: 2468,
      repositoryFullName: "octo-org/renamed-repository",
    });
    expect(request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/pulls",
      expect.objectContaining({
        owner: "octo-org",
        repo: "renamed-repository",
        state: "open",
      }),
    );
    expect(platform.getTenantKey(tenantConfig, connection)).toBe(
      "https://api.github.com::2468",
    );
  });

  it("rejects non-ready connections before repository access", async () => {
    const request = vi.fn();
    const platform = createPlatform(request);
    const connection = {
      ...createConnection(),
      status: "setup_required" as const,
    };

    await expect(
      platform.onBeforeAddTenant(
        { repository: "octo-org/reviewphin" },
        connection,
      ),
    ).rejects.toThrow("Platform connection github-main is not ready");
    expect(request).not.toHaveBeenCalled();
  });

  it("provisions Run Review Check Runs for existing open pull requests", async () => {
    const request = vi.fn(
      async (route: string, parameters: Record<string, unknown>) => {
        if (route === "GET /repos/{owner}/{repo}") {
          return { data: createRepository() };
        }
        if (route === "GET /repos/{owner}/{repo}/pulls") {
          return {
            data: [
              createPullRequest(7, "head-seven"),
              createPullRequest(9, "head-nine"),
            ],
          };
        }
        if (route.includes("/commits/") && route.endsWith("/check-runs")) {
          return { data: { check_runs: [] } };
        }
        if (route === "POST /repos/{owner}/{repo}/check-runs") {
          return {
            data: {
              id: parameters.head_sha === "head-seven" ? 700 : 900,
              head_sha: parameters.head_sha,
              external_id: parameters.external_id,
              app: { id: 123 },
            },
          };
        }
        throw new Error(`Unexpected GitHub route ${route}`);
      },
    );
    const platform = createPlatform(request);
    const connection = createConnection();

    await platform.onBeforeAddTenant(
      { repository: "octo-org/original-name" },
      connection,
    );

    expect(
      request.mock.calls.filter(
        ([route]) => route === "POST /repos/{owner}/{repo}/check-runs",
      ),
    ).toHaveLength(2);
    expect(request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/check-runs",
      expect.objectContaining({
        head_sha: "head-seven",
        external_id: "reviewphin:pull-request:7",
      }),
    );
    expect(request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/check-runs",
      expect.objectContaining({
        head_sha: "head-nine",
        external_id: "reviewphin:pull-request:9",
      }),
    );
  });

  it("rejects setup-required connections through the tenant CLI", async () => {
    const databasePath = join(
      await mkdtemp(join(tmpdir(), "reviewphin-github-tenant-")),
      "storage.sqlite",
    );
    await runCli([
      "platform",
      "connection",
      "add",
      "--platform",
      "github",
      "--name",
      "github-main",
      "--owner",
      "octo-org",
      "--sqlite-database-path",
      databasePath,
    ]);

    await expect(
      runCli([
        "tenant",
        "add",
        "--platform",
        "github",
        "--connection",
        "github-main",
        "--repository",
        "octo-org/reviewphin",
        "--sqlite-database-path",
        databasePath,
      ]),
    ).rejects.toThrow("Platform connection github-main is not ready");
  });

  it("parses persisted canonical tenant metadata", () => {
    expect(
      githubTenantConfigSchema.parse({
        repositoryId: 2468,
        repositoryFullName: "octo-org/reviewphin",
      }),
    ).toEqual({
      repositoryId: 2468,
      repositoryFullName: "octo-org/reviewphin",
    });
    expect(
      getGitHubTenantConfig(
        createTenant({
          repositoryId: 2468,
          repositoryFullName: "octo-org/reviewphin",
        }),
      ),
    ).toMatchObject({
      repositoryId: 2468,
      repositoryFullName: "octo-org/reviewphin",
    });
  });

  it("requires the owner/repository registration format", () => {
    expect(() =>
      githubTenantRegistrationSchema.parse({ repository: "reviewphin" }),
    ).toThrow("repository must use the owner/repository format");
  });
});

function createPlatform(request: ReturnType<typeof vi.fn>): GitHubPlatform {
  return new GitHubPlatform({
    logger,
    publicUrl: "https://review.example.com",
    createApp: () => ({
      octokit: { request: vi.fn() },
      getInstallationOctokit: vi.fn(async () => ({ request })),
    }),
  });
}

function createConnection(): PlatformConnectionRecord {
  return {
    id: "connection-github",
    name: "github-main",
    platform: "github",
    status: "ready",
    platformConnectionConfigJson: JSON.stringify(createReadyConfig()),
    createdAt: "2026-06-11T00:00:00.000Z",
    updatedAt: "2026-06-11T00:00:00.000Z",
  };
}

function createTenant(config: Record<string, unknown>): TenantRecord {
  return {
    id: "tenant-github",
    key: "https://api.github.com::2468",
    platform: "github",
    platformConnectionId: "connection-github",
    platformConfigJson: JSON.stringify(config),
    modelProfileName: null,
    createdAt: "2026-06-11T00:00:00.000Z",
    updatedAt: "2026-06-11T00:00:00.000Z",
  };
}

function createReadyConfig() {
  return readyGitHubConnectionConfigSchema.parse({
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
  });
}

function createRepository() {
  return {
    id: 2468,
    name: "renamed-repository",
    full_name: "octo-org/renamed-repository",
    private: false,
    html_url: "https://github.com/octo-org/renamed-repository",
    owner: {
      login: "octo-org",
      id: 456,
      type: "Organization",
    },
  };
}

function createPullRequest(number: number, headSha: string) {
  return {
    number,
    title: `Pull request ${number}`,
    body: null,
    html_url: `https://github.com/octo-org/renamed-repository/pull/${number}`,
    user: { login: "octocat" },
    head: { sha: headSha, ref: `feature-${number}` },
    base: { sha: "base-sha", ref: "main" },
  };
}
