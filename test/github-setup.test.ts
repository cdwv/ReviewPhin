import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { runCli } from "../src/cli.js";
import { createLogger } from "../src/logger.js";
import {
  pendingGitHubConnectionConfigSchema,
  readyGitHubConnectionConfigSchema,
  registeredGitHubConnectionConfigSchema,
} from "../src/platforms/github/config.js";
import GitHubPlatform from "../src/platforms/github/platform.js";
import { buildGitHubAppManifest } from "../src/platforms/github/manifest.js";
import {
  renderGitHubInstallationPage,
  renderGitHubSetupErrorPage,
  renderGitHubSetupPage,
  renderGitHubSetupSuccessPage,
} from "../src/platforms/github/setup-page.js";
import { openSqliteTestStorage } from "./helpers/storage.js";

const logger = createLogger("silent");

describe("GitHub App manifest setup", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("requests review permissions with read-only repository contents access", () => {
    expect(
      buildGitHubAppManifest({
        appName: "ReviewPhin octo-org",
        description: "Review pull requests",
        publicUrl: "https://review.example.com/",
        returnUrl: "https://review.example.com/setup/github/token/return",
        setupUrl: "https://review.example.com/setup/github/token/installed",
      }),
    ).toMatchObject({
      default_permissions: {
        checks: "write",
        contents: "read",
        issues: "write",
        metadata: "read",
        pull_requests: "write",
      },
      default_events: expect.arrayContaining(["check_run"]),
      description: "Review pull requests",
    });
  });

  it("registers a setup-required connection and prints its setup URL", async () => {
    const databasePath = await createDatabasePath();
    vi.stubEnv("PUBLIC_URL", "https://review.example.com");
    let stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });

    expect(
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
      ]),
    ).toBe(0);

    const storage = await openSqliteTestStorage(databasePath);
    const connection = await storage.resolvePlatformConnection("github-main");
    expect(connection).toMatchObject({
      platform: "github",
      status: "setup_required",
    });
    const config = pendingGitHubConnectionConfigSchema.parse(
      JSON.parse(connection!.platformConnectionConfigJson) as unknown,
    );
    expect(stdout).toContain(
      `Setup URL: https://review.example.com/setup/github/${config.setupToken}`,
    );
    await storage.close();
  });

  it("renders a setup page manifest without repository contents write access", () => {
    const page = renderGitHubSetupPage({
      owner: "octo-org",
      setupToken: "setup-token",
      publicUrl: "https://review.example.com/reviewphin/",
    });
    const payload = parseSetupData(page);

    expect(page).toContain("<!doctype html>");
    expect(page).toContain("Register GitHub App");
    expect(page).toContain(
      'href="https://review.example.com/reviewphin/github/setup/assets/github-setup.css"',
    );
    expect(page).toContain(
      'src="https://review.example.com/reviewphin/github/setup/assets/github-setup.js"',
    );
    expect(payload).toMatchObject({
      page: "register",
      owner: "octo-org",
      setupToken: "setup-token",
      publicUrl: "https://review.example.com/reviewphin",
    });
    expect(payload.permissions).toMatchObject({
      contents: "read",
    });
    expect(JSON.stringify(payload.permissions)).toContain('"contents":"read"');
    expect(JSON.stringify(payload.permissions)).not.toContain(
      '"contents":"write"',
    );
    expect(page).not.toContain("readonly");
    expect(page).not.toContain("const baseUrl =");
    expect(page).not.toContain("window.location.origin");
  });

  it("renders a setup success page with typed payload data", () => {
    const page = renderGitHubSetupSuccessPage({
      appName: "ReviewPhin octo-org",
      appSlug: "reviewphin-octo-org",
      appHtmlUrl: "https://github.com/apps/reviewphin-octo-org",
      ownerLogin: "octo-org",
      ownerType: "Organization",
      ownerAvatarUrl: "https://avatars.example.com/owner.png",
      installationId: 789,
      accessibleRepositoryCount: 12,
      repositorySelection: "selected",
      iconUrl: "https://review.example.com/reviewphin/favicon.png",
      publicUrl: "https://review.example.com/reviewphin/",
    });
    const payload = parseSetupData(page);

    expect(page).toContain("GitHub connection ready");
    expect(page).toContain(
      'href="https://review.example.com/reviewphin/github/setup/assets/github-setup.css"',
    );
    expect(page).toContain(
      'src="https://review.example.com/reviewphin/github/setup/assets/github-setup.js"',
    );
    expect(page).toContain(
      'href="https://review.example.com/reviewphin/favicon.png"',
    );
    expect(payload).toMatchObject({
      page: "success",
      installationId: 789,
      accessibleRepositoryCount: 12,
      iconUrl: "https://review.example.com/reviewphin/favicon.png",
      appHtmlUrl: "https://github.com/apps/reviewphin-octo-org",
    });
  });

  it("renders installation and setup error pages with public URL assets", () => {
    const installationPage = renderGitHubInstallationPage({
      appName: "ReviewPhin octo-org",
      installUrl: "https://github.com/apps/reviewphin-octo-org/installations/new",
      owner: "octo-org",
      publicUrl: "https://review.example.com/reviewphin/",
    });
    const errorPage = renderGitHubSetupErrorPage(
      "Setup link has expired.",
      "https://review.example.com/reviewphin/",
    );

    for (const page of [installationPage, errorPage]) {
      expect(page).toContain(
        'href="https://review.example.com/reviewphin/github/setup/assets/github-setup.css"',
      );
      expect(page).toContain(
        'src="https://review.example.com/reviewphin/github/setup/assets/github-setup.js"',
      );
      expect(page).toContain(
        'href="https://review.example.com/reviewphin/favicon.png"',
      );
      expect(page).not.toContain('href="/github/setup/assets/');
      expect(page).not.toContain('src="/github/setup/assets/');
      expect(page).not.toContain('href="/favicon.png"');
    }
  });

  it("registers, installs, validates API access, and completes the handshake", async () => {
    const databasePath = await createDatabasePath();
    const storage = await openSqliteTestStorage(databasePath);
    const request = vi.fn(async () => ({
      data: createManifestConversion(),
    }));
    const appRequest = vi.fn(async () => ({
      data: createInstallation(),
    }));
    const installationRequest = vi.fn(async () => ({
      data: {
        total_count: 12,
        repositories: [],
      },
    }));
    const createGitHubApp = vi.fn(() => ({
      octokit: { request: appRequest },
      getInstallationOctokit: vi.fn(async () => ({
        request: installationRequest,
      })),
    }));
    const platform = new GitHubPlatform({
      logger,
      publicUrl: "https://review.example.com/reviewphin",
      octokit: { request } as never,
      createApp: createGitHubApp,
    });
    const config = createPendingConfig(platform);
    const connection = await storage.createPlatformConnection({
      name: "github-main",
      platform: "github",
      status: "setup_required",
      platformConnectionConfigJson: JSON.stringify(config),
    });
    const app = await createTestApp(platform, storage);

    const setupResponse = await app.inject({
      method: "GET",
      url: `/setup/github/${config.setupToken}`,
    });
    expect(setupResponse.statusCode).toBe(200);
    expect(setupResponse.body).toContain("Registration manifest");
    expect(setupResponse.body).toContain(
      'href="https://review.example.com/reviewphin/github/setup/assets/github-setup.css"',
    );
    expect(setupResponse.body).toContain(
      'src="https://review.example.com/reviewphin/github/setup/assets/github-setup.js"',
    );
    const setupPayload = parseSetupData(setupResponse.body);
    expect(setupPayload).toMatchObject({
      page: "register",
      publicUrl: "https://review.example.com/reviewphin",
    });
    expect(setupPayload.permissions).toMatchObject({
      checks: "write",
      contents: "read",
    });
    expect(setupPayload.events).toContain("check_run");
    expect(setupResponse.body).not.toContain("const baseUrl =");
    expect(setupResponse.body).not.toContain("window.location.origin");
    expect(setupResponse.body).not.toContain('id="public-url"');

    const scriptResponse = await app.inject({
      method: "GET",
      url: "/github/setup/assets/github-setup.js",
    });
    expect(scriptResponse.statusCode).toBe(200);
    expect(scriptResponse.headers["content-type"]).toContain("javascript");

    const styleResponse = await app.inject({
      method: "GET",
      url: "/github/setup/assets/github-setup.css",
    });
    expect(styleResponse.statusCode).toBe(200);
    expect(styleResponse.headers["content-type"]).toContain("text/css");

    const faviconResponse = await app.inject({
      method: "GET",
      url: "/favicon.png",
    });
    expect(faviconResponse.statusCode).toBe(200);
    expect(faviconResponse.headers["content-type"]).toBe("image/png");

    const callbackResponse = await app.inject({
      method: "GET",
      url: `/setup/github/${config.setupToken}/return?code=manifest-code&state=${config.setupToken}`,
    });
    expect(callbackResponse.statusCode).toBe(302);
    expect(callbackResponse.headers.location).toBe(
      "https://github.com/apps/reviewphin-octo-org/installations/new",
    );
    expect(request).toHaveBeenCalledWith(
      "POST /app-manifests/{code}/conversions",
      { code: "manifest-code" },
    );

    const registered = await storage.resolvePlatformConnection(connection.id);
    expect(registered?.status).toBe("setup_required");
    expect(
      registeredGitHubConnectionConfigSchema.parse(
        JSON.parse(registered!.platformConnectionConfigJson) as unknown,
      ),
    ).toMatchObject({
      setupPhase: "app_registered",
      appId: 123,
    });

    const installationPageResponse = await app.inject({
      method: "GET",
      url: `/setup/github/${config.setupToken}`,
    });
    expect(installationPageResponse.statusCode).toBe(200);
    expect(installationPageResponse.body).toContain("Install GitHub App");
    expect(installationPageResponse.body).toContain(
      'href="https://review.example.com/reviewphin/github/setup/assets/github-setup.css"',
    );
    expect(installationPageResponse.body).toContain(
      'src="https://review.example.com/reviewphin/github/setup/assets/github-setup.js"',
    );
    expect(installationPageResponse.body).toContain(
      'href="https://review.example.com/reviewphin/favicon.png"',
    );

    const installationResponse = await app.inject({
      method: "GET",
      url: `/setup/github/${config.setupToken}/installed?installation_id=789&setup_action=install`,
    });
    expect(installationResponse.statusCode).toBe(200);
    expect(installationResponse.body).toContain("GitHub connection ready");
    expect(installationResponse.body).toContain("Installation ID");
    expect(installationResponse.body).toContain("Add the ReviewPhin avatar");
    expect(installationResponse.body).toContain(
      "show the ReviewPhin avatar instead of a default icon",
    );
    expect(installationResponse.body).toContain(
      'href="https://review.example.com/reviewphin/github/setup/assets/github-setup.css"',
    );
    expect(installationResponse.body).toContain(
      'src="https://review.example.com/reviewphin/github/setup/assets/github-setup.js"',
    );
    expect(installationResponse.body).toContain(
      'href="https://review.example.com/reviewphin/favicon.png"',
    );
    const successPayload = parseSetupData(installationResponse.body);
    expect(successPayload).toMatchObject({
      page: "success",
      installationId: 789,
      accessibleRepositoryCount: 12,
      iconUrl: "https://review.example.com/reviewphin/favicon.png",
      appHtmlUrl: "https://github.com/apps/reviewphin-octo-org",
    });
    expect(createGitHubApp).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 123,
        privateKey: "private-key",
        apiUrl: "https://api.github.com",
      }),
    );
    expect(appRequest).toHaveBeenCalledWith(
      "GET /app/installations/{installation_id}",
      { installation_id: 789 },
    );
    expect(installationRequest).toHaveBeenCalledWith(
      "GET /installation/repositories",
      { per_page: 1 },
    );

    const updated = await storage.resolvePlatformConnection(connection.id);
    expect(updated?.status).toBe("ready");
    expect(
      readyGitHubConnectionConfigSchema.parse(
        JSON.parse(updated!.platformConnectionConfigJson) as unknown,
      ),
    ).toMatchObject({
      appId: 123,
      clientId: "Iv1.client",
      clientSecret: "client-secret",
      webhookSecret: "webhook-secret",
      privateKey: "private-key",
      ownerLogin: "octo-org",
      installationId: 789,
      installationAccountLogin: "octo-org",
      repositorySelection: "selected",
      accessibleRepositoryCount: 12,
    });

    const reusedResponse = await app.inject({
      method: "GET",
      url: `/setup/github/${config.setupToken}/installed?installation_id=789`,
    });
    expect(reusedResponse.statusCode).toBe(404);

    await app.close();
    await storage.close();
  });

  it("rejects expired setup tokens and owner mismatches", async () => {
    const databasePath = await createDatabasePath();
    const storage = await openSqliteTestStorage(databasePath);
    let now = new Date("2026-06-10T10:00:00.000Z");
    const request = vi.fn(async () => ({
      data: createManifestConversion({ ownerLogin: "wrong-owner" }),
    }));
    const platform = new GitHubPlatform({
      logger,
      publicUrl: "https://review.example.com",
      octokit: { request } as never,
      now: () => now,
    });
    const config = createPendingConfig(platform);
    const connection = await storage.createPlatformConnection({
      name: "github-main",
      platform: "github",
      status: "setup_required",
      platformConnectionConfigJson: JSON.stringify(config),
    });
    const app = await createTestApp(platform, storage);

    const mismatchResponse = await app.inject({
      method: "GET",
      url: `/setup/github/${config.setupToken}/return?code=manifest-code&state=${config.setupToken}`,
    });
    expect(mismatchResponse.statusCode).toBe(400);
    expect(mismatchResponse.body).toContain("wrong-owner");
    expect(
      (await storage.resolvePlatformConnection(connection.id))?.status,
    ).toBe("setup_required");

    now = new Date("2026-06-10T11:00:00.001Z");
    const expiredResponse = await app.inject({
      method: "GET",
      url: `/setup/github/${config.setupToken}`,
    });
    expect(expiredResponse.statusCode).toBe(410);
    expect(expiredResponse.body).toContain("expired");

    await app.close();
    await storage.close();
  });

  it("rejects an installation on a different account", async () => {
    const databasePath = await createDatabasePath();
    const storage = await openSqliteTestStorage(databasePath);
    const platform = new GitHubPlatform({
      logger,
      publicUrl: "https://review.example.com",
      octokit: {
        request: vi.fn(async () => ({
          data: createManifestConversion(),
        })),
      } as never,
      createApp: () => ({
        octokit: {
          request: vi.fn(async () => ({
            data: createInstallation({ accountLogin: "wrong-owner" }),
          })),
        },
        getInstallationOctokit: vi.fn(),
      }),
    });
    const config = createPendingConfig(platform);
    const connection = await storage.createPlatformConnection({
      name: "github-main",
      platform: "github",
      status: "setup_required",
      platformConnectionConfigJson: JSON.stringify(config),
    });
    const app = await createTestApp(platform, storage);
    await app.inject({
      method: "GET",
      url: `/setup/github/${config.setupToken}/return?code=manifest-code&state=${config.setupToken}`,
    });

    const response = await app.inject({
      method: "GET",
      url: `/setup/github/${config.setupToken}/installed?installation_id=789`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("wrong-owner");
    expect(
      (await storage.resolvePlatformConnection(connection.id))?.status,
    ).toBe("setup_required");

    await app.close();
    await storage.close();
  });

  it("recreates setup in place and keeps attached tenants", async () => {
    const databasePath = await createDatabasePath();
    vi.stubEnv("PUBLIC_URL", "https://review.example.com");
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
    const storage = await openSqliteTestStorage(databasePath);
    const original = await storage.resolvePlatformConnection("github-main");
    const originalConfig = pendingGitHubConnectionConfigSchema.parse(
      JSON.parse(original!.platformConnectionConfigJson) as unknown,
    );
    await storage.upsertTenant({
      key: "github::123",
      platform: "github",
      platformConnectionId: original!.id,
      platformConfigJson: '{"repositoryId":123}',
    });
    await storage.close();

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
      "--recreate",
      "--sqlite-database-path",
      databasePath,
    ]);

    const reopened = await openSqliteTestStorage(databasePath);
    const recreated = await reopened.resolvePlatformConnection("github-main");
    const recreatedConfig = pendingGitHubConnectionConfigSchema.parse(
      JSON.parse(recreated!.platformConnectionConfigJson) as unknown,
    );
    expect(recreated?.id).toBe(original?.id);
    expect(recreated?.status).toBe("setup_required");
    expect(recreatedConfig.setupToken).not.toBe(originalConfig.setupToken);
    expect(
      await reopened.stores.tenants.find({ key: { eq: "github::123" } }),
    ).toMatchObject({
      platformConnectionId: original!.id,
    });
    await reopened.close();
  });

  it("rejects ordinary GitHub connection updates instead of resetting setup", async () => {
    const databasePath = await createDatabasePath();
    vi.stubEnv("PUBLIC_URL", "https://review.example.com");
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
        "platform",
        "connection",
        "update",
        "--connection",
        "github-main",
        "--owner",
        "another-owner",
        "--sqlite-database-path",
        databasePath,
      ]),
    ).rejects.toThrow("GitHub connection updates are not supported");

    const storage = await openSqliteTestStorage(databasePath);
    const connection = await storage.resolvePlatformConnection("github-main");
    expect(
      pendingGitHubConnectionConfigSchema.parse(
        JSON.parse(connection!.platformConnectionConfigJson) as unknown,
      ).owner,
    ).toBe("octo-org");
    await storage.close();
  });

  it("redacts GitHub credentials from connection list and describe output", async () => {
    const databasePath = await createDatabasePath();
    const storage = await openSqliteTestStorage(databasePath);
    await storage.createPlatformConnection({
      name: "github-main",
      platform: "github",
      status: "ready",
      platformConnectionConfigJson: JSON.stringify(createReadyConfig()),
    });
    await storage.close();
    let stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });

    await runCli([
      "platform",
      "connection",
      "list",
      "--output",
      "json",
      "--sqlite-database-path",
      databasePath,
    ]);
    await runCli([
      "platform",
      "connection",
      "describe",
      "--connection",
      "github-main",
      "--output",
      "json",
      "--sqlite-database-path",
      databasePath,
    ]);

    expect(stdout).toContain('"name":"github-main"');
    expect(stdout).not.toContain("client-secret");
    expect(stdout).not.toContain("webhook-secret");
    expect(stdout).not.toContain("private-key");
  });

  it("prints GitHub cleanup guidance when removing a connection", async () => {
    const databasePath = await createDatabasePath();
    const storage = await openSqliteTestStorage(databasePath);
    await storage.createPlatformConnection({
      name: "github-main",
      platform: "github",
      status: "ready",
      platformConnectionConfigJson: JSON.stringify(createReadyConfig()),
    });
    await storage.close();
    let stdout = "";
    let stderr = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });

    expect(
      await runCli([
        "platform",
        "connection",
        "remove",
        "--connection",
        "github-main",
        "--sqlite-database-path",
        databasePath,
      ]),
    ).toBe(0);

    expect(stderr).toContain("uninstall installation 789 in GitHub");
    expect(stderr).toContain('Delete the old GitHub App "ReviewPhin octo-org"');
    expect(stderr).toContain(
      "Local credentials cannot remove the remote App automatically",
    );
    expect(stdout).toContain("Platform connection github-main removed.");
  });

  it("rejects GitHub connection removal while a tenant remains attached", async () => {
    const databasePath = await createDatabasePath();
    const storage = await openSqliteTestStorage(databasePath);
    const connection = await storage.createPlatformConnection({
      name: "github-main",
      platform: "github",
      status: "ready",
      platformConnectionConfigJson: JSON.stringify(createReadyConfig()),
    });
    await storage.upsertTenant({
      key: "https://api.github.com::123",
      platform: "github",
      platformConnectionId: connection.id,
      platformConfigJson: JSON.stringify({
        repositoryId: 123,
        repositoryFullName: "octo-org/repository",
      }),
    });
    await storage.close();

    await expect(
      runCli([
        "platform",
        "connection",
        "remove",
        "--connection",
        "github-main",
        "--sqlite-database-path",
        databasePath,
      ]),
    ).rejects.toThrow("https://api.github.com::123");

    const reopened = await openSqliteTestStorage(databasePath);
    expect(
      await reopened.resolvePlatformConnection("github-main"),
    ).toMatchObject({
      id: connection.id,
      status: "ready",
    });
    await reopened.close();
  });
});

function createPendingConfig(platform: GitHubPlatform) {
  const config: Record<string, unknown> = {
    owner: "octo-org",
    apiUrl: "https://api.github.com",
  };
  platform.onBeforeAddConnection(config);
  return pendingGitHubConnectionConfigSchema.parse(config);
}

function createManifestConversion(input: { ownerLogin?: string } = {}) {
  const ownerLogin = input.ownerLogin ?? "octo-org";
  return {
    id: 123,
    slug: "reviewphin-octo-org",
    name: "ReviewPhin octo-org",
    client_id: "Iv1.client",
    client_secret: "client-secret",
    webhook_secret: "webhook-secret",
    pem: "private-key",
    html_url: "https://github.com/apps/reviewphin-octo-org",
    permissions: {
      issues: "write",
      metadata: "read",
      pull_requests: "write",
    },
    events: ["issue_comment", "pull_request"],
    owner: {
      login: ownerLogin,
      id: 456,
      type: "Organization",
      avatar_url: "https://avatars.example.com/owner.png",
      html_url: `https://github.com/${ownerLogin}`,
    },
  };
}

function createInstallation(input: { accountLogin?: string } = {}) {
  const accountLogin = input.accountLogin ?? "octo-org";
  return {
    id: 789,
    account: {
      login: accountLogin,
      id: 456,
      type: "Organization",
    },
    repository_selection: "selected",
    created_at: "2026-06-10T10:00:00.000Z",
    updated_at: "2026-06-10T10:00:00.000Z",
    suspended_at: null,
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
      issues: "write",
      metadata: "read",
      pull_requests: "write",
    },
    events: ["check_run", "issue_comment", "pull_request"],
    installationId: 789,
    installationAccountLogin: "octo-org",
    installationAccountId: 456,
    installationAccountType: "Organization",
    repositorySelection: "selected",
    accessibleRepositoryCount: 1,
  });
}

async function createDatabasePath(): Promise<string> {
  return join(
    await mkdtemp(join(tmpdir(), "reviewphin-github-setup-")),
    "storage.sqlite",
  );
}

async function createTestApp(
  platform: GitHubPlatform,
  storage: Awaited<ReturnType<typeof openSqliteTestStorage>>,
) {
  return createApp({
    logger,
    storage,
    tenantRegistry: {
      resolveWebhookTenant: async () => null,
    } as never,
    reviewWorker: {
      classifyWebhookTrigger: async () => null,
      createInteractionJobFromWebhook: async () => {
        throw new Error("unused");
      },
    } as never,
    platforms: [platform],
  });
}

function parseSetupData(page: string): Record<string, unknown> {
  const match = page.match(
    /<script type="application\/json" id="reviewphin-setup-data">(?<json>.*?)<\/script>/s,
  );
  expect(match?.groups?.json).toBeDefined();
  return JSON.parse(match!.groups!.json!) as Record<string, unknown>;
}
