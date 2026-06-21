import { describe, expect, it } from "vitest";

import { createLogger } from "../src/logger.js";
import { readyGitHubConnectionConfigSchema } from "../src/platforms/github/config.js";
import GitHubPlatform from "../src/platforms/github/platform.js";
import GitLabPlatform from "../src/platforms/gitlab/platform.js";
import type { PlatformConnectionRecord } from "../src/storage/contract/current.js";

const logger = createLogger("silent");

describe("platform connection lifecycle guidance", () => {
  it("retains GitHub cleanup metadata without retaining old credentials", () => {
    const platform = new GitHubPlatform({
      logger,
      publicUrl: "https://review.example.com",
    });
    const connection = createGitHubConnection();
    const replacement: Record<string, unknown> = {
      owner: "octo-org",
      apiUrl: "https://api.github.com",
    };

    const result = platform.onBeforeRecreateConnection(connection, replacement);

    expect(result.status).toBe("setup_required");
    expect(result.notices?.join("\n")).toContain("installation 789");
    expect(replacement).toMatchObject({
      previousAppCleanup: {
        appName: "ReviewPhin octo-org",
        appSlug: "reviewphin-octo-org",
        ownerLogin: "octo-org",
        installationId: 789,
      },
    });
    expect(replacement).not.toHaveProperty("privateKey");
    expect(replacement).not.toHaveProperty("clientSecret");
    expect(replacement).not.toHaveProperty("webhookSecret");
  });

  it("provides GitLab cleanup guidance for recreate and removal", async () => {
    const platform = new GitLabPlatform(logger);
    const connection = {
      ...createGitHubConnection(),
      platform: "gitlab",
      platformConnectionConfigJson: JSON.stringify({
        baseUrl: "https://gitlab.example.com",
        apiToken: "token",
        botUserId: 1,
        botUsername: "review-bot",
      }),
    };
    const replacement = JSON.parse(
      connection.platformConnectionConfigJson,
    ) as Record<string, unknown>;

    const recreate = await platform.onBeforeRecreateConnection(
      connection,
      replacement,
    );
    expect(recreate.notices?.join("\n")).toContain("project webhooks");
    expect(platform.onBeforeRemoveConnection().join("\n")).toContain(
      "Revoke the GitLab access token",
    );
  });
});

function createGitHubConnection(): PlatformConnectionRecord {
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
        permissions: { checks: "write" },
        events: ["check_run"],
        installationId: 789,
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
