import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  listAll,
  type StorageHelpers,
} from "../src/storage/storage-helpers.js";
import type { CreateReviewFindingInput } from "../src/storage/contract/index.js";
import { openSqliteTestStorage } from "./helpers/storage.js";

describe("SqliteStorage review findings", () => {
  it("applies the baseline migration to an empty database", async () => {
    const databasePath = join(
      await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-storage-")),
      "storage.sqlite",
    );
    const _storage = await openSqliteTestStorage(databasePath);

    const verifiedDb = new DatabaseSync(databasePath);
    const tables = new Set(
      (
        verifiedDb
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
    );
    const migrations = verifiedDb
      .prepare("SELECT adapter_name, migration_id FROM storage_migrations")
      .all() as Array<{
      adapter_name: string;
      migration_id: string;
    }>;
    const columnNames = new Set(
      (
        verifiedDb
          .prepare("PRAGMA table_info(review_findings)")
          .all() as Array<{ name: string }>
      ).map((column) => column.name),
    );
    const indexes = verifiedDb
      .prepare("PRAGMA index_list(review_findings)")
      .all() as Array<{ name: string; unique: number }>;
    verifiedDb.close();

    expect([...tables]).toEqual(
      expect.arrayContaining([
        "storage_migrations",
        "model_profiles",
        "tenants",
        "interaction_jobs",
        "merge_request_snapshots",
        "interaction_runs",
        "review_findings",
        "interaction_run_metrics",
        "discussion_mappings",
      ]),
    );
    expect(migrations).toEqual([
      {
        adapter_name: "sqlite",
        migration_id: "sqlite:0001_v0_baseline",
      },
    ]);
    expect(columnNames.has("anchor_json")).toBe(true);
    expect(columnNames.has("interaction_run_id")).toBe(true);
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "review_findings_interaction_run_identity_key_idx",
          unique: 1,
        }),
      ]),
    );
  });

  it("records the baseline migration for an existing current-schema database without touching data", async () => {
    const databasePath = join(
      await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-storage-")),
      "storage.sqlite",
    );
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE tenants (
        id TEXT PRIMARY KEY,
        tenant_key TEXT NOT NULL UNIQUE,
        base_url TEXT NOT NULL,
        project_id INTEGER NOT NULL,
        api_token TEXT NOT NULL,
        webhook_secret TEXT NOT NULL,
        bot_user_id INTEGER,
        bot_username TEXT,
        model_profile_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(base_url, project_id)
      );
      INSERT INTO tenants VALUES (
        'tenant_1',
        'https://gitlab.example.com::123',
        'https://gitlab.example.com',
        123,
        'token',
        'secret',
        999,
        'review-bot',
        NULL,
        '2026-04-01T00:00:00.000Z',
        '2026-04-01T00:00:00.000Z'
      );
    `);
    database.close();

    const _storage = await openSqliteTestStorage(databasePath);

    const verifiedDb = new DatabaseSync(databasePath);
    const persistedTenant = verifiedDb
      .prepare("SELECT id, tenant_key FROM tenants WHERE id = ?")
      .get("tenant_1") as {
      id: string;
      tenant_key: string;
    };
    const migrations = verifiedDb
      .prepare("SELECT COUNT(*) AS count FROM storage_migrations")
      .get() as { count: number };
    verifiedDb.close();

    expect(persistedTenant).toEqual({
      id: "tenant_1",
      tenant_key: "https://gitlab.example.com::123",
    });
    expect(migrations.count).toBe(1);
  });

  it("returns latest prior finding state per identity and updates status in place", async () => {
    const databasePath = join(
      await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-storage-")),
      "storage.sqlite",
    );
    const storage = await openSqliteTestStorage(databasePath);

    const tenant = await storage.upsertTenant({
      baseUrl: "https://gitlab.example.com",
      projectId: 123,
      apiToken: "token",
      webhookSecret: "secret",
      botUserId: 999,
      botUsername: "review-bot",
    });

    await createCompletedRun(
      storage,
      tenant.id,
      tenant.projectId,
      7,
      55,
      "head-one",
      [
        createFinding({
          identityKey: "identity_existing",
          title: "Validate request body",
          body: "First version",
          status: "open",
        }),
        createFinding({
          identityKey: "identity_other",
          title: "Check permissions",
          body: "Still open",
          status: "open",
        }),
      ],
    );

    await createCompletedRun(
      storage,
      tenant.id,
      tenant.projectId,
      7,
      56,
      "head-two",
      [
        createFinding({
          identityKey: "identity_existing",
          title: "Validate request body",
          body: "Latest version",
          status: "open",
          suggestionJson: JSON.stringify({
            replacement: "validate(body);",
            startLine: 12,
            endLine: 12,
          }),
        }),
      ],
    );

    const currentJob = await storage.createOrGetInteractionJob({
      tenantId: tenant.id,
      dedupeKey: "current-job",
      projectId: tenant.projectId,
      mergeRequestIid: 7,
      noteId: 57,
      headSha: "head-current",
      payloadJson: "{}",
    });

    expect(
      await storage.updateReviewFindingStatus(
        tenant.id,
        7,
        "identity_existing",
        "dismissed",
      ),
    ).toBe(true);

    const priorFindings = await storage.listPriorReviewFindings(
      tenant.id,
      7,
      currentJob.job.id,
    );
    const persistedStatuses = readFindingStatuses(
      databasePath,
      "identity_existing",
    );

    expect(priorFindings).toHaveLength(2);
    expect(priorFindings[0]).toMatchObject({
      identityKey: "identity_other",
      status: "open",
    });
    expect(priorFindings[1]).toMatchObject({
      identityKey: "identity_existing",
      status: "dismissed",
      title: "Validate request body",
      body: "Latest version",
      interactionRunId: expect.any(String),
      headSha: "head-two",
    });
    expect(priorFindings[1]?.anchor).toEqual({
      path: "src/api.ts",
      startLine: 12,
      endLine: 12,
      side: "new",
    });
    expect(priorFindings[1]?.suggestion).toEqual({
      replacement: "validate(body);",
      startLine: 12,
      endLine: 12,
    });
    expect(persistedStatuses).toEqual(["dismissed", "dismissed"]);
  });

  it("updates status on the latest completed finding row even when a newer failed run exists", async () => {
    const databasePath = join(
      await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-storage-")),
      "storage.sqlite",
    );
    const storage = await openSqliteTestStorage(databasePath);

    const tenant = await storage.upsertTenant({
      baseUrl: "https://gitlab.example.com",
      projectId: 123,
      apiToken: "token",
      webhookSecret: "secret",
      botUserId: 999,
      botUsername: "review-bot",
    });

    await createCompletedRun(
      storage,
      tenant.id,
      tenant.projectId,
      7,
      70,
      "head-completed",
      [
        createFinding({
          identityKey: "identity_status",
          title: "Persist status on completed run",
          body: "Completed version",
          status: "open",
        }),
      ],
    );

    await createFailedRun(
      storage,
      tenant.id,
      tenant.projectId,
      7,
      71,
      "head-failed",
      [
        createFinding({
          identityKey: "identity_status",
          title: "Persist status on completed run",
          body: "Failed version",
          status: "open",
        }),
      ],
    );

    expect(
      await storage.updateReviewFindingStatus(
        tenant.id,
        7,
        "identity_status",
        "dismissed",
      ),
    ).toBe(true);

    const currentJob = await storage.createOrGetInteractionJob({
      tenantId: tenant.id,
      dedupeKey: "current-job-after-failed-run",
      projectId: tenant.projectId,
      mergeRequestIid: 7,
      noteId: 72,
      headSha: "head-current",
      payloadJson: "{}",
    });

    const priorFindings = await storage.listPriorReviewFindings(
      tenant.id,
      7,
      currentJob.job.id,
    );
    expect(priorFindings).toHaveLength(1);
    expect(priorFindings[0]).toMatchObject({
      identityKey: "identity_status",
      status: "dismissed",
      body: "Completed version",
      headSha: "head-completed",
    });
    expect(readFindingStatuses(databasePath, "identity_status")).toEqual([
      "dismissed",
    ]);
  });

  it("records the baseline migration only once across repeated initialization", async () => {
    const databasePath = join(
      await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-storage-")),
      "storage.sqlite",
    );
    const first = await openSqliteTestStorage(databasePath);
    await first.close();

    const second = await openSqliteTestStorage(databasePath);
    await second.close();

    const verifiedDb = new DatabaseSync(databasePath);
    const migrations = verifiedDb
      .prepare("SELECT migration_id FROM storage_migrations")
      .all() as Array<{ migration_id: string }>;
    verifiedDb.close();

    expect(migrations).toEqual([{ migration_id: "sqlite:0001_v0_baseline" }]);
  });

  it("stores only one finding row per identity for a review run", async () => {
    const databasePath = join(
      await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-storage-")),
      "storage.sqlite",
    );
    const storage = await openSqliteTestStorage(databasePath);

    const tenant = await storage.upsertTenant({
      baseUrl: "https://gitlab.example.com",
      projectId: 123,
      apiToken: "token",
      webhookSecret: "secret",
      botUserId: 999,
      botUsername: "review-bot",
    });

    const job = await storage.createOrGetInteractionJob({
      tenantId: tenant.id,
      dedupeKey: "dedupe-write-path",
      projectId: tenant.projectId,
      mergeRequestIid: 7,
      noteId: 80,
      headSha: "head-dedupe",
      payloadJson: "{}",
    });
    const run = await storage.createInteractionRun({
      interactionJobId: job.job.id,
      tenantId: tenant.id,
      provider: "copilot-sdk",
      model: null,
      modelProfileName: null,
      providerBaseUrl: null,
      providerType: null,
      textGenerationModel: null,
    });

    await storage.replaceReviewFindings(run.id, [
      createFinding({
        identityKey: "identity_duplicate",
        title: "Validate request body",
        body: "First copy",
        status: "open",
      }),
      createFinding({
        identityKey: "identity_duplicate",
        title: "Validate request body",
        body: "Last copy wins",
        status: "open",
      }),
    ]);

    const persistedRows = readFindingRows(databasePath, "identity_duplicate");

    expect(persistedRows).toEqual([
      expect.objectContaining({
        status: "open",
        body: "Last copy wins",
      }),
    ]);
  });
});

describe("SqliteStorage tenants", () => {
  it("stores model profiles, tenant assignments, and resolved review run config", async () => {
    const databasePath = join(
      await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-storage-")),
      "storage.sqlite",
    );
    const storage = await openSqliteTestStorage(databasePath);

    const defaultProfile = await storage.upsertModelProfile({
      name: "native-default",
      providerBaseUrl: null,
      providerType: null,
      wireApi: null,
      authToken: null,
      reviewModel: "gpt-5.4",
      textGenerationModel: "gpt-5.4-mini",
      isDefault: true,
    });
    await storage.upsertModelProfile({
      name: "byok",
      providerBaseUrl: "https://llm.example.com/v1",
      providerType: "openai",
      wireApi: "responses",
      authToken: "secret-token",
      reviewModel: "custom-review",
      textGenerationModel: "custom-text",
      isDefault: false,
    });

    const tenant = await storage.upsertTenant({
      baseUrl: "https://gitlab.example.com",
      projectId: 123,
      apiToken: "token",
      webhookSecret: "secret",
      botUserId: 999,
      botUsername: "review-bot",
      modelProfileName: "byok",
    });
    const job = await storage.createOrGetInteractionJob({
      tenantId: tenant.id,
      dedupeKey: "profiled-job",
      projectId: tenant.projectId,
      mergeRequestIid: 7,
      noteId: 55,
      headSha: "head-profiled",
      payloadJson: "{}",
    });
    const run = await storage.createInteractionRun({
      interactionJobId: job.job.id,
      tenantId: tenant.id,
      provider: "copilot-sdk",
      model: "custom-review",
      modelProfileName: "byok",
      providerBaseUrl: "https://llm.example.com/v1",
      providerType: "openai",
      textGenerationModel: "custom-text",
    });

    expect(defaultProfile.isDefault).toBe(true);
    expect(
      (await storage.stores.modelProfiles.find({ isDefault: { eq: true } }))
        ?.name,
    ).toBe("native-default");
    expect(await listAll(storage.stores.modelProfiles)).toHaveLength(2);
    expect(tenant.modelProfileName).toBe("byok");
    expect((await storage.stores.modelProfiles.get("byok"))?.wireApi).toBe(
      "responses",
    );
    expect(run).toMatchObject({
      model: "custom-review",
      modelProfileName: "byok",
      providerBaseUrl: "https://llm.example.com/v1",
      providerType: "openai",
      textGenerationModel: "custom-text",
    });
  });

  it("refuses to delete a model profile while a tenant still references it", async () => {
    const databasePath = join(
      await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-storage-")),
      "storage.sqlite",
    );
    const storage = await openSqliteTestStorage(databasePath);

    await storage.upsertModelProfile({
      name: "shared-profile",
      providerBaseUrl: null,
      providerType: null,
      authToken: null,
      reviewModel: "gpt-5.4",
      textGenerationModel: null,
      isDefault: false,
    });
    await storage.upsertTenant({
      baseUrl: "https://gitlab.example.com",
      projectId: 123,
      apiToken: "token",
      webhookSecret: "secret",
      botUserId: 999,
      botUsername: "review-bot",
      modelProfileName: "shared-profile",
    });

    await expect(storage.deleteModelProfile("shared-profile")).rejects.toThrow(
      "still reference",
    );
  });

  it("deletes a tenant by normalized base URL and project ID", async () => {
    const databasePath = join(
      await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-storage-")),
      "storage.sqlite",
    );
    const storage = await openSqliteTestStorage(databasePath);

    await storage.upsertTenant({
      baseUrl: "https://gitlab.example.com/gitlab/",
      projectId: 123,
      apiToken: "token-one",
      webhookSecret: "secret-one",
      botUserId: 999,
      botUsername: "review-bot",
    });
    const secondTenant = await storage.upsertTenant({
      baseUrl: "https://gitlab.example.com",
      projectId: 456,
      apiToken: "token-two",
      webhookSecret: "secret-two",
      botUserId: 1000,
      botUsername: "review-bot-2",
    });

    const deletedTenant =
      (
        await storage.deleteTenantWithSummary(
          "https://gitlab.example.com/gitlab",
          123,
        )
      )?.tenant ?? null;
    const remainingTenants = await listAll(storage.stores.tenants);

    expect(deletedTenant).toMatchObject({
      baseUrl: "https://gitlab.example.com/gitlab/",
      projectId: 123,
    });
    expect(remainingTenants).toHaveLength(1);
    expect(remainingTenants[0]).toMatchObject({
      id: secondTenant.id,
      baseUrl: "https://gitlab.example.com",
      projectId: 456,
    });
  });

  it("deletes dependent review data before removing a tenant", async () => {
    const databasePath = join(
      await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-storage-")),
      "storage.sqlite",
    );
    const storage = await openSqliteTestStorage(databasePath);

    const tenant = await storage.upsertTenant({
      baseUrl: "https://gitlab.example.com/gitlab",
      projectId: 123,
      apiToken: "token-one",
      webhookSecret: "secret-one",
      botUserId: 999,
      botUsername: "review-bot",
    });

    const reviewJob = await storage.createOrGetInteractionJob({
      tenantId: tenant.id,
      dedupeKey: "delete-tenant-job",
      projectId: tenant.projectId,
      mergeRequestIid: 7,
      noteId: 55,
      headSha: "head-sha",
      payloadJson: "{}",
    });
    await storage.createMergeRequestSnapshot({
      interactionJobId: reviewJob.job.id,
      tenantId: tenant.id,
      mergeRequestIid: 7,
      headSha: "head-sha",
      mergeRequestJson: "{}",
      versionsJson: "[]",
      changesJson: "[]",
      notesJson: "[]",
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
        ...createFinding({
          identityKey: "delete-tenant-finding",
          title: "Delete tenant finding",
          body: "The finding should be removed",
          status: "open",
        }),
        interactionRunId: reviewRun.id,
      },
    ]);
    await storage.upsertInteractionRunMetrics({
      interactionRunId: reviewRun.id,
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
      repeatedViewPathsJson: "[]",
    });
    await storage.upsertDiscussionMapping({
      tenantId: tenant.id,
      projectId: tenant.projectId,
      mergeRequestIid: 7,
      identityKey: "delete-tenant-finding",
      findingFingerprint: "fingerprint-1",
      title: "Delete tenant finding",
      severity: "medium",
      category: "correctness",
      body: "The finding should be removed",
      gitlabDiscussionId: "discussion-1",
      gitlabNoteId: 501,
      anchorJson: null,
      positionJson: null,
      botDiscussion: true,
      botNote: true,
      noteAuthorId: 999,
      noteAuthorUsername: "review-bot",
      status: "open",
      lastInteractionRunId: reviewRun.id,
    });

    const deletionSummary = await storage.getTenantDeletionSummary(
      tenant.baseUrl,
      tenant.projectId,
    );
    expect(deletionSummary).toMatchObject({
      interactionJobCount: 1,
      mergeRequestSnapshotCount: 1,
      interactionRunCount: 1,
      reviewFindingCount: 1,
      interactionRunMetricCount: 1,
      discussionMappingCount: 1,
      interactionJobIds: [reviewJob.job.id],
      interactionRunIds: [reviewRun.id],
    });

    const deletedSummary = await storage.deleteTenantWithSummary(
      tenant.baseUrl,
      tenant.projectId,
    );

    expect(deletedSummary).toMatchObject({
      tenant: {
        id: tenant.id,
      },
      interactionJobIds: [reviewJob.job.id],
      interactionRunIds: [reviewRun.id],
    });
    expect(countRows(databasePath, "tenants")).toBe(0);
    expect(countRows(databasePath, "interaction_jobs")).toBe(0);
    expect(countRows(databasePath, "merge_request_snapshots")).toBe(0);
    expect(countRows(databasePath, "interaction_runs")).toBe(0);
    expect(countRows(databasePath, "review_findings")).toBe(0);
    expect(countRows(databasePath, "interaction_run_metrics")).toBe(0);
    expect(countRows(databasePath, "discussion_mappings")).toBe(0);
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

function readFindingStatuses(
  databasePath: string,
  identityKey: string,
): string[] {
  return readFindingRows(databasePath, identityKey).map((row) => row.status);
}

function readFindingRows(
  databasePath: string,
  identityKey: string,
): Array<{
  id: string;
  interaction_run_id: string;
  status: string;
  body: string;
}> {
  const database = new DatabaseSync(databasePath);
  const rows = database
    .prepare(
      "SELECT id, interaction_run_id, status, body FROM review_findings WHERE identity_key = ? ORDER BY interaction_run_id ASC, id ASC",
    )
    .all(identityKey) as Array<{
    id: string;
    interaction_run_id: string;
    status: string;
    body: string;
  }>;
  database.close();
  return rows;
}

function createFinding(input: {
  identityKey: string;
  title: string;
  body: string;
  status: CreateReviewFindingInput["status"];
  suggestionJson?: string | null;
}): CreateReviewFindingInput {
  return {
    interactionRunId: "",
    identityKey: input.identityKey,
    severity: "medium",
    category: "correctness",
    title: input.title,
    body: input.body,
    anchorJson: JSON.stringify({
      path: "src/api.ts",
      startLine: 12,
      endLine: 12,
      side: "new",
    }),
    suggestionJson: input.suggestionJson ?? null,
    status: input.status,
  };
}

async function createCompletedRun(
  storage: StorageHelpers,
  tenantId: string,
  projectId: number,
  mergeRequestIid: number,
  noteId: number,
  headSha: string,
  findings: CreateReviewFindingInput[],
): Promise<void> {
  const job = await storage.createOrGetInteractionJob({
    tenantId,
    dedupeKey: `job-${noteId}`,
    projectId,
    mergeRequestIid,
    noteId,
    headSha,
    payloadJson: "{}",
  });
  const run = await storage.createInteractionRun({
    interactionJobId: job.job.id,
    tenantId,
    provider: "copilot-sdk",
    model: null,
    modelProfileName: null,
    providerBaseUrl: null,
    providerType: null,
    textGenerationModel: null,
  });
  await storage.completeInteractionRun(
    run.id,
    JSON.stringify({
      overview: {
        summary: "Summary",
        overallSeverity: "medium",
      },
      findings: [],
      priorDispositions: [],
    }),
  );
  await storage.replaceReviewFindings(
    run.id,
    findings.map((finding) => ({
      ...finding,
      interactionRunId: run.id,
    })),
  );
}

async function createFailedRun(
  storage: StorageHelpers,
  tenantId: string,
  projectId: number,
  mergeRequestIid: number,
  noteId: number,
  headSha: string,
  findings: CreateReviewFindingInput[],
): Promise<void> {
  const job = await storage.createOrGetInteractionJob({
    tenantId,
    dedupeKey: `failed-job-${noteId}`,
    projectId,
    mergeRequestIid,
    noteId,
    headSha,
    payloadJson: "{}",
  });
  const run = await storage.createInteractionRun({
    interactionJobId: job.job.id,
    tenantId,
    provider: "copilot-sdk",
    model: null,
    modelProfileName: null,
    providerBaseUrl: null,
    providerType: null,
    textGenerationModel: null,
  });
  await storage.replaceReviewFindings(
    run.id,
    findings.map((finding) => ({
      ...finding,
      interactionRunId: run.id,
    })),
  );
  await storage.failInteractionRun(run.id, "synthetic failure");
}

async function createCancelledRun(
  storage: StorageHelpers,
  tenantId: string,
  projectId: number,
  mergeRequestIid: number,
  noteId: number,
  headSha: string,
  findings: CreateReviewFindingInput[],
): Promise<void> {
  const job = await storage.createOrGetInteractionJob({
    tenantId,
    dedupeKey: `cancelled-job-${noteId}`,
    projectId,
    mergeRequestIid,
    noteId,
    headSha,
    payloadJson: "{}",
  });
  const run = await storage.createInteractionRun({
    interactionJobId: job.job.id,
    tenantId,
    provider: "copilot-sdk",
    model: null,
    modelProfileName: null,
    providerBaseUrl: null,
    providerType: null,
    textGenerationModel: null,
  });
  await storage.replaceReviewFindings(
    run.id,
    findings.map((finding) => ({
      ...finding,
      interactionRunId: run.id,
    })),
  );
  await storage.cancelInteractionRun(run.id, "synthetic cancellation");
  await storage.markJobCancelled(job.job.id, 1, "synthetic cancellation");
}

describe("SqliteStorage cancelled runs", () => {
  it("persists cancelled job and run statuses and removes run findings", async () => {
    const databasePath = join(
      await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-storage-")),
      "storage.sqlite",
    );
    const storage = await openSqliteTestStorage(databasePath);
    const tenant = await storage.upsertTenant({
      baseUrl: "https://gitlab.example.com",
      projectId: 123,
      apiToken: "token",
      webhookSecret: "secret",
      botUserId: 999,
      botUsername: "review-bot",
    });

    await createCancelledRun(
      storage,
      tenant.id,
      tenant.projectId,
      7,
      88,
      "head-cancelled",
      [
        createFinding({
          identityKey: "cancelled-finding",
          title: "Cancelled finding",
          body: "This finding should be removed on cancellation.",
          status: "open",
        }),
      ],
    );

    const cancelledJob = await storage.stores.interactionJobs.find({
      dedupeKey: { eq: "cancelled-job-88" },
    });
    expect(cancelledJob?.status).toBe("cancelled");
    expect(cancelledJob?.lastError).toBe("synthetic cancellation");

    const cancelledRun = await storage.stores.interactionRuns.find({
      interactionJobId: { eq: cancelledJob?.id ?? "missing" },
    });
    expect(cancelledRun?.status).toBe("cancelled");
    expect(cancelledRun?.error).toBe("synthetic cancellation");

    const remainingFindings = await listAll(storage.stores.reviewFindings, {
      filters: { interactionRunId: { eq: cancelledRun?.id ?? "missing" } },
    });
    expect(remainingFindings).toEqual([]);
  });
});
