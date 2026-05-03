import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { SqliteStorage } from "../src/storage/sqlite-storage.js";
import type { CreateReviewFindingInput } from "../src/storage/types.js";

describe("SqliteStorage review findings", () => {
  it("backfills legacy review findings status as resolved during initialization", async () => {
    const databasePath = join(await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-storage-")), "storage.sqlite");
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb.exec(`
      CREATE TABLE tenants (
        id TEXT PRIMARY KEY,
        tenant_key TEXT NOT NULL UNIQUE,
        base_url TEXT NOT NULL,
        project_id INTEGER NOT NULL,
        api_token TEXT NOT NULL,
        webhook_secret TEXT NOT NULL,
        bot_user_id INTEGER,
        bot_username TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE review_jobs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        project_id INTEGER NOT NULL,
        merge_request_iid INTEGER NOT NULL,
        note_id INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        enqueued_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE TABLE review_runs (
        id TEXT PRIMARY KEY,
        review_job_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        status TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE TABLE review_findings (
        id TEXT PRIMARY KEY,
        review_run_id TEXT NOT NULL,
        identity_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        severity TEXT NOT NULL,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        file_path TEXT,
        start_line INTEGER,
        end_line INTEGER,
        side TEXT,
        suggestion_json TEXT,
        raw_json TEXT NOT NULL,
        created_at TEXT NOT NULL
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
        '2026-04-01T00:00:00.000Z',
        '2026-04-01T00:00:00.000Z'
      );
      INSERT INTO review_jobs VALUES (
        'job_1',
        'tenant_1',
        'dedupe_1',
        123,
        7,
        55,
        'headsha',
        'completed',
        '{}',
        0,
        NULL,
        '2026-04-01T00:00:00.000Z',
        '2026-04-01T00:00:00.000Z',
        '2026-04-01T00:05:00.000Z'
      );
      INSERT INTO review_runs VALUES (
        'run_1',
        'job_1',
        'tenant_1',
        'copilot-sdk',
        NULL,
        'completed',
        '{}',
        NULL,
        '2026-04-01T00:00:00.000Z',
        '2026-04-01T00:05:00.000Z'
      );
      INSERT INTO review_findings VALUES (
        'finding_1',
        'run_1',
        'identity_1',
        'fingerprint_1',
        'medium',
        'correctness',
        'Legacy finding',
        'Legacy body',
        'src\\legacy.ts',
        10,
        10,
        'new',
        NULL,
        '{}',
        '2026-04-01T00:05:00.000Z'
      );
    `);
    legacyDb.close();

    const storage = new SqliteStorage({ databasePath });
    await storage.initialize();

    const verifiedDb = new DatabaseSync(databasePath);
    const row = verifiedDb
      .prepare("SELECT status, anchor_json FROM review_findings WHERE id = ?")
      .get("finding_1") as { status: string; anchor_json: string | null };
    const statusColumn = verifiedDb
      .prepare("PRAGMA table_info(review_findings)")
      .all()
      .find((column) => (column as { name: string }).name === "status") as { dflt_value: string };
    const columnNames = new Set(
      (verifiedDb.prepare("PRAGMA table_info(review_findings)").all() as Array<{ name: string }>).map((column) => column.name)
    );
    verifiedDb.close();

    expect(row.status).toBe("resolved");
    expect(JSON.parse(row.anchor_json ?? "null")).toEqual({
      path: "src\\legacy.ts",
      startLine: 10,
      endLine: 10,
      side: "new"
    });
    expect(statusColumn.dflt_value).toBe("'open'");
    expect(columnNames.has("anchor_json")).toBe(true);
    expect(columnNames.has("fingerprint")).toBe(false);
    expect(columnNames.has("raw_json")).toBe(false);
    expect(columnNames.has("file_path")).toBe(false);
  });

  it("renames legacy review run foreign-key columns during interaction schema upgrade", async () => {
    const databasePath = join(await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-storage-")), "storage.sqlite");
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb.exec(`
      CREATE TABLE tenants (
        id TEXT PRIMARY KEY,
        tenant_key TEXT NOT NULL UNIQUE,
        base_url TEXT NOT NULL,
        project_id INTEGER NOT NULL,
        api_token TEXT NOT NULL,
        webhook_secret TEXT NOT NULL,
        bot_user_id INTEGER,
        bot_username TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE review_jobs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        project_id INTEGER NOT NULL,
        merge_request_iid INTEGER NOT NULL,
        note_id INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        enqueued_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE TABLE review_runs (
        id TEXT PRIMARY KEY,
        review_job_id TEXT NOT NULL,
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
      CREATE TABLE review_run_metrics (
        id TEXT PRIMARY KEY,
        review_run_id TEXT NOT NULL UNIQUE,
        trigger_kind TEXT,
        prompt_mode TEXT,
        prompt_chars INTEGER NOT NULL,
        prompt_context_changed_files INTEGER NOT NULL,
        prompt_context_prior_threads INTEGER NOT NULL,
        prompt_context_notes INTEGER NOT NULL,
        assistant_turns INTEGER NOT NULL,
        assistant_calls INTEGER NOT NULL,
        tool_executions INTEGER NOT NULL,
        view_tool_calls INTEGER NOT NULL,
        glob_tool_calls INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        reasoning_tokens INTEGER NOT NULL,
        api_duration_ms INTEGER NOT NULL,
        premium_requests INTEGER NOT NULL,
        repeated_view_reads INTEGER NOT NULL,
        repeated_view_paths_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE merge_request_snapshots (
        id TEXT PRIMARY KEY,
        review_job_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        merge_request_iid INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        merge_request_json TEXT NOT NULL,
        versions_json TEXT NOT NULL,
        changes_json TEXT NOT NULL,
        notes_json TEXT NOT NULL,
        discussions_json TEXT NOT NULL,
        instructions_json TEXT NOT NULL,
        project_memory_json TEXT,
        workspace_strategy TEXT NOT NULL,
        created_at TEXT NOT NULL
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
        '2026-04-01T00:00:00.000Z',
        '2026-04-01T00:00:00.000Z'
      );
      INSERT INTO review_jobs VALUES (
        'job_1',
        'tenant_1',
        'dedupe_1',
        123,
        7,
        55,
        'headsha',
        'completed',
        '{}',
        0,
        NULL,
        '2026-04-01T00:00:00.000Z',
        '2026-04-01T00:00:00.000Z',
        '2026-04-01T00:05:00.000Z'
      );
      INSERT INTO review_runs VALUES (
        'run_1',
        'job_1',
        'tenant_1',
        'copilot-sdk',
        'gpt-5.4',
        NULL,
        NULL,
        NULL,
        NULL,
        'completed',
        '{"overview":{"summary":"ok","overallSeverity":"low"},"findings":[],"priorDispositions":[]}',
        NULL,
        '2026-04-01T00:00:00.000Z',
        '2026-04-01T00:05:00.000Z'
      );
      INSERT INTO review_run_metrics VALUES (
        'metrics_1',
        'run_1',
        'note',
        'full',
        10,
        1,
        0,
        1,
        1,
        1,
        0,
        0,
        0,
        10,
        20,
        0,
        0,
        0,
        100,
        1,
        0,
        '[]',
        '2026-04-01T00:05:00.000Z',
        '2026-04-01T00:05:00.000Z'
      );
      INSERT INTO merge_request_snapshots VALUES (
        'snapshot_1',
        'job_1',
        'tenant_1',
        7,
        'headsha',
        '{}',
        '[]',
        '[]',
        '[]',
        '[]',
        '[]',
        NULL,
        'git',
        '2026-04-01T00:05:00.000Z'
      );
    `);
    legacyDb.close();

    const storage = new SqliteStorage({ databasePath });
    await storage.initialize();

    const createdRun = await storage.createInteractionRun({
      interactionJobId: "job_1",
      tenantId: "tenant_1",
      provider: "copilot-sdk",
      model: "gpt-5.4",
      modelProfileName: null,
      providerBaseUrl: null,
      providerType: null,
      textGenerationModel: null
    });
    await storage.upsertInteractionRunMetrics({
      interactionRunId: createdRun.id,
      triggerKind: "note",
      promptMode: "full",
      promptChars: 12,
      promptContextChangedFiles: 1,
      promptContextPriorThreads: 0,
      promptContextNotes: 1,
      assistantTurns: 1,
      assistantCalls: 1,
      toolExecutions: 0,
      viewToolCalls: 0,
      globToolCalls: 0,
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      apiDurationMs: 123,
      premiumRequests: 1,
      repeatedViewReads: 0,
      repeatedViewPathsJson: "[]"
    });

    const previousInteraction = await storage.getLatestCompletedInteractionForMergeRequest("tenant_1", 7, "job_2");
    const verifiedDb = new DatabaseSync(databasePath);
    const interactionRunColumns = new Set(
      (verifiedDb.prepare("PRAGMA table_info(interaction_runs)").all() as Array<{ name: string }>).map((column) => column.name)
    );
    const interactionRunMetricColumns = new Set(
      (verifiedDb.prepare("PRAGMA table_info(interaction_run_metrics)").all() as Array<{ name: string }>).map((column) => column.name)
    );
    verifiedDb.close();

    expect(previousInteraction).toMatchObject({
      interactionRunId: "run_1",
      interactionJobId: "job_1",
      headSha: "headsha"
    });
    expect(interactionRunColumns.has("interaction_job_id")).toBe(true);
    expect(interactionRunColumns.has("review_job_id")).toBe(false);
    expect(interactionRunMetricColumns.has("interaction_run_id")).toBe(true);
    expect(interactionRunMetricColumns.has("review_run_id")).toBe(false);
  });

  it("returns latest prior finding state per identity and updates status in place", async () => {
    const databasePath = join(await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-storage-")), "storage.sqlite");
    const storage = new SqliteStorage({ databasePath });
    await storage.initialize();

    const tenant = await storage.upsertTenant({
      baseUrl: "https://gitlab.example.com",
      projectId: 123,
      apiToken: "token",
      webhookSecret: "secret",
      botUserId: 999,
      botUsername: "review-bot"
    });

    await createCompletedRun(storage, tenant.id, tenant.projectId, 7, 55, "head-one", [
      createFinding({
        identityKey: "identity_existing",
        title: "Validate request body",
        body: "First version",
        status: "open"
      }),
      createFinding({
        identityKey: "identity_other",
        title: "Check permissions",
        body: "Still open",
        status: "open"
      })
    ]);

    await createCompletedRun(storage, tenant.id, tenant.projectId, 7, 56, "head-two", [
      createFinding({
        identityKey: "identity_existing",
        title: "Validate request body",
        body: "Latest version",
        status: "open",
        suggestionJson: JSON.stringify({
          replacement: "validate(body);",
          startLine: 12,
          endLine: 12
        })
      })
    ]);

    const currentJob = await storage.createOrGetInteractionJob({
      tenantId: tenant.id,
      dedupeKey: "current-job",
      projectId: tenant.projectId,
      mergeRequestIid: 7,
      noteId: 57,
      headSha: "head-current",
      payloadJson: "{}"
    });

    expect(await storage.updateReviewFindingStatus(tenant.id, 7, "identity_existing", "dismissed")).toBe(true);

    const priorFindings = await storage.listPriorReviewFindings(tenant.id, 7, currentJob.job.id);
    const persistedStatuses = readFindingStatuses(databasePath, "identity_existing");

    expect(priorFindings).toHaveLength(2);
    expect(priorFindings[0]).toMatchObject({
      identityKey: "identity_other",
      status: "open"
    });
    expect(priorFindings[1]).toMatchObject({
      identityKey: "identity_existing",
      status: "dismissed",
      title: "Validate request body",
      body: "Latest version",
      interactionRunId: expect.any(String),
      headSha: "head-two"
    });
    expect(priorFindings[1]?.anchor).toEqual({
      path: "src\\api.ts",
      startLine: 12,
      endLine: 12,
      side: "new"
    });
    expect(priorFindings[1]?.suggestion).toEqual({
      replacement: "validate(body);",
      startLine: 12,
      endLine: 12
    });
    expect(persistedStatuses).toEqual(["dismissed", "dismissed"]);
  });

  it("updates status on the latest completed finding row even when a newer failed run exists", async () => {
    const databasePath = join(await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-storage-")), "storage.sqlite");
    const storage = new SqliteStorage({ databasePath });
    await storage.initialize();

    const tenant = await storage.upsertTenant({
      baseUrl: "https://gitlab.example.com",
      projectId: 123,
      apiToken: "token",
      webhookSecret: "secret",
      botUserId: 999,
      botUsername: "review-bot"
    });

    await createCompletedRun(storage, tenant.id, tenant.projectId, 7, 70, "head-completed", [
      createFinding({
        identityKey: "identity_status",
        title: "Persist status on completed run",
        body: "Completed version",
        status: "open"
      })
    ]);

    await createFailedRun(storage, tenant.id, tenant.projectId, 7, 71, "head-failed", [
      createFinding({
        identityKey: "identity_status",
        title: "Persist status on completed run",
        body: "Failed version",
        status: "open"
      })
    ]);

    expect(await storage.updateReviewFindingStatus(tenant.id, 7, "identity_status", "dismissed")).toBe(true);

    const currentJob = await storage.createOrGetInteractionJob({
      tenantId: tenant.id,
      dedupeKey: "current-job-after-failed-run",
      projectId: tenant.projectId,
      mergeRequestIid: 7,
      noteId: 72,
      headSha: "head-current",
      payloadJson: "{}"
    });

    const priorFindings = await storage.listPriorReviewFindings(tenant.id, 7, currentJob.job.id);
    expect(priorFindings).toHaveLength(1);
    expect(priorFindings[0]).toMatchObject({
      identityKey: "identity_status",
      status: "dismissed",
      body: "Completed version",
      headSha: "head-completed"
    });
    expect(readFindingStatuses(databasePath, "identity_status")).toEqual(["dismissed"]);
  });

  it("deduplicates persisted review findings during initialization and keeps the closed copy", async () => {
    const databasePath = join(await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-storage-")), "storage.sqlite");
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(base_url, project_id)
      );
      CREATE TABLE review_jobs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        project_id INTEGER NOT NULL,
        merge_request_iid INTEGER NOT NULL,
        note_id INTEGER NOT NULL,
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
      CREATE TABLE review_runs (
        id TEXT PRIMARY KEY,
        review_job_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        status TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        FOREIGN KEY (review_job_id) REFERENCES review_jobs(id),
        FOREIGN KEY (tenant_id) REFERENCES tenants(id)
      );
      CREATE TABLE review_findings (
        id TEXT PRIMARY KEY,
        review_run_id TEXT NOT NULL,
        identity_key TEXT NOT NULL,
        severity TEXT NOT NULL,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        anchor_json TEXT,
        suggestion_json TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        FOREIGN KEY (review_run_id) REFERENCES review_runs(id)
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
        '2026-04-01T00:00:00.000Z',
        '2026-04-01T00:00:00.000Z'
      );
      INSERT INTO review_jobs VALUES (
        'job_1',
        'tenant_1',
        'dedupe_1',
        123,
        7,
        55,
        'headsha',
        'completed',
        '{}',
        0,
        NULL,
        '2026-04-01T00:00:00.000Z',
        '2026-04-01T00:00:00.000Z',
        '2026-04-01T00:05:00.000Z'
      );
      INSERT INTO review_runs VALUES (
        'run_1',
        'job_1',
        'tenant_1',
        'copilot-sdk',
        NULL,
        'completed',
        '{}',
        NULL,
        '2026-04-01T00:00:00.000Z',
        '2026-04-01T00:05:00.000Z'
      );
      INSERT INTO review_findings VALUES
      (
        'finding_1',
        'run_1',
        'identity_1',
        'medium',
        'correctness',
        'Duplicate finding',
        'Still open copy',
        NULL,
        NULL,
        'open',
        '2026-04-01T00:05:00.000Z'
      ),
      (
        'finding_2',
        'run_1',
        'identity_1',
        'medium',
        'correctness',
        'Duplicate finding',
        'Resolved copy',
        NULL,
        NULL,
        'resolved',
        '2026-04-01T00:05:00.000Z'
      );
    `);
    database.close();

    const storage = new SqliteStorage({ databasePath });
    await storage.initialize();

    const verifiedDb = new DatabaseSync(databasePath);
    const dedupedRows = verifiedDb
      .prepare("SELECT id, status, body FROM review_findings WHERE interaction_run_id = ? AND identity_key = ?")
      .all("run_1", "identity_1") as Array<{ id: string; status: string; body: string }>;
    const indexes = verifiedDb.prepare("PRAGMA index_list(review_findings)").all() as Array<{ name: string; unique: number }>;
    verifiedDb.close();

    expect(dedupedRows).toHaveLength(1);
    expect(dedupedRows[0]).toMatchObject({
      status: "resolved",
      body: "Resolved copy"
    });
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "review_findings_interaction_run_identity_key_idx",
          unique: 1
        })
      ])
    );
  });

  it("stores only one finding row per identity for a review run", async () => {
    const databasePath = join(await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-storage-")), "storage.sqlite");
    const storage = new SqliteStorage({ databasePath });
    await storage.initialize();

    const tenant = await storage.upsertTenant({
      baseUrl: "https://gitlab.example.com",
      projectId: 123,
      apiToken: "token",
      webhookSecret: "secret",
      botUserId: 999,
      botUsername: "review-bot"
    });

    const job = await storage.createOrGetInteractionJob({
      tenantId: tenant.id,
      dedupeKey: "dedupe-write-path",
      projectId: tenant.projectId,
      mergeRequestIid: 7,
      noteId: 80,
      headSha: "head-dedupe",
      payloadJson: "{}"
    });
    const run = await storage.createInteractionRun({
      interactionJobId: job.job.id,
      tenantId: tenant.id,
      provider: "copilot-sdk",
      model: null,
      modelProfileName: null,
      providerBaseUrl: null,
      providerType: null,
      textGenerationModel: null
    });

    await storage.replaceReviewFindings(run.id, [
      createFinding({
        identityKey: "identity_duplicate",
        title: "Validate request body",
        body: "First copy",
        status: "open"
      }),
      createFinding({
        identityKey: "identity_duplicate",
        title: "Validate request body",
        body: "Last copy wins",
        status: "open"
      })
    ]);

    const persistedRows = readFindingRows(databasePath, "identity_duplicate");

    expect(persistedRows).toEqual([
      expect.objectContaining({
        status: "open",
        body: "Last copy wins"
      })
    ]);
  });
});

describe("SqliteStorage tenants", () => {
  it("stores model profiles, tenant assignments, and resolved review run config", async () => {
    const databasePath = join(await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-storage-")), "storage.sqlite");
    const storage = new SqliteStorage({ databasePath });
    await storage.initialize();

    const defaultProfile = await storage.upsertModelProfile({
      name: "native-default",
      providerBaseUrl: null,
      providerType: null,
      wireApi: null,
      authToken: null,
      reviewModel: "gpt-5.4",
      textGenerationModel: "gpt-5.4-mini",
      isDefault: true
    });
    await storage.upsertModelProfile({
      name: "byok",
      providerBaseUrl: "https://llm.example.com/v1",
      providerType: "openai",
      wireApi: "responses",
      authToken: "secret-token",
      reviewModel: "custom-review",
      textGenerationModel: "custom-text",
      isDefault: false
    });

    const tenant = await storage.upsertTenant({
      baseUrl: "https://gitlab.example.com",
      projectId: 123,
      apiToken: "token",
      webhookSecret: "secret",
      botUserId: 999,
      botUsername: "review-bot",
      modelProfileName: "byok"
    });
    const job = await storage.createOrGetInteractionJob({
      tenantId: tenant.id,
      dedupeKey: "profiled-job",
      projectId: tenant.projectId,
      mergeRequestIid: 7,
      noteId: 55,
      headSha: "head-profiled",
      payloadJson: "{}"
    });
    const run = await storage.createInteractionRun({
      interactionJobId: job.job.id,
      tenantId: tenant.id,
      provider: "copilot-sdk",
      model: "custom-review",
      modelProfileName: "byok",
      providerBaseUrl: "https://llm.example.com/v1",
      providerType: "openai",
      textGenerationModel: "custom-text"
    });

    expect(defaultProfile.isDefault).toBe(true);
    expect((await storage.getDefaultModelProfile())?.name).toBe("native-default");
    expect(await storage.listModelProfiles()).toHaveLength(2);
    expect(tenant.modelProfileName).toBe("byok");
    expect((await storage.getModelProfileByName("byok"))?.wireApi).toBe("responses");
    expect(run).toMatchObject({
      model: "custom-review",
      modelProfileName: "byok",
      providerBaseUrl: "https://llm.example.com/v1",
      providerType: "openai",
      textGenerationModel: "custom-text"
    });
  });

  it("refuses to delete a model profile while a tenant still references it", async () => {
    const databasePath = join(await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-storage-")), "storage.sqlite");
    const storage = new SqliteStorage({ databasePath });
    await storage.initialize();

    await storage.upsertModelProfile({
      name: "shared-profile",
      providerBaseUrl: null,
      providerType: null,
      authToken: null,
      reviewModel: "gpt-5.4",
      textGenerationModel: null,
      isDefault: false
    });
    await storage.upsertTenant({
      baseUrl: "https://gitlab.example.com",
      projectId: 123,
      apiToken: "token",
      webhookSecret: "secret",
      botUserId: 999,
      botUsername: "review-bot",
      modelProfileName: "shared-profile"
    });

    await expect(storage.deleteModelProfile("shared-profile")).rejects.toThrow("still reference");
  });

  it("deletes a tenant by normalized base URL and project ID", async () => {
    const databasePath = join(await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-storage-")), "storage.sqlite");
    const storage = new SqliteStorage({ databasePath });
    await storage.initialize();

    await storage.upsertTenant({
      baseUrl: "https://gitlab.example.com/gitlab/",
      projectId: 123,
      apiToken: "token-one",
      webhookSecret: "secret-one",
      botUserId: 999,
      botUsername: "review-bot"
    });
    const secondTenant = await storage.upsertTenant({
      baseUrl: "https://gitlab.example.com",
      projectId: 456,
      apiToken: "token-two",
      webhookSecret: "secret-two",
      botUserId: 1000,
      botUsername: "review-bot-2"
    });

    const deletedTenant = await storage.deleteTenant("https://gitlab.example.com/gitlab", 123);
    const remainingTenants = await storage.listTenants();

    expect(deletedTenant).toMatchObject({
      baseUrl: "https://gitlab.example.com/gitlab/",
      projectId: 123
    });
    expect(remainingTenants).toHaveLength(1);
    expect(remainingTenants[0]).toMatchObject({
      id: secondTenant.id,
      baseUrl: "https://gitlab.example.com",
      projectId: 456
    });
  });

  it("deletes dependent review data before removing a tenant", async () => {
    const databasePath = join(await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-storage-")), "storage.sqlite");
    const storage = new SqliteStorage({ databasePath });
    await storage.initialize();

    const tenant = await storage.upsertTenant({
      baseUrl: "https://gitlab.example.com/gitlab",
      projectId: 123,
      apiToken: "token-one",
      webhookSecret: "secret-one",
      botUserId: 999,
      botUsername: "review-bot"
    });

    const reviewJob = await storage.createOrGetInteractionJob({
      tenantId: tenant.id,
      dedupeKey: "delete-tenant-job",
      projectId: tenant.projectId,
      mergeRequestIid: 7,
      noteId: 55,
      headSha: "head-sha",
      payloadJson: "{}"
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
      workspaceStrategy: "git"
    });
    const reviewRun = await storage.createInteractionRun({
      interactionJobId: reviewJob.job.id,
      tenantId: tenant.id,
      provider: "copilot-sdk",
      model: null,
      modelProfileName: null,
      providerBaseUrl: null,
      providerType: null,
      textGenerationModel: null
    });
    await storage.replaceReviewFindings(reviewRun.id, [
      {
        ...createFinding({
          identityKey: "delete-tenant-finding",
          title: "Delete tenant finding",
          body: "The finding should be removed",
          status: "open"
        }),
        interactionRunId: reviewRun.id
      }
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
      repeatedViewPathsJson: "[]"
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
      lastInteractionRunId: reviewRun.id
    });

    const deletionSummary = await storage.getTenantDeletionSummary(tenant.baseUrl, tenant.projectId);
    expect(deletionSummary).toMatchObject({
      interactionJobCount: 1,
      mergeRequestSnapshotCount: 1,
      interactionRunCount: 1,
      reviewFindingCount: 1,
      interactionRunMetricCount: 1,
      discussionMappingCount: 1,
      interactionJobIds: [reviewJob.job.id],
      interactionRunIds: [reviewRun.id]
    });

    const deletedSummary = await storage.deleteTenantWithSummary(tenant.baseUrl, tenant.projectId);

    expect(deletedSummary).toMatchObject({
      tenant: {
        id: tenant.id
      },
      interactionJobIds: [reviewJob.job.id],
      interactionRunIds: [reviewRun.id]
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
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number };
  database.close();
  return row.count;
}

function readFindingStatuses(databasePath: string, identityKey: string): string[] {
  return readFindingRows(databasePath, identityKey).map((row) => row.status);
}

function readFindingRows(
  databasePath: string,
  identityKey: string
): Array<{ id: string; interaction_run_id: string; status: string; body: string }> {
  const database = new DatabaseSync(databasePath);
  const rows = database
    .prepare("SELECT id, interaction_run_id, status, body FROM review_findings WHERE identity_key = ? ORDER BY interaction_run_id ASC, id ASC")
    .all(identityKey) as Array<{ id: string; interaction_run_id: string; status: string; body: string }>;
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
      path: "src\\api.ts",
      startLine: 12,
      endLine: 12,
      side: "new"
    }),
    suggestionJson: input.suggestionJson ?? null,
    status: input.status
  };
}

async function createCompletedRun(
  storage: SqliteStorage,
  tenantId: string,
  projectId: number,
  mergeRequestIid: number,
  noteId: number,
  headSha: string,
  findings: CreateReviewFindingInput[]
): Promise<void> {
  const job = await storage.createOrGetInteractionJob({
    tenantId,
    dedupeKey: `job-${noteId}`,
    projectId,
    mergeRequestIid,
    noteId,
    headSha,
    payloadJson: "{}"
  });
  const run = await storage.createInteractionRun({
    interactionJobId: job.job.id,
    tenantId,
    provider: "copilot-sdk",
    model: null,
    modelProfileName: null,
    providerBaseUrl: null,
    providerType: null,
    textGenerationModel: null
  });
  await storage.completeInteractionRun(
    run.id,
    JSON.stringify({
      overview: {
        summary: "Summary",
        overallSeverity: "medium"
      },
      findings: [],
      priorDispositions: []
    })
  );
  await storage.replaceReviewFindings(
    run.id,
    findings.map((finding) => ({
      ...finding,
      interactionRunId: run.id
    }))
  );
}

async function createFailedRun(
  storage: SqliteStorage,
  tenantId: string,
  projectId: number,
  mergeRequestIid: number,
  noteId: number,
  headSha: string,
  findings: CreateReviewFindingInput[]
): Promise<void> {
  const job = await storage.createOrGetInteractionJob({
    tenantId,
    dedupeKey: `failed-job-${noteId}`,
    projectId,
    mergeRequestIid,
    noteId,
    headSha,
    payloadJson: "{}"
  });
  const run = await storage.createInteractionRun({
    interactionJobId: job.job.id,
    tenantId,
    provider: "copilot-sdk",
    model: null,
    modelProfileName: null,
    providerBaseUrl: null,
    providerType: null,
    textGenerationModel: null
  });
  await storage.replaceReviewFindings(
    run.id,
    findings.map((finding) => ({
      ...finding,
      interactionRunId: run.id
    }))
  );
  await storage.failInteractionRun(run.id, "synthetic failure");
}
