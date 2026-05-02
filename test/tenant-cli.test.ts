import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";
import { createLogger } from "../src/logger.js";
import { SqliteStorage } from "../src/storage/sqlite-storage.js";
import { TenantRegistry } from "../src/tenants/tenant-registry.js";

function createPayload() {
  return {
    object_kind: "note" as const,
    project: {
      id: 123,
      web_url: "https://gitlab.example.com/group/project"
    },
    repository: {
      homepage: "https://gitlab.example.com/group/project"
    },
    merge_request: {
      iid: 7,
      title: "Add worker",
      description: "Adds the worker",
      source_branch: "feature",
      target_branch: "main",
      last_commit: {
        id: "abc123"
      }
    },
    object_attributes: {
      id: 55,
      note: "please /review this",
      noteable_type: "MergeRequest" as const,
      url: "https://gitlab.example.com/group/project/-/merge_requests/7#note_55"
    }
  };
}

describe("tenant CLI", () => {
  it("adds a tenant to SQLite and makes it resolvable without env registration", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-"));
    const databasePath = join(workspace, "tenants.sqlite");

    const exitCode = await runCli([
      "tenant",
      "add",
      "--database-path",
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
      "review-bot"
    ]);

    expect(exitCode).toBe(0);

    const storage = new SqliteStorage({ databasePath });
    await storage.initialize();

    const tenants = await storage.listTenants();
    expect(tenants).toHaveLength(1);
    expect(tenants[0]).toMatchObject({
      baseUrl: "https://gitlab.example.com",
      projectId: 123,
      botUserId: 999,
      botUsername: "review-bot"
    });

    const registry = new TenantRegistry({
      storage
    });
    await registry.initialize();

    const tenant = await registry.resolveWebhookTenant(createPayload(), "replace-me");
    expect(tenant).not.toBeNull();
    expect(tenant?.projectId).toBe(123);

    const logger = createLogger("silent");
    logger.info({ tenantId: tenant?.id }, "tenant resolved");
  });

  it("requires bot username when adding a tenant", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-"));
    const databasePath = join(workspace, "tenants.sqlite");

    await expect(
      runCli([
        "tenant",
        "add",
        "--database-path",
        databasePath,
        "--base-url",
        "https://gitlab.example.com",
        "--project-id",
        "123",
        "--api-token",
        "glpat-xxxxxxxx",
        "--webhook-secret",
        "replace-me"
      ])
    ).rejects.toThrow();
  });

  it("removes a tenant by base URL and project ID", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-"));
    const databasePath = join(workspace, "tenants.sqlite");

    await runCli([
      "tenant",
      "add",
      "--database-path",
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
      "review-bot"
    ]);

    let stdout = "";
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    });

    const exitCode = await runCli([
      "tenant",
      "remove",
      "--database-path",
      databasePath,
      "--yes",
      "--base-url",
      "https://gitlab.example.com/gitlab",
      "--project-id",
      "123"
    ]);

    stdoutSpy.mockRestore();

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Tenant removed.");
    expect(stdout).toContain("https://gitlab.example.com/gitlab :: 123");

    const storage = new SqliteStorage({ databasePath });
    await storage.initialize();
    expect(await storage.listTenants()).toEqual([]);

    const registry = new TenantRegistry({
      storage
    });
    await registry.initialize();

    const tenant = await registry.resolveWebhookTenant(createPayload(), "replace-me");
    expect(tenant).toBeNull();
  });

  it("refuses tenant removal without confirmation in non-interactive mode", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-"));
    const databasePath = join(workspace, "tenants.sqlite");

    await runCli([
      "tenant",
      "add",
      "--database-path",
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
      "review-bot"
    ]);

    let stdout = "";
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    });

    const exitCode = await runCli([
      "tenant",
      "remove",
      "--database-path",
      databasePath,
      "--base-url",
      "https://gitlab.example.com",
      "--project-id",
      "123"
    ]);

    stdoutSpy.mockRestore();

    expect(exitCode).toBe(1);
    expect(stdout).toContain("Preparing to remove tenant https://gitlab.example.com :: 123");
    expect(stdout).toContain("Tenant removal requires confirmation. Re-run with --yes in non-interactive mode.");
  });

  it("removes tenant database rows and local artifacts for tenants with review history", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-"));
    const databasePath = join(workspace, "tenants.sqlite");
    const workspaceRoot = join(workspace, "review-workspaces");
    const runLogDir = join(workspace, "run-logs");

    const storage = new SqliteStorage({ databasePath });
    await storage.initialize();

    const tenant = await storage.upsertTenant({
      baseUrl: "https://gitlab.example.com/gitlab",
      projectId: 123,
      apiToken: "glpat-xxxxxxxx",
      webhookSecret: "replace-me",
      botUserId: 999,
      botUsername: "review-bot"
    });
    const reviewJob = await storage.createOrGetReviewJob({
      tenantId: tenant.id,
      dedupeKey: "tenant-remove-job",
      projectId: tenant.projectId,
      mergeRequestIid: 7,
      noteId: 55,
      headSha: "abc123",
      payloadJson: "{}"
    });
    await storage.createMergeRequestSnapshot({
      reviewJobId: reviewJob.job.id,
      tenantId: tenant.id,
      mergeRequestIid: 7,
      headSha: "abc123",
      mergeRequestJson: "{}",
      versionsJson: "[]",
      changesJson: "[]",
      notesJson: "[]",
      discussionsJson: "[]",
      instructionsJson: "[]",
      projectMemoryJson: null,
      workspaceStrategy: "git"
    });
    const reviewRun = await storage.createReviewRun({
      reviewJobId: reviewJob.job.id,
      tenantId: tenant.id,
      provider: "copilot-sdk",
      model: null
    });
    await storage.replaceReviewFindings(reviewRun.id, [
      {
        reviewRunId: reviewRun.id,
        identityKey: "tenant-remove-finding",
        severity: "medium",
        category: "correctness",
        title: "Tenant remove finding",
        body: "This data should be removed",
        anchorJson: null,
        suggestionJson: null,
        status: "open"
      }
    ]);
    await storage.upsertReviewRunMetrics({
      reviewRunId: reviewRun.id,
      triggerKind: "note",
      promptMode: "full",
      promptChars: 10,
      promptContextChangedFiles: 1,
      promptContextPriorThreads: 0,
      promptContextNotes: 1,
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
      repeatedViewPathsJson: "[]"
    });
    await storage.upsertDiscussionMapping({
      tenantId: tenant.id,
      projectId: tenant.projectId,
      mergeRequestIid: 7,
      identityKey: "tenant-remove-finding",
      findingFingerprint: "tenant-remove-fingerprint",
      title: "Tenant remove finding",
      severity: "medium",
      category: "correctness",
      body: "This data should be removed",
      gitlabDiscussionId: "discussion-1",
      gitlabNoteId: 501,
      anchorJson: null,
      positionJson: null,
      botDiscussion: true,
      botNote: true,
      noteAuthorId: 999,
      noteAuthorUsername: "review-bot",
      status: "open",
      lastReviewRunId: reviewRun.id
    });

    await mkdir(join(workspaceRoot, reviewJob.job.id, "workspace"), { recursive: true });
    await writeFile(join(workspaceRoot, reviewJob.job.id, "workspace", "README.md"), "workspace");
    await mkdir(join(runLogDir, reviewRun.id, "copilot"), { recursive: true });
    await writeFile(join(runLogDir, reviewRun.id, "copilot", "session.json"), "{}");

    let stdout = "";
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    });

    const exitCode = await runCli([
      "tenant",
      "remove",
      "--database-path",
      databasePath,
      "--workspace-root",
      workspaceRoot,
      "--run-log-dir",
      runLogDir,
      "--yes",
      "--base-url",
      "https://gitlab.example.com/gitlab",
      "--project-id",
      "123"
    ]);

    stdoutSpy.mockRestore();

    expect(exitCode).toBe(0);
    expect(stdout).toContain("This will delete:");
    expect(stdout).toContain("- 1 review job");
    expect(stdout).toContain("- 1/1 workspace directory");
    expect(stdout).toContain("- 1/1 run log directory");
    expect(stdout).toContain("Tenant removed.");

    expect(await storage.listTenants()).toEqual([]);
    expect(countRows(databasePath, "review_jobs")).toBe(0);
    expect(countRows(databasePath, "merge_request_snapshots")).toBe(0);
    expect(countRows(databasePath, "review_runs")).toBe(0);
    expect(countRows(databasePath, "review_findings")).toBe(0);
    expect(countRows(databasePath, "review_run_metrics")).toBe(0);
    expect(countRows(databasePath, "discussion_mappings")).toBe(0);
    await expect(pathExists(join(workspaceRoot, reviewJob.job.id))).resolves.toBe(false);
    await expect(pathExists(join(runLogDir, reviewRun.id))).resolves.toBe(false);
  });

  it("removes artifacts created after the preview summary but before the final delete", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-"));
    const databasePath = join(workspace, "tenants.sqlite");
    const workspaceRoot = join(workspace, "review-workspaces");
    const runLogDir = join(workspace, "run-logs");

    const seedStorage = new SqliteStorage({ databasePath });
    await seedStorage.initialize();

    const tenant = await seedStorage.upsertTenant({
      baseUrl: "https://gitlab.example.com/gitlab",
      projectId: 123,
      apiToken: "glpat-xxxxxxxx",
      webhookSecret: "replace-me",
      botUserId: 999,
      botUsername: "review-bot"
    });
    const initialJob = await seedStorage.createOrGetReviewJob({
      tenantId: tenant.id,
      dedupeKey: "tenant-remove-job-initial",
      projectId: tenant.projectId,
      mergeRequestIid: 7,
      noteId: 55,
      headSha: "abc123",
      payloadJson: "{}"
    });
    const initialRun = await seedStorage.createReviewRun({
      reviewJobId: initialJob.job.id,
      tenantId: tenant.id,
      provider: "copilot-sdk",
      model: null
    });
    await mkdir(join(workspaceRoot, initialJob.job.id, "workspace"), { recursive: true });
    await writeFile(join(workspaceRoot, initialJob.job.id, "workspace", "README.md"), "workspace");
    await mkdir(join(runLogDir, initialRun.id, "copilot"), { recursive: true });
    await writeFile(join(runLogDir, initialRun.id, "copilot", "session.json"), "{}");

    const originalGetTenantDeletionSummary = SqliteStorage.prototype.getTenantDeletionSummary;
    const summarySpy = vi
      .spyOn(SqliteStorage.prototype, "getTenantDeletionSummary")
      .mockImplementationOnce(async function (this: SqliteStorage, baseUrl: string, projectId: number) {
        const summary = await originalGetTenantDeletionSummary.call(this, baseUrl, projectId);
        const lateStorage = new SqliteStorage({ databasePath });
        await lateStorage.initialize();
        const lateJob = await lateStorage.createOrGetReviewJob({
          tenantId: tenant.id,
          dedupeKey: "tenant-remove-job-late",
          projectId: tenant.projectId,
          mergeRequestIid: 8,
          noteId: 56,
          headSha: "def456",
          payloadJson: "{}"
        });
        const lateRun = await lateStorage.createReviewRun({
          reviewJobId: lateJob.job.id,
          tenantId: tenant.id,
          provider: "copilot-sdk",
          model: null
        });
        await mkdir(join(workspaceRoot, lateJob.job.id, "workspace"), { recursive: true });
        await writeFile(join(workspaceRoot, lateJob.job.id, "workspace", "README.md"), "late workspace");
        await mkdir(join(runLogDir, lateRun.id, "copilot"), { recursive: true });
        await writeFile(join(runLogDir, lateRun.id, "copilot", "session.json"), "{}");
        return summary;
      });

    const exitCode = await runCli([
      "tenant",
      "remove",
      "--database-path",
      databasePath,
      "--workspace-root",
      workspaceRoot,
      "--run-log-dir",
      runLogDir,
      "--yes",
      "--base-url",
      "https://gitlab.example.com/gitlab",
      "--project-id",
      "123"
    ]);

    summarySpy.mockRestore();

    expect(exitCode).toBe(0);
    expect(countRows(databasePath, "tenants")).toBe(0);
    expect(countRows(databasePath, "review_jobs")).toBe(0);
    expect(countRows(databasePath, "review_runs")).toBe(0);
    await expect(pathExists(join(workspaceRoot, initialJob.job.id))).resolves.toBe(false);
    await expect(pathExists(join(runLogDir, initialRun.id))).resolves.toBe(false);

    const workspaceEntries = await listDirectoryIfPresent(workspaceRoot);
    const runLogEntries = await listDirectoryIfPresent(runLogDir);
    expect(workspaceEntries).toEqual([]);
    expect(runLogEntries).toEqual([]);
  });
});

function countRows(databasePath: string, tableName: string): number {
  const database = new DatabaseSync(databasePath);
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number };
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
