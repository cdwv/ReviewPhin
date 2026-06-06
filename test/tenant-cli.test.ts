import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";
import { createLogger } from "../src/logger.js";
import GitLabPlatform from "../src/platforms/gitlab/platform.js";
import {
  getGitLabConnectionConfig,
  getGitLabTenantConfig,
} from "../src/platforms/gitlab/tenant-config.js";
import { StoreBackedStorage, listAll } from "../src/storage/storage-helpers.js";
import { TenantRegistry } from "../src/tenants/tenant-registry.js";
import { createGitLabTenantInput } from "./helpers/gitlab-tenant.js";
import { openSqliteTestStorage } from "./helpers/storage.js";

function createPayload() {
  return {
    object_kind: "note" as const,
    project: {
      id: 123,
      web_url: "https://gitlab.example.com/group/project",
      path_with_namespace: "group/project",
    },
    repository: {
      homepage: "https://gitlab.example.com/group/project",
    },
    merge_request: {
      iid: 7,
      title: "Add worker",
      description: "Adds the worker",
      source_branch: "feature",
      target_branch: "main",
      last_commit: {
        id: "abc123",
      },
    },
    object_attributes: {
      id: 55,
      note: "please /review this",
      noteable_type: "MergeRequest" as const,
      url: "https://gitlab.example.com/group/project/-/merge_requests/7#note_55",
    },
  };
}

function createWebhookRequest() {
  const payload = createPayload();
  return {
    headers: {
      "x-gitlab-token": "replace-me",
    },
    body: payload,
    rawBody: Buffer.from(JSON.stringify(payload)),
    pathSuffix: "note",
  };
}

async function addGitLabConnection(
  databasePath: string,
  baseUrl = "https://gitlab.example.com",
): Promise<void> {
  await runCli([
    "platform",
    "connection",
    "add",
    "--sqlite-database-path",
    databasePath,
    "--name",
    "test-connection",
    "--platform",
    "gitlab",
    "--base-url",
    baseUrl,
    "--api-token",
    "glpat-xxxxxxxx",
    "--bot-user-id",
    "999",
    "--bot-username",
    "review-bot",
  ]);
}

describe("tenant CLI", () => {
  it("adds a tenant to SQLite and makes it resolvable without env registration", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-"));
    const databasePath = join(workspace, "tenants.sqlite");
    await addGitLabConnection(databasePath);

    const exitCode = await runCli([
      "tenant",
      "add",
      "--connection",
      "test-connection",
      "--sqlite-database-path",
      databasePath,
      "--base-url",
      "https://gitlab.example.com",
      "--project-id",
      "123",
      "--api-token",
      "glpat-xxxxxxxx",
      "--webhook-secret",
      "replace-me",
      "--bot-user-id",
      "999",
      "--bot-username",
      "review-bot",
    ]);

    expect(exitCode).toBe(0);

    const storage = await openSqliteTestStorage(databasePath);

    const tenants = await listAll(storage.stores.tenants);
    expect(tenants).toHaveLength(1);
    const persistedTenant = tenants[0];
    expect(persistedTenant).toBeDefined();
    expect(persistedTenant).toMatchObject({
      key: "https://gitlab.example.com::123",
    });
    expect(getGitLabTenantConfig(persistedTenant!)).toMatchObject({
      projectId: 123,
    });
    expect(
      getGitLabConnectionConfig(
        (await storage.resolvePlatformConnection("test-connection"))!,
      ),
    ).toMatchObject({
      baseUrl: "https://gitlab.example.com",
      botUserId: 999,
      botUsername: "review-bot",
    });

    const registry = new TenantRegistry({
      storage,
    });
    const platform = new GitLabPlatform(createLogger("silent"));

    const tenant = await registry.resolveWebhookTenant(
      platform,
      createPayload(),
      createWebhookRequest(),
    );
    expect(tenant).not.toBeNull();
    expect(tenant?.tenant.key).toBe("https://gitlab.example.com::123");

    const logger = createLogger("silent");
    logger.info({ tenantId: tenant?.tenant.id }, "tenant resolved");
  });

  it("requires bot user id when adding a tenant", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-"));
    const databasePath = join(workspace, "tenants.sqlite");

    await expect(
      runCli([
        "tenant",
        "add",
        "--connection",
        "test-connection",
        "--sqlite-database-path",
        databasePath,
        "--base-url",
        "https://gitlab.example.com",
        "--project-id",
        "123",
        "--api-token",
        "glpat-xxxxxxxx",
        "--webhook-secret",
        "replace-me",
        "--bot-username",
        "review-bot",
      ]),
    ).rejects.toThrow();
  });

  it("requires bot username when adding a tenant", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-"));
    const databasePath = join(workspace, "tenants.sqlite");

    await expect(
      runCli([
        "tenant",
        "add",
        "--connection",
        "test-connection",
        "--sqlite-database-path",
        databasePath,
        "--base-url",
        "https://gitlab.example.com",
        "--project-id",
        "123",
        "--api-token",
        "glpat-xxxxxxxx",
        "--webhook-secret",
        "replace-me",
        "--bot-user-id",
        "999",
      ]),
    ).rejects.toThrow();
  });

  it("adds and lists model profiles with masked auth tokens", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-"));
    const databasePath = join(workspace, "tenants.sqlite");

    const addExitCode = await runCli([
      "model-profile",
      "add",
      "--sqlite-database-path",
      databasePath,
      "--name",
      "byok",
      "--base-url",
      "https://llm.example.com/v1",
      "--provider-type",
      "openai",
      "--wire-api",
      "completions",
      "--auth-token",
      "super-secret-token",
      "--review-model",
      "custom-review",
      "--text-generation-model",
      "custom-text",
      "--default",
    ]);
    expect(addExitCode).toBe(0);

    let stdout = "";
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stdout +=
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk).toString("utf8");
        return true;
      });

    const listExitCode = await runCli([
      "model-profile",
      "list",
      "--sqlite-database-path",
      databasePath,
    ]);

    stdoutSpy.mockRestore();

    expect(listExitCode).toBe(0);
    expect(stdout).toContain('"name": "byok"');
    expect(stdout).toContain('"isDefault": true');
    expect(stdout).toContain('"wireApi": "completions"');
    expect(stdout).not.toContain("super-secret-token");
  });

  it("accepts a native Copilot auth token without a custom provider base URL", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-"));
    const databasePath = join(workspace, "tenants.sqlite");

    const exitCode = await runCli([
      "model-profile",
      "add",
      "--sqlite-database-path",
      databasePath,
      "--name",
      "native-token",
      "--auth-token",
      "github-token",
      "--review-model",
      "gpt-5.4",
    ]);

    expect(exitCode).toBe(0);

    const storage = await openSqliteTestStorage(databasePath);
    expect(
      await storage.stores.modelProfiles.get("native-token"),
    ).toMatchObject({
      name: "native-token",
      providerBaseUrl: null,
      authToken: "github-token",
      reviewModel: "gpt-5.4",
    });
  });

  it("preserves existing model profile fields when add updates only one flag", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-"));
    const databasePath = join(workspace, "tenants.sqlite");

    await runCli([
      "model-profile",
      "add",
      "--sqlite-database-path",
      databasePath,
      "--name",
      "byok",
      "--base-url",
      "https://llm.example.com/v1",
      "--provider-type",
      "openai",
      "--auth-token",
      "super-secret-token",
      "--review-model",
      "custom-review",
      "--text-generation-model",
      "custom-text",
    ]);

    const exitCode = await runCli([
      "model-profile",
      "add",
      "--sqlite-database-path",
      databasePath,
      "--name",
      "byok",
      "--default",
    ]);

    expect(exitCode).toBe(0);

    const storage = await openSqliteTestStorage(databasePath);
    expect(await storage.stores.modelProfiles.get("byok")).toMatchObject({
      name: "byok",
      providerBaseUrl: "https://llm.example.com/v1",
      providerType: "openai",
      authToken: "super-secret-token",
      reviewModel: "custom-review",
      textGenerationModel: "custom-text",
      isDefault: true,
    });
  });

  it("clears nullable model profile fields explicitly", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-"));
    const databasePath = join(workspace, "tenants.sqlite");

    await runCli([
      "model-profile",
      "add",
      "--sqlite-database-path",
      databasePath,
      "--name",
      "byok",
      "--base-url",
      "https://llm.example.com/v1",
      "--provider-type",
      "openai",
      "--wire-api",
      "completions",
      "--auth-token",
      "super-secret-token",
      "--review-model",
      "custom-review",
      "--text-generation-model",
      "custom-text",
    ]);

    const exitCode = await runCli([
      "model-profile",
      "add",
      "--sqlite-database-path",
      databasePath,
      "--name",
      "byok",
      "--clear-base-url",
      "--clear-auth-token",
      "--clear-text-generation-model",
    ]);

    expect(exitCode).toBe(0);

    const storage = await openSqliteTestStorage(databasePath);
    expect(await storage.stores.modelProfiles.get("byok")).toMatchObject({
      name: "byok",
      providerBaseUrl: null,
      providerType: null,
      wireApi: null,
      authToken: null,
      reviewModel: "custom-review",
      textGenerationModel: null,
    });
  });

  it("assigns and clears tenant model profiles through the CLI", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-"));
    const databasePath = join(workspace, "tenants.sqlite");
    await addGitLabConnection(databasePath);

    await runCli([
      "model-profile",
      "add",
      "--sqlite-database-path",
      databasePath,
      "--name",
      "native-gpt5",
      "--review-model",
      "gpt-5.4",
    ]);
    await runCli([
      "tenant",
      "add",
      "--connection",
      "test-connection",
      "--sqlite-database-path",
      databasePath,
      "--base-url",
      "https://gitlab.example.com",
      "--project-id",
      "123",
      "--api-token",
      "glpat-xxxxxxxx",
      "--webhook-secret",
      "replace-me",
      "--bot-user-id",
      "999",
      "--bot-username",
      "review-bot",
    ]);

    const setExitCode = await runCli([
      "tenant",
      "set-profile",
      "--sqlite-database-path",
      databasePath,
      "--key",
      "https://gitlab.example.com::123",
      "--model-profile",
      "native-gpt5",
    ]);
    expect(setExitCode).toBe(0);

    const storage = await openSqliteTestStorage(databasePath);
    expect(
      (
        await listAll(storage.stores.tenants, {
          order: [{ field: "key", direction: "asc" }],
        })
      )[0]?.modelProfileName,
    ).toBe("native-gpt5");

    const clearExitCode = await runCli([
      "tenant",
      "clear-profile",
      "--sqlite-database-path",
      databasePath,
      "--key",
      "https://gitlab.example.com::123",
    ]);
    expect(clearExitCode).toBe(0);
    expect(
      (
        await listAll(storage.stores.tenants, {
          order: [{ field: "key", direction: "asc" }],
        })
      )[0]?.modelProfileName,
    ).toBeNull();
  });

  it("preserves an existing tenant profile when tenant add reruns without --model-profile", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-"));
    const databasePath = join(workspace, "tenants.sqlite");
    await addGitLabConnection(databasePath);

    await runCli([
      "model-profile",
      "add",
      "--sqlite-database-path",
      databasePath,
      "--name",
      "native-gpt5",
      "--review-model",
      "gpt-5.4",
    ]);

    await runCli([
      "tenant",
      "add",
      "--connection",
      "test-connection",
      "--sqlite-database-path",
      databasePath,
      "--base-url",
      "https://gitlab.example.com",
      "--project-id",
      "123",
      "--api-token",
      "glpat-original",
      "--webhook-secret",
      "replace-me",
      "--bot-user-id",
      "999",
      "--bot-username",
      "review-bot",
      "--model-profile",
      "native-gpt5",
    ]);

    const exitCode = await runCli([
      "tenant",
      "add",
      "--connection",
      "test-connection",
      "--sqlite-database-path",
      databasePath,
      "--base-url",
      "https://gitlab.example.com",
      "--project-id",
      "123",
      "--api-token",
      "glpat-rotated",
      "--webhook-secret",
      "replace-me-2",
      "--bot-user-id",
      "999",
      "--bot-username",
      "review-bot",
    ]);

    expect(exitCode).toBe(0);

    const storage = await openSqliteTestStorage(databasePath);
    expect(
      (
        await listAll(storage.stores.tenants, {
          order: [{ field: "key", direction: "asc" }],
        })
      )[0],
    ).toMatchObject({
      modelProfileName: "native-gpt5",
    });
    const persistedTenant = (await listAll(storage.stores.tenants))[0];
    expect(persistedTenant).toBeDefined();
    expect(getGitLabTenantConfig(persistedTenant!)).toMatchObject({
      webhookSecret: "replace-me-2",
    });
  });

  it("describes trigger dedupe for non-GitLab tenants without parsing GitLab config", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-"));
    const databasePath = join(workspace, "tenants.sqlite");
    const storage = await openSqliteTestStorage(databasePath);
    await storage.createPlatformConnection({
      name: "external",
      platform: "external",
      status: "ready",
      platformConnectionConfigJson: "{}",
    });
    const externalConnection =
      await storage.resolvePlatformConnection("external");
    const tenant = await storage.upsertTenant({
      key: "external::project-1",
      platform: "external",
      platformConnectionId: externalConnection!.id,
      platformConfigJson: JSON.stringify({ project: "project-1" }),
    });
    await storage.createOrGetInteractionJob({
      tenantId: tenant.id,
      dedupeKey: "external-job",
      codeReviewId: 7,
      commentId: 55,
      headSha: "abc123",
      payloadJson: "{}",
    });

    let stdout = "";
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stdout +=
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk).toString("utf8");
        return true;
      });

    const exitCode = await runCli([
      "mr",
      "describe",
      "--sqlite-database-path",
      databasePath,
      "--key",
      "external::project-1",
      "--code-review-id",
      "7",
      "--trigger-comment-id",
      "55",
    ]);

    stdoutSpy.mockRestore();

    expect(exitCode).toBe(0);
    expect(stdout).toContain("tenant: external::project-1 (external)");
    expect(stdout).toContain("candidate: unsupported for this platform");
    expect(stdout).toContain(
      "Trigger-comment dedupe inspection is currently available for GitLab tenants only.",
    );
  });

  it("removes a tenant by base URL and project ID", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-"));
    const databasePath = join(workspace, "tenants.sqlite");
    await addGitLabConnection(
      databasePath,
      "https://gitlab.example.com/gitlab/",
    );

    await runCli([
      "tenant",
      "add",
      "--connection",
      "test-connection",
      "--sqlite-database-path",
      databasePath,
      "--base-url",
      "https://gitlab.example.com/gitlab/",
      "--project-id",
      "123",
      "--api-token",
      "glpat-xxxxxxxx",
      "--webhook-secret",
      "replace-me",
      "--bot-user-id",
      "999",
      "--bot-username",
      "review-bot",
    ]);

    let stdout = "";
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stdout +=
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk).toString("utf8");
        return true;
      });

    const exitCode = await runCli([
      "tenant",
      "remove",
      "--sqlite-database-path",
      databasePath,
      "--yes",
      "--key",
      "https://gitlab.example.com/gitlab::123",
    ]);

    stdoutSpy.mockRestore();

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Tenant removed.");
    expect(stdout).toContain("key: https://gitlab.example.com/gitlab::123");

    const storage = await openSqliteTestStorage(databasePath);
    expect(await listAll(storage.stores.tenants)).toEqual([]);

    const registry = new TenantRegistry({
      storage,
    });
    const platform = new GitLabPlatform(createLogger("silent"));

    const tenant = await registry.resolveWebhookTenant(
      platform,
      createPayload(),
      createWebhookRequest(),
    );
    expect(tenant).toBeNull();
  });

  it("refuses tenant removal without confirmation in non-interactive mode", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-"));
    const databasePath = join(workspace, "tenants.sqlite");
    await addGitLabConnection(databasePath);

    await runCli([
      "tenant",
      "add",
      "--connection",
      "test-connection",
      "--sqlite-database-path",
      databasePath,
      "--base-url",
      "https://gitlab.example.com",
      "--project-id",
      "123",
      "--api-token",
      "glpat-xxxxxxxx",
      "--webhook-secret",
      "replace-me",
      "--bot-user-id",
      "999",
      "--bot-username",
      "review-bot",
    ]);

    let stdout = "";
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stdout +=
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk).toString("utf8");
        return true;
      });

    const exitCode = await runCli([
      "tenant",
      "remove",
      "--sqlite-database-path",
      databasePath,
      "--key",
      "https://gitlab.example.com::123",
    ]);

    stdoutSpy.mockRestore();

    expect(exitCode).toBe(1);
    expect(stdout).toContain(
      "Preparing to remove tenant https://gitlab.example.com::123 (gitlab)",
    );
    expect(stdout).toContain(
      "Tenant removal requires confirmation. Re-run with --yes in non-interactive mode.",
    );
  });

  it("removes tenant database rows and local artifacts for tenants with review history", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-"));
    const databasePath = join(workspace, "tenants.sqlite");
    const workspaceRoot = join(workspace, "review-workspaces");
    const runLogDir = join(workspace, "run-logs");

    const storage = await openSqliteTestStorage(databasePath);

    const tenant = await storage.upsertTenant(
      createGitLabTenantInput({
        baseUrl: "https://gitlab.example.com/gitlab",
        apiToken: "glpat-xxxxxxxx",
        webhookSecret: "replace-me",
      }),
    );
    const reviewJob = await storage.createOrGetInteractionJob({
      tenantId: tenant.id,
      dedupeKey: "tenant-remove-job",
      codeReviewId: 7,
      commentId: 55,
      headSha: "abc123",
      payloadJson: "{}",
    });
    await storage.createCodeReviewSnapshot({
      interactionJobId: reviewJob.job.id,
      tenantId: tenant.id,
      codeReviewId: 7,
      headSha: "abc123",
      codeReviewJson: "{}",
      versionsJson: "[]",
      changesJson: "[]",
      commentsJson: "[]",
      discussionsJson: "[]",
      instructionsJson: "[]",
      projectMemoryJson: null,
      workspaceStrategy: "git",
    });
    const reviewRun = await storage.createInteractionRun({
      interactionJobId: reviewJob.job.id,
      tenantId: tenant.id,
      provider: "copilot-sdk",
      model: null,
      modelProfileName: null,
      providerBaseUrl: null,
      providerType: null,
      textGenerationModel: null,
    });
    await storage.replaceReviewFindings(reviewRun.id, [
      {
        interactionRunId: reviewRun.id,
        identityKey: "tenant-remove-finding",
        severity: "medium",
        category: "correctness",
        title: "Tenant remove finding",
        body: "This data should be removed",
        anchorJson: null,
        suggestionJson: null,
        status: "open",
      },
    ]);
    await storage.upsertInteractionRunMetrics({
      interactionRunId: reviewRun.id,
      triggerKind: "note",
      promptMode: "full",
      promptChars: 10,
      promptContextChangedFiles: 1,
      promptContextPriorDiscussions: 0,
      promptContextComments: 1,
      assistantTurns: 1,
      assistantCalls: 1,
      toolExecutions: 0,
      viewToolCalls: 0,
      globToolCalls: 0,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      apiDurationMs: 100,
      premiumRequests: 1,
      repeatedViewReads: 0,
      repeatedViewPathsJson: "[]",
    });
    await storage.upsertDiscussionMapping({
      tenantId: tenant.id,
      codeReviewId: 7,
      identityKey: "tenant-remove-finding",
      findingFingerprint: "tenant-remove-fingerprint",
      title: "Tenant remove finding",
      severity: "medium",
      category: "correctness",
      body: "This data should be removed",
      platformDiscussionId: "discussion-1",
      platformCommentId: 501,
      anchorJson: null,
      positionJson: null,
      botDiscussion: true,
      botComment: true,
      commentAuthorId: 999,
      commentAuthorUsername: "review-bot",
      status: "open",
      lastInteractionRunId: reviewRun.id,
    });

    await mkdir(join(workspaceRoot, reviewJob.job.id, "workspace"), {
      recursive: true,
    });
    await writeFile(
      join(workspaceRoot, reviewJob.job.id, "workspace", "README.md"),
      "workspace",
    );
    await mkdir(join(runLogDir, reviewRun.id, "copilot"), { recursive: true });
    await writeFile(
      join(runLogDir, reviewRun.id, "copilot", "session.json"),
      "{}",
    );

    let stdout = "";
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stdout +=
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk).toString("utf8");
        return true;
      });

    const exitCode = await runCli([
      "tenant",
      "remove",
      "--sqlite-database-path",
      databasePath,
      "--workspace-root",
      workspaceRoot,
      "--run-log-dir",
      runLogDir,
      "--yes",
      "--key",
      "https://gitlab.example.com/gitlab::123",
    ]);

    stdoutSpy.mockRestore();

    expect(exitCode).toBe(0);
    expect(stdout).toContain("This will delete:");
    expect(stdout).toContain("- 1 interaction job");
    expect(stdout).toContain("- 1/1 workspace directory");
    expect(stdout).toContain("- 1/1 run log directory");
    expect(stdout).toContain("Tenant removed.");

    expect(await listAll(storage.stores.tenants)).toEqual([]);
    expect(countRows(databasePath, "interaction_jobs")).toBe(0);
    expect(countRows(databasePath, "code_review_snapshots")).toBe(0);
    expect(countRows(databasePath, "interaction_runs")).toBe(0);
    expect(countRows(databasePath, "review_findings")).toBe(0);
    expect(countRows(databasePath, "interaction_run_metrics")).toBe(0);
    expect(countRows(databasePath, "discussion_mappings")).toBe(0);
    await expect(
      pathExists(join(workspaceRoot, reviewJob.job.id)),
    ).resolves.toBe(false);
    await expect(pathExists(join(runLogDir, reviewRun.id))).resolves.toBe(
      false,
    );
  });

  it("removes artifacts created after the preview summary but before the final delete", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-"));
    const databasePath = join(workspace, "tenants.sqlite");
    const workspaceRoot = join(workspace, "review-workspaces");
    const runLogDir = join(workspace, "run-logs");

    const seedStorage = await openSqliteTestStorage(databasePath);

    const tenant = await seedStorage.upsertTenant(
      createGitLabTenantInput({
        baseUrl: "https://gitlab.example.com/gitlab",
        apiToken: "glpat-xxxxxxxx",
        webhookSecret: "replace-me",
      }),
    );
    const initialJob = await seedStorage.createOrGetInteractionJob({
      tenantId: tenant.id,
      dedupeKey: "tenant-remove-job-initial",
      codeReviewId: 7,
      commentId: 55,
      headSha: "abc123",
      payloadJson: "{}",
    });
    const initialRun = await seedStorage.createInteractionRun({
      interactionJobId: initialJob.job.id,
      tenantId: tenant.id,
      provider: "copilot-sdk",
      model: null,
      modelProfileName: null,
      providerBaseUrl: null,
      providerType: null,
      textGenerationModel: null,
    });
    await mkdir(join(workspaceRoot, initialJob.job.id, "workspace"), {
      recursive: true,
    });
    await writeFile(
      join(workspaceRoot, initialJob.job.id, "workspace", "README.md"),
      "workspace",
    );
    await mkdir(join(runLogDir, initialRun.id, "copilot"), { recursive: true });
    await writeFile(
      join(runLogDir, initialRun.id, "copilot", "session.json"),
      "{}",
    );

    const originalGetTenantDeletionSummary =
      StoreBackedStorage.prototype.getTenantDeletionSummary;
    const summarySpy = vi
      .spyOn(StoreBackedStorage.prototype, "getTenantDeletionSummary")
      .mockImplementationOnce(async function (
        this: StoreBackedStorage,
        tenantKey: string,
      ) {
        const summary = await originalGetTenantDeletionSummary.call(
          this,
          tenantKey,
        );
        const lateStorage = await openSqliteTestStorage(databasePath);
        const lateJob = await lateStorage.createOrGetInteractionJob({
          tenantId: tenant.id,
          dedupeKey: "tenant-remove-job-late",
          codeReviewId: 8,
          commentId: 56,
          headSha: "def456",
          payloadJson: "{}",
        });
        const lateRun = await lateStorage.createInteractionRun({
          interactionJobId: lateJob.job.id,
          tenantId: tenant.id,
          provider: "copilot-sdk",
          model: null,
          modelProfileName: null,
          providerBaseUrl: null,
          providerType: null,
          textGenerationModel: null,
        });
        await mkdir(join(workspaceRoot, lateJob.job.id, "workspace"), {
          recursive: true,
        });
        await writeFile(
          join(workspaceRoot, lateJob.job.id, "workspace", "README.md"),
          "late workspace",
        );
        await mkdir(join(runLogDir, lateRun.id, "copilot"), {
          recursive: true,
        });
        await writeFile(
          join(runLogDir, lateRun.id, "copilot", "session.json"),
          "{}",
        );
        return summary;
      });

    const exitCode = await runCli([
      "tenant",
      "remove",
      "--sqlite-database-path",
      databasePath,
      "--workspace-root",
      workspaceRoot,
      "--run-log-dir",
      runLogDir,
      "--yes",
      "--key",
      "https://gitlab.example.com/gitlab::123",
    ]);

    summarySpy.mockRestore();

    expect(exitCode).toBe(0);
    expect(countRows(databasePath, "tenants")).toBe(0);
    expect(countRows(databasePath, "interaction_jobs")).toBe(0);
    expect(countRows(databasePath, "interaction_runs")).toBe(0);
    await expect(
      pathExists(join(workspaceRoot, initialJob.job.id)),
    ).resolves.toBe(false);
    await expect(pathExists(join(runLogDir, initialRun.id))).resolves.toBe(
      false,
    );

    const workspaceEntries = await listDirectoryIfPresent(workspaceRoot);
    const runLogEntries = await listDirectoryIfPresent(runLogDir);
    expect(workspaceEntries).toEqual([]);
    expect(runLogEntries).toEqual([]);
  });
});

function countRows(databasePath: string, tableName: string): number {
  const database = new DatabaseSync(databasePath);
  const row = database
    .prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
    .get() as { count: number };
  database.close();
  return row.count;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function listDirectoryIfPresent(path: string): Promise<string[]> {
  if (!(await pathExists(path))) {
    return [];
  }

  const { readdir } = await import("node:fs/promises");
  return (await readdir(path)).sort();
}
