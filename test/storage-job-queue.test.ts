import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  CURRENT_STORAGE_CONTRACT_REVISION,
  STORAGE_CONTRACT_HISTORY,
  type InteractionJobRecord,
} from "../src/storage/contract/index.js";
import { SqliteStorageProvider } from "../src/storage/adapters/sqlite/provider.js";
import { openSqliteTestStorage } from "./helpers/storage.js";
import { createGitLabTenantInput } from "./helpers/gitlab-tenant.js";

async function databaseFile(): Promise<string> {
  return join(
    await mkdtemp(join(tmpdir(), "reviewphin-job-queue-")),
    "storage.sqlite",
  );
}

async function setupStorage(
  now: () => string = () => "2026-06-01T01:01:00.000Z",
) {
  const storage = await openSqliteTestStorage(await databaseFile(), { now });
  const tenant = await storage.upsertTenant(createGitLabTenantInput());
  return { storage, tenantId: tenant.id };
}

function makeJob(
  tenantId: string,
  overrides: Partial<InteractionJobRecord> & {
    id: string;
    dedupeKey: string;
  },
): InteractionJobRecord {
  return {
    tenantId,
    codeReviewId: 7,
    commentId: 1,
    triggerJson: '{"kind":"comment","commentId":1}',
    headSha: "abc123",
    status: "queued",
    payloadJson: "{}",
    retryCount: 0,
    lastError: null,
    enqueuedAt: "2026-06-01T00:00:00.000Z",
    availableAt: "2026-06-01T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    claimToken: null,
    claimedBy: null,
    claimExpiresAt: null,
    latestInteractionRunId: null,
    ...overrides,
  };
}

const QUEUED_AFTER = "2020-01-01T00:00:00.000Z";

describe("storage-v006 contract history", () => {
  it("reports storage-v006 as the current breaking revision", () => {
    expect(CURRENT_STORAGE_CONTRACT_REVISION).toBe("storage-v006");
    const last = STORAGE_CONTRACT_HISTORY.at(-1);
    expect(last?.id).toBe("storage-v006");
    expect(last?.changeKind).toBe("breaking");
    expect(last?.affectedSurfaces).toContain("interaction-run-metrics");
  });

  it("keeps historical revisions unchanged", () => {
    expect(STORAGE_CONTRACT_HISTORY.map((entry) => entry.id)).toEqual([
      "storage-v000",
      "storage-v001",
      "storage-v002",
      "storage-v003",
      "storage-v004",
      "storage-v005",
      "storage-v006",
    ]);
  });
});

describe("sqlite adapter revision", () => {
  it("reports storage-v006", () => {
    const provider = new SqliteStorageProvider({
      databasePath: ":memory:",
    });
    expect(provider.getSupportedStorageContract()).toBe("storage-v006");
  });
});

describe("sqlite migration 0011 backfill and preservation", () => {
  it("backfills available_at, preserves rows, and adds claim columns and indexes", async () => {
    const databasePath = await databaseFile();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE storage_migrations (
        adapter_name TEXT NOT NULL,
        migration_id TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        PRIMARY KEY (adapter_name, migration_id)
      );
      INSERT INTO storage_migrations VALUES
        ('sqlite', 'sqlite:0001_v0_baseline', '2026-04-01T00:00:00.000Z'),
        ('sqlite', 'sqlite:0002_v1_platform_tenants', '2026-04-01T00:00:00.000Z'),
        ('sqlite', 'sqlite:0003_v1_review_entity_ids', '2026-04-01T00:00:00.000Z'),
        ('sqlite', 'sqlite:0004_v1_tenant_scoped_reviews', '2026-04-01T00:00:00.000Z'),
        ('sqlite', 'sqlite:0005_v1_code_review_snapshots', '2026-04-01T00:00:00.000Z'),
        ('sqlite', 'sqlite:0006_v1_drop_legacy_tenant_columns', '2026-04-01T00:00:00.000Z'),
        ('sqlite', 'sqlite:0007_v1_generic_storage_column_names', '2026-04-01T00:00:00.000Z'),
        ('sqlite', 'sqlite:0008_v2_platform_connections', '2026-04-01T00:00:00.000Z'),
        ('sqlite', 'sqlite:0009_v3_provider_triggers', '2026-04-01T00:00:00.000Z'),
        ('sqlite', 'sqlite:0010_v4_project_memories', '2026-04-01T00:00:00.000Z');
      CREATE TABLE tenants (
        id TEXT PRIMARY KEY,
        tenant_key TEXT NOT NULL UNIQUE,
        platform TEXT NOT NULL,
        platform_connection_id TEXT,
        platform_config_json TEXT NOT NULL,
        model_profile_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE model_profiles (
        name TEXT PRIMARY KEY,
        provider_base_url TEXT,
        provider_type TEXT,
        wire_api TEXT,
        auth_token TEXT,
        review_model TEXT,
        text_generation_model TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE interaction_jobs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        code_review_id INTEGER NOT NULL,
        comment_id INTEGER,
        trigger_json TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        enqueued_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id)
      );
      CREATE TABLE code_review_snapshots (
        id TEXT PRIMARY KEY,
        interaction_job_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        code_review_id INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        code_review_json TEXT NOT NULL,
        versions_json TEXT NOT NULL,
        changes_json TEXT NOT NULL,
        comments_json TEXT NOT NULL,
        discussions_json TEXT NOT NULL,
        instructions_json TEXT NOT NULL,
        project_memory_json TEXT,
        workspace_strategy TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE interaction_runs (
        id TEXT PRIMARY KEY,
        interaction_job_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        model_profile_name TEXT,
        provider_base_url TEXT,
        provider_type TEXT,
        text_generation_model TEXT,
        status TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      INSERT INTO tenants VALUES (
        'tenant_1', 'key-1', 'gitlab', 'connection-1', '{}', NULL,
        '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'
      );
      INSERT INTO interaction_jobs VALUES (
        'job_queued', 'tenant_1', 'dedupe_queued', 7, 55, '{}', 'abc',
        'queued', '{}', 0, NULL, '2026-04-01T00:00:00.000Z', NULL, NULL
      );
      INSERT INTO interaction_jobs VALUES (
        'job_running', 'tenant_1', 'dedupe_running', 7, 56, '{}', 'def',
        'in_progress', '{}', 1, NULL, '2026-04-02T00:00:00.000Z',
        '2026-04-02T00:01:00.000Z', NULL
      );
    `);
    legacy.close();

    const provider = new SqliteStorageProvider({ databasePath });
    await provider.open();
    const preparation = await provider.prepare();
    expect(preparation.appliedMigrationIds).toContain(
      "sqlite:0011_v5_job_claims_and_reasoning_effort",
    );

    const verify = new DatabaseSync(databasePath);
    const jobs = verify
      .prepare(
        "SELECT id, status, enqueued_at, available_at, claim_token, latest_interaction_run_id FROM interaction_jobs ORDER BY id",
      )
      .all() as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job.available_at).toBe(job.enqueued_at);
      expect(job.claim_token).toBeNull();
      expect(job.latest_interaction_run_id).toBeNull();
    }
    const running = jobs.find((job) => job.id === "job_running");
    expect(running?.status).toBe("in_progress");

    const indexes = new Set(
      (
        verify
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'interaction_jobs'",
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
    );
    expect(indexes.has("idx_interaction_jobs_eligible")).toBe(true);
    expect(indexes.has("idx_interaction_jobs_active_lease")).toBe(true);

    const profileColumns = new Set(
      (
        verify.prepare("PRAGMA table_info(model_profiles)").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    expect(profileColumns.has("review_reasoning_effort")).toBe(true);
    expect(profileColumns.has("text_generation_reasoning_effort")).toBe(true);

    const runColumns = new Set(
      (
        verify.prepare("PRAGMA table_info(interaction_runs)").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    expect(runColumns.has("interaction_job_claim_token")).toBe(true);

    const snapshotColumns = new Set(
      (
        verify
          .prepare("PRAGMA table_info(code_review_snapshots)")
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
    );
    expect(snapshotColumns.has("interaction_run_id")).toBe(true);
    verify.close();

    await provider.close();
  });
});

describe("sqlite reasoning-effort mapper roundtrip", () => {
  it("persists nullable reasoning effort on model profiles", async () => {
    const { storage } = await setupStorage();
    try {
      await storage.upsertModelProfile({
        name: "profile-effort",
        reviewReasoningEffort: "high",
        textGenerationReasoningEffort: "low",
      });
      const stored = await storage.stores.modelProfiles.get("profile-effort");
      expect(stored?.reviewReasoningEffort).toBe("high");
      expect(stored?.textGenerationReasoningEffort).toBe("low");

      await storage.upsertModelProfile({
        name: "profile-null",
      });
      const nullProfile =
        await storage.stores.modelProfiles.get("profile-null");
      expect(nullProfile?.reviewReasoningEffort).toBeNull();
      expect(nullProfile?.textGenerationReasoningEffort).toBeNull();
    } finally {
      await storage.close();
    }
  });
});

describe("sqlite claim-aware interaction job store", () => {
  it("reports atomic claim mode", async () => {
    const { storage } = await setupStorage();
    try {
      expect(storage.stores.interactionJobs.claimMode).toBe("atomic");
    } finally {
      await storage.close();
    }
  });

  it("claims the oldest eligible job and blocks a second concurrent claim", async () => {
    const { storage, tenantId } = await setupStorage();
    try {
      await storage.stores.interactionJobs.upsert(
        makeJob(tenantId, {
          id: "job-b",
          dedupeKey: "b",
          enqueuedAt: "2026-06-01T00:00:02.000Z",
          availableAt: "2026-06-01T00:00:02.000Z",
        }),
      );
      await storage.stores.interactionJobs.upsert(
        makeJob(tenantId, {
          id: "job-a",
          dedupeKey: "a",
          enqueuedAt: "2026-06-01T00:00:01.000Z",
          availableAt: "2026-06-01T00:00:01.000Z",
        }),
      );

      const claimed = await storage.stores.interactionJobs.claimNext({
        workerId: "worker-1",
        claimToken: "token-1",
        now: "2026-06-01T01:00:00.000Z",
        claimExpiresAt: "2026-06-01T01:02:00.000Z",
        queuedAfter: QUEUED_AFTER,
        maxJobRetries: 3,
      });
      expect(claimed?.id).toBe("job-a");
      expect(claimed?.status).toBe("in_progress");
      expect(claimed?.claimToken).toBe("token-1");
      expect(claimed?.claimedBy).toBe("worker-1");
      expect(claimed?.claimExpiresAt).toBe("2026-06-01T01:02:00.000Z");

      const blocked = await storage.stores.interactionJobs.claimNext({
        workerId: "worker-2",
        claimToken: "token-2",
        now: "2026-06-01T01:00:05.000Z",
        claimExpiresAt: "2026-06-01T01:02:05.000Z",
        queuedAfter: QUEUED_AFTER,
        maxJobRetries: 3,
      });
      expect(blocked).toBeNull();
    } finally {
      await storage.close();
    }
  });

  it("excludes jobs enqueued before queuedAfter", async () => {
    const { storage, tenantId } = await setupStorage();
    try {
      await storage.stores.interactionJobs.upsert(
        makeJob(tenantId, {
          id: "job-old",
          dedupeKey: "old",
          enqueuedAt: "2026-05-01T00:00:00.000Z",
          availableAt: "2026-05-01T00:00:00.000Z",
        }),
      );

      const claimed = await storage.stores.interactionJobs.claimNext({
        workerId: "worker-1",
        claimToken: "token-1",
        now: "2026-06-01T01:00:00.000Z",
        claimExpiresAt: "2026-06-01T01:02:00.000Z",
        queuedAfter: "2026-05-15T00:00:00.000Z",
        maxJobRetries: 3,
      });
      expect(claimed).toBeNull();
    } finally {
      await storage.close();
    }
  });

  it("recovers an expired lease and reclaims the job", async () => {
    const { storage, tenantId } = await setupStorage();
    try {
      await storage.stores.interactionJobs.upsert(
        makeJob(tenantId, { id: "job-x", dedupeKey: "x" }),
      );
      const first = await storage.stores.interactionJobs.claimNext({
        workerId: "worker-1",
        claimToken: "token-1",
        now: "2026-06-01T01:00:00.000Z",
        claimExpiresAt: "2026-06-01T01:00:30.000Z",
        queuedAfter: QUEUED_AFTER,
        maxJobRetries: 3,
      });
      expect(first?.id).toBe("job-x");

      // The lease has expired; a later claim recovers and reclaims it.
      const recovered = await storage.stores.interactionJobs.claimNext({
        workerId: "worker-2",
        claimToken: "token-2",
        now: "2026-06-01T01:05:00.000Z",
        claimExpiresAt: "2026-06-01T01:07:00.000Z",
        queuedAfter: QUEUED_AFTER,
        maxJobRetries: 3,
      });
      expect(recovered?.id).toBe("job-x");
      expect(recovered?.claimToken).toBe("token-2");
      expect(recovered?.retryCount).toBe(1);

      // The first token can no longer transition the job.
      const fenced = await storage.stores.interactionJobs.transitionClaim({
        jobId: "job-x",
        claimToken: "token-1",
        status: "completed",
        retryCount: 1,
        lastError: null,
        availableAt: recovered!.availableAt,
        finishedAt: "2026-06-01T01:06:00.000Z",
      });
      expect(fenced).toBe(false);
    } finally {
      await storage.close();
    }
  });

  it("fails a job whose retries are exhausted during lease recovery", async () => {
    const { storage, tenantId } = await setupStorage();
    try {
      await storage.stores.interactionJobs.upsert(
        makeJob(tenantId, { id: "job-y", dedupeKey: "y", retryCount: 3 }),
      );
      await storage.stores.interactionJobs.claimNext({
        workerId: "worker-1",
        claimToken: "token-1",
        now: "2026-06-01T01:00:00.000Z",
        claimExpiresAt: "2026-06-01T01:00:30.000Z",
        queuedAfter: QUEUED_AFTER,
        maxJobRetries: 3,
      });

      const result = await storage.stores.interactionJobs.claimNext({
        workerId: "worker-2",
        claimToken: "token-2",
        now: "2026-06-01T01:05:00.000Z",
        claimExpiresAt: "2026-06-01T01:07:00.000Z",
        queuedAfter: QUEUED_AFTER,
        maxJobRetries: 3,
      });
      expect(result).toBeNull();
      const job = await storage.stores.interactionJobs.get("job-y");
      expect(job?.status).toBe("failed");
      expect(job?.retryCount).toBe(4);
      expect(job?.claimToken).toBeNull();
    } finally {
      await storage.close();
    }
  });

  it("renews and transitions only with the owning claim token", async () => {
    const { storage, tenantId } = await setupStorage();
    try {
      await storage.stores.interactionJobs.upsert(
        makeJob(tenantId, { id: "job-r", dedupeKey: "r" }),
      );
      await storage.stores.interactionJobs.claimNext({
        workerId: "worker-1",
        claimToken: "token-1",
        now: "2099-06-01T01:00:00.000Z",
        claimExpiresAt: "2099-06-01T01:02:00.000Z",
        queuedAfter: QUEUED_AFTER,
        maxJobRetries: 3,
      });

      expect(
        await storage.stores.interactionJobs.renewClaim({
          jobId: "job-r",
          claimToken: "wrong",
          now: "2099-06-01T01:01:00.000Z",
          claimExpiresAt: "2099-06-01T01:03:00.000Z",
        }),
      ).toBe(false);
      expect(
        await storage.stores.interactionJobs.renewClaim({
          jobId: "job-r",
          claimToken: "token-1",
          now: "2099-06-01T01:01:00.000Z",
          claimExpiresAt: "2099-06-01T01:03:00.000Z",
        }),
      ).toBe(true);

      const transitioned = await storage.stores.interactionJobs.transitionClaim(
        {
          jobId: "job-r",
          claimToken: "token-1",
          status: "completed",
          retryCount: 0,
          lastError: null,
          availableAt: "2099-06-01T00:00:00.000Z",
          finishedAt: "2099-06-01T01:04:00.000Z",
        },
      );
      expect(transitioned).toBe(true);
      const job = await storage.stores.interactionJobs.get("job-r");
      expect(job?.status).toBe("completed");
      expect(job?.claimToken).toBeNull();
      expect(job?.claimExpiresAt).toBeNull();
    } finally {
      await storage.close();
    }
  });

  it("does not renew a claim at or after its persisted lease deadline", async () => {
    const { storage, tenantId } = await setupStorage(() =>
      new Date().toISOString(),
    );
    const capturedNow = new Date(Date.now() - 2_000).toISOString();
    const persistedDeadline = new Date(Date.now() - 1_000).toISOString();
    const renewedDeadline = new Date(Date.now() + 60_000).toISOString();
    try {
      await storage.stores.interactionJobs.upsert(
        makeJob(tenantId, { id: "job-expired-renewal", dedupeKey: "expired" }),
      );
      await storage.stores.interactionJobs.claimNext({
        workerId: "worker-1",
        claimToken: "token-1",
        now: capturedNow,
        claimExpiresAt: persistedDeadline,
        queuedAfter: QUEUED_AFTER,
        maxJobRetries: 3,
      });

      expect(
        await storage.stores.interactionJobs.renewClaim({
          jobId: "job-expired-renewal",
          claimToken: "token-1",
          now: capturedNow,
          claimExpiresAt: renewedDeadline,
        }),
      ).toBe(false);
      expect(
        await storage.stores.interactionJobs.get("job-expired-renewal"),
      ).toMatchObject({
        claimExpiresAt: persistedDeadline,
      });
    } finally {
      await storage.close();
    }
  });

  it("rejects claim-scoped writes after the persisted lease deadline", async () => {
    let currentTime = "2026-06-01T01:01:00.000Z";
    const { storage, tenantId } = await setupStorage(() => currentTime);
    try {
      await storage.stores.interactionJobs.upsert(
        makeJob(tenantId, {
          id: "job-expired-write",
          dedupeKey: "expired-write",
        }),
      );
      await storage.stores.interactionJobs.claimNext({
        workerId: "worker-1",
        claimToken: "token-1",
        now: "2026-06-01T01:00:00.000Z",
        claimExpiresAt: "2026-06-01T01:02:00.000Z",
        queuedAfter: QUEUED_AFTER,
        maxJobRetries: 3,
      });
      const runInput = {
        interactionJobId: "job-expired-write",
        tenantId,
        provider: "copilot-sdk",
        model: "gpt-5.6",
        modelProfileName: null,
        providerBaseUrl: null,
        providerType: null,
        textGenerationModel: null,
      };
      const run =
        await storage.stores.interactionJobs.createInteractionRunForClaim({
          jobId: "job-expired-write",
          claimToken: "token-1",
          run: runInput,
        });
      expect(run).not.toBeNull();

      currentTime = "2026-06-01T01:02:00.000Z";
      await expect(
        storage.stores.interactionJobs.createInteractionRunForClaim({
          jobId: "job-expired-write",
          claimToken: "token-1",
          run: runInput,
        }),
      ).resolves.toBeNull();
      await expect(
        storage.stores.interactionJobs.transitionInteractionRunForClaim({
          jobId: "job-expired-write",
          claimToken: "token-1",
          interactionRunId: run!.id,
          status: "completed",
          resultJson: "{}",
          error: null,
          finishedAt: currentTime,
        }),
      ).resolves.toBe(false);
      await expect(
        storage.stores.interactionJobs.transitionClaim({
          jobId: "job-expired-write",
          claimToken: "token-1",
          status: "completed",
          retryCount: 0,
          lastError: null,
          availableAt: currentTime,
          finishedAt: currentTime,
        }),
      ).resolves.toBe(false);
    } finally {
      await storage.close();
    }
  });

  it("creates runs and reconciles orphaned runs after lease loss", async () => {
    const { storage, tenantId } = await setupStorage();
    try {
      await storage.stores.interactionJobs.upsert(
        makeJob(tenantId, { id: "job-run", dedupeKey: "run" }),
      );
      await storage.stores.interactionJobs.claimNext({
        workerId: "worker-1",
        claimToken: "token-1",
        now: "2026-06-01T01:00:00.000Z",
        claimExpiresAt: "2026-06-01T01:02:00.000Z",
        queuedAfter: QUEUED_AFTER,
        maxJobRetries: 3,
      });

      const run =
        await storage.stores.interactionJobs.createInteractionRunForClaim({
          jobId: "job-run",
          claimToken: "token-1",
          run: {
            interactionJobId: "job-run",
            tenantId,
            provider: "copilot-sdk",
            model: "gpt-5.6",
            modelProfileName: null,
            providerBaseUrl: null,
            providerType: null,
            textGenerationModel: null,
            reviewReasoningEffort: "high",
            textGenerationReasoningEffort: null,
          },
        });
      expect(run).not.toBeNull();
      expect(run?.interactionJobClaimToken).toBe("token-1");
      expect(run?.reviewReasoningEffort).toBe("high");

      const job = await storage.stores.interactionJobs.get("job-run");
      expect(job?.latestInteractionRunId).toBe(run?.id);

      // A stale token cannot create another run.
      const fencedRun =
        await storage.stores.interactionJobs.createInteractionRunForClaim({
          jobId: "job-run",
          claimToken: "stale",
          run: {
            interactionJobId: "job-run",
            tenantId,
            provider: "copilot-sdk",
            model: "gpt-5.6",
            modelProfileName: null,
            providerBaseUrl: null,
            providerType: null,
            textGenerationModel: null,
          },
        });
      expect(fencedRun).toBeNull();
      expect(
        await storage.stores.interactionJobs.createInteractionRunForClaim({
          jobId: "job-run",
          claimToken: "token-1",
          run: {
            interactionJobId: "different-job",
            tenantId,
            provider: "copilot-sdk",
            model: "gpt-5.6",
            modelProfileName: null,
            providerBaseUrl: null,
            providerType: null,
            textGenerationModel: null,
          },
        }),
      ).toBeNull();

      // Requeue the job (clearing its claim), orphaning the in-progress run.
      await storage.stores.interactionJobs.transitionClaim({
        jobId: "job-run",
        claimToken: "token-1",
        status: "queued",
        retryCount: 1,
        lastError: "retry",
        availableAt: "2026-06-01T02:00:00.000Z",
        finishedAt: null,
      });

      const reconciled =
        await storage.stores.interactionJobs.reconcileOrphanedInteractionRuns({
          now: "2026-06-01T02:05:00.000Z",
          limit: 10,
        });
      expect(reconciled.map((entry) => entry.id)).toContain(run?.id);
      const storedRun = await storage.stores.interactionRuns.get(run!.id);
      expect(storedRun?.status).toBe("failed");
    } finally {
      await storage.close();
    }
  });

  it("expires stale queued jobs by original enqueue time", async () => {
    const { storage, tenantId } = await setupStorage();
    try {
      await storage.stores.interactionJobs.upsert(
        makeJob(tenantId, {
          id: "job-stale",
          dedupeKey: "stale",
          enqueuedAt: "2026-05-01T00:00:00.000Z",
          availableAt: "2026-05-01T00:00:00.000Z",
        }),
      );
      const expired = await storage.stores.interactionJobs.expireQueued({
        now: "2026-06-01T00:00:00.000Z",
        queuedBefore: "2026-05-15T00:00:00.000Z",
        reason: "too old",
        limit: 10,
      });
      expect(expired).toBe(1);
      const job = await storage.stores.interactionJobs.get("job-stale");
      expect(job?.status).toBe("expired");
      expect(job?.finishedAt).toBe("2026-06-01T00:00:00.000Z");
      expect(job?.lastError).toBe("too old");
    } finally {
      await storage.close();
    }
  });

  it("rejects ordinary mutation of an in-progress job", async () => {
    const { storage, tenantId } = await setupStorage();
    try {
      await storage.stores.interactionJobs.upsert(
        makeJob(tenantId, { id: "job-guard", dedupeKey: "guard" }),
      );
      const claimed = await storage.stores.interactionJobs.claimNext({
        workerId: "worker-1",
        claimToken: "token-1",
        now: "2026-06-01T01:00:00.000Z",
        claimExpiresAt: "2026-06-01T01:02:00.000Z",
        queuedAfter: QUEUED_AFTER,
        maxJobRetries: 3,
      });
      expect(claimed?.id).toBe("job-guard");

      await expect(
        storage.stores.interactionJobs.patch({
          id: "job-guard",
          value: { status: "completed" },
        }),
      ).rejects.toThrow(/in-progress/);
      await expect(
        storage.stores.interactionJobs.delete("job-guard"),
      ).rejects.toThrow(/in-progress/);
      await expect(
        storage.stores.interactionJobs.upsert(claimed!),
      ).rejects.toThrow(/in-progress/);
    } finally {
      await storage.close();
    }
  });

  it("pairs a completed retry run with its own snapshot", async () => {
    const { storage, tenantId } = await setupStorage();
    try {
      await storage.stores.interactionJobs.upsert(
        makeJob(tenantId, { id: "job-history", dedupeKey: "history" }),
      );
      const firstRun = await storage.createInteractionRun({
        interactionJobId: "job-history",
        tenantId,
        provider: "copilot-sdk",
        model: "gpt-5.6",
        modelProfileName: null,
        providerBaseUrl: null,
        providerType: null,
        textGenerationModel: null,
      });
      const latestRun = await storage.createInteractionRun({
        interactionJobId: "job-history",
        tenantId,
        provider: "copilot-sdk",
        model: "gpt-5.6",
        modelProfileName: null,
        providerBaseUrl: null,
        providerType: null,
        textGenerationModel: null,
      });
      await storage.stores.interactionRuns.patchMany([
        {
          id: firstRun.id,
          value: {
            status: "completed",
            resultJson: '{"attempt":1}',
            finishedAt: "2026-06-01T01:00:00.000Z",
          },
        },
        {
          id: latestRun.id,
          value: {
            status: "completed",
            resultJson: '{"attempt":2}',
            finishedAt: "2026-06-01T02:00:00.000Z",
          },
        },
      ]);
      const snapshotInput = {
        interactionJobId: "job-history",
        tenantId,
        codeReviewId: 7,
        headSha: "abc123",
        codeReviewJson: "{}",
        versionsJson: "[]",
        changesJson: "[]",
        commentsJson: "[]",
        discussionsJson: "[]",
        instructionsJson: "[]",
        projectMemoryJson: null,
        workspaceStrategy: "archive",
      };
      const latestSnapshot = await storage.createCodeReviewSnapshot({
        ...snapshotInput,
        interactionRunId: latestRun.id,
      });
      const abandonedSnapshot = await storage.createCodeReviewSnapshot({
        ...snapshotInput,
        interactionRunId: firstRun.id,
      });
      await storage.stores.codeReviewSnapshots.patchMany([
        {
          id: latestSnapshot.id,
          value: { createdAt: "2026-06-01T01:30:00.000Z" },
        },
        {
          id: abandonedSnapshot.id,
          value: { createdAt: "2026-06-01T03:00:00.000Z" },
        },
      ]);

      const previous = await storage.getLatestCompletedInteractionForCodeReview(
        tenantId,
        7,
        "current-job",
      );
      expect(previous?.interactionRunId).toBe(latestRun.id);
      expect(previous?.snapshot.id).toBe(latestSnapshot.id);
    } finally {
      await storage.close();
    }
  });

  it("updateReviewFindingStatusForClaim reports true on no-match and false only on ownership failure", async () => {
    const { storage, tenantId } = await setupStorage();
    try {
      await storage.stores.interactionJobs.upsert(
        makeJob(tenantId, { id: "job-fs", dedupeKey: "fs" }),
      );
      await storage.stores.interactionJobs.claimNext({
        workerId: "worker-1",
        claimToken: "token-1",
        now: "2026-06-01T01:00:00.000Z",
        claimExpiresAt: "2026-06-01T01:02:00.000Z",
        queuedAfter: QUEUED_AFTER,
        maxJobRetries: 3,
      });
      const run =
        await storage.stores.interactionJobs.createInteractionRunForClaim({
          jobId: "job-fs",
          claimToken: "token-1",
          run: {
            interactionJobId: "job-fs",
            tenantId,
            provider: "copilot-sdk",
            model: "gpt-5.6",
            modelProfileName: null,
            providerBaseUrl: null,
            providerType: null,
            textGenerationModel: null,
          },
        });
      expect(run).not.toBeNull();

      // Owned by the claim but no historical completed finding matches: a no-op
      // is not lease loss, so the call reports true.
      const owned =
        await storage.stores.interactionJobs.updateReviewFindingStatusForClaim({
          jobId: "job-fs",
          claimToken: "token-1",
          interactionRunId: run!.id,
          tenantId,
          codeReviewId: 7,
          identityKey: "no-such-finding",
          status: "resolved",
        });
      expect(owned).toBe(true);

      // A stale claim token fails the ownership predicate and reports false.
      const fenced =
        await storage.stores.interactionJobs.updateReviewFindingStatusForClaim({
          jobId: "job-fs",
          claimToken: "stale",
          interactionRunId: run!.id,
          tenantId,
          codeReviewId: 7,
          identityKey: "no-such-finding",
          status: "resolved",
        });
      expect(fenced).toBe(false);
    } finally {
      await storage.close();
    }
  });

  it("reconciles a completed run whose job never completed under that attempt", async () => {
    const { storage, tenantId } = await setupStorage();
    try {
      await storage.stores.interactionJobs.upsert(
        makeJob(tenantId, { id: "job-false", dedupeKey: "false" }),
      );
      await storage.stores.interactionJobs.claimNext({
        workerId: "worker-1",
        claimToken: "token-1",
        now: "2026-06-01T01:00:00.000Z",
        claimExpiresAt: "2026-06-01T01:02:00.000Z",
        queuedAfter: QUEUED_AFTER,
        maxJobRetries: 3,
      });
      const run =
        await storage.stores.interactionJobs.createInteractionRunForClaim({
          jobId: "job-false",
          claimToken: "token-1",
          run: {
            interactionJobId: "job-false",
            tenantId,
            provider: "copilot-sdk",
            model: "gpt-5.6",
            modelProfileName: null,
            providerBaseUrl: null,
            providerType: null,
            textGenerationModel: null,
          },
        });
      expect(run).not.toBeNull();

      // The run is marked completed under its own claim...
      const runCompleted =
        await storage.stores.interactionJobs.transitionInteractionRunForClaim({
          jobId: "job-false",
          claimToken: "token-1",
          interactionRunId: run!.id,
          status: "completed",
          resultJson: '{"ok":true}',
          error: null,
          finishedAt: "2026-06-01T01:01:00.000Z",
        });
      expect(runCompleted).toBe(true);

      // ...but the job completion lost the lease and the job was requeued under
      // the same token (simulating a lost-lease requeue). latestInteractionRunId
      // still points at the completed run.
      const requeued = await storage.stores.interactionJobs.transitionClaim({
        jobId: "job-false",
        claimToken: "token-1",
        status: "queued",
        retryCount: 1,
        lastError: "lease lost",
        availableAt: "2026-06-01T02:00:00.000Z",
        finishedAt: null,
      });
      expect(requeued).toBe(true);

      const reconciled =
        await storage.stores.interactionJobs.reconcileOrphanedInteractionRuns({
          now: "2026-06-01T02:05:00.000Z",
          limit: 10,
        });
      expect(reconciled.map((entry) => entry.id)).toContain(run!.id);
      const storedRun = await storage.stores.interactionRuns.get(run!.id);
      expect(storedRun?.status).toBe("failed");

      // Idempotent: a second pass does not reconcile it again.
      const second =
        await storage.stores.interactionJobs.reconcileOrphanedInteractionRuns({
          now: "2026-06-01T02:06:00.000Z",
          limit: 10,
        });
      expect(second.map((entry) => entry.id)).not.toContain(run!.id);
    } finally {
      await storage.close();
    }
  });

  it("preserves a legitimately completed run for a completed job", async () => {
    const { storage, tenantId } = await setupStorage();
    try {
      await storage.stores.interactionJobs.upsert(
        makeJob(tenantId, { id: "job-done", dedupeKey: "done" }),
      );
      await storage.stores.interactionJobs.claimNext({
        workerId: "worker-1",
        claimToken: "token-1",
        now: "2026-06-01T01:00:00.000Z",
        claimExpiresAt: "2026-06-01T01:02:00.000Z",
        queuedAfter: QUEUED_AFTER,
        maxJobRetries: 3,
      });
      const run =
        await storage.stores.interactionJobs.createInteractionRunForClaim({
          jobId: "job-done",
          claimToken: "token-1",
          run: {
            interactionJobId: "job-done",
            tenantId,
            provider: "copilot-sdk",
            model: "gpt-5.6",
            modelProfileName: null,
            providerBaseUrl: null,
            providerType: null,
            textGenerationModel: null,
          },
        });
      await storage.stores.interactionJobs.transitionInteractionRunForClaim({
        jobId: "job-done",
        claimToken: "token-1",
        interactionRunId: run!.id,
        status: "completed",
        resultJson: "{}",
        error: null,
        finishedAt: "2026-06-01T01:01:00.000Z",
      });
      await storage.stores.interactionJobs.transitionClaim({
        jobId: "job-done",
        claimToken: "token-1",
        status: "completed",
        retryCount: 0,
        lastError: null,
        availableAt: "2026-06-01T00:00:00.000Z",
        finishedAt: "2026-06-01T01:01:30.000Z",
      });

      const reconciled =
        await storage.stores.interactionJobs.reconcileOrphanedInteractionRuns({
          now: "2026-06-01T02:00:00.000Z",
          limit: 10,
        });
      expect(reconciled.map((entry) => entry.id)).not.toContain(run!.id);
      const storedRun = await storage.stores.interactionRuns.get(run!.id);
      expect(storedRun?.status).toBe("completed");
    } finally {
      await storage.close();
    }
  });
});

describe("flotiq adapter revision", () => {
  it("reports storage-v006 without touching the network", async () => {
    // Import lazily so the SDK mock in other suites does not interfere.
    const { createStorageProvider } =
      await import("../src/storage/adapters/flotiq/entrypoint.js");
    const provider = createStorageProvider({
      env: { FLOTIQ_API_KEY: "test-key" },
    });
    expect(provider.getSupportedStorageContract()).toBe("storage-v006");
  });
});
