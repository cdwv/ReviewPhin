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
import { createGitLabTenantInput } from "./helpers/gitlab-tenant.js";
import { openSqliteTestStorage } from "./helpers/storage.js";

describe("SqliteStorage review findings", () => {
  it("applies the baseline migration to an empty database", async () => {
    const databasePath = join(
      await mkdtemp(join(tmpdir(), "reviewphin-storage-")),
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
    const tenantColumnNames = readTableColumnNames(verifiedDb, "tenants");
    const interactionJobColumnNames = readTableColumnNames(
      verifiedDb,
      "interaction_jobs",
    );
    const snapshotColumnNames = readTableColumnNames(
      verifiedDb,
      "code_review_snapshots",
    );
    const discussionMappingColumnNames = readTableColumnNames(
      verifiedDb,
      "discussion_mappings",
    );
    const interactionRunMetricsColumnNames = readTableColumnNames(
      verifiedDb,
      "interaction_run_metrics",
    );
    verifiedDb.close();

    expect([...tables]).toEqual(
      expect.arrayContaining([
        "storage_migrations",
        "model_profiles",
        "tenants",
        "interaction_jobs",
        "code_review_snapshots",
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
      {
        adapter_name: "sqlite",
        migration_id: "sqlite:0002_v1_platform_tenants",
      },
      {
        adapter_name: "sqlite",
        migration_id: "sqlite:0003_v1_review_entity_ids",
      },
      {
        adapter_name: "sqlite",
        migration_id: "sqlite:0004_v1_tenant_scoped_reviews",
      },
      {
        adapter_name: "sqlite",
        migration_id: "sqlite:0005_v1_code_review_snapshots",
      },
      {
        adapter_name: "sqlite",
        migration_id: "sqlite:0006_v1_drop_legacy_tenant_columns",
      },
      {
        adapter_name: "sqlite",
        migration_id: "sqlite:0007_v1_generic_storage_column_names",
      },
      {
        adapter_name: "sqlite",
        migration_id: "sqlite:0008_v2_platform_connections",
      },
      {
        adapter_name: "sqlite",
        migration_id: "sqlite:0009_v3_provider_triggers",
      },
      {
        adapter_name: "sqlite",
        migration_id: "sqlite:0010_v4_project_memories",
      },
      {
        adapter_name: "sqlite",
        migration_id: "sqlite:0011_v5_job_claims_and_reasoning_effort",
      },
    ]);
    expect(columnNames.has("anchor_json")).toBe(true);
    expect(columnNames.has("interaction_run_id")).toBe(true);
    expect(tenantColumnNames).toEqual(
      new Set([
        "id",
        "tenant_key",
        "platform",
        "platform_connection_id",
        "platform_config_json",
        "model_profile_name",
        "created_at",
        "updated_at",
      ]),
    );
    expect(interactionJobColumnNames.has("project_id")).toBe(false);
    expect(interactionJobColumnNames.has("merge_request_iid")).toBe(false);
    expect(interactionJobColumnNames.has("repository_id")).toBe(false);
    expect(interactionJobColumnNames.has("note_id")).toBe(false);
    expect(interactionJobColumnNames.has("comment_id")).toBe(true);
    expect(snapshotColumnNames.has("merge_request_iid")).toBe(false);
    expect(snapshotColumnNames.has("merge_request_json")).toBe(false);
    expect(snapshotColumnNames.has("notes_json")).toBe(false);
    expect(snapshotColumnNames.has("comments_json")).toBe(true);
    expect(
      interactionRunMetricsColumnNames.has("prompt_context_prior_threads"),
    ).toBe(false);
    expect(
      interactionRunMetricsColumnNames.has("prompt_context_prior_discussions"),
    ).toBe(true);
    expect(discussionMappingColumnNames.has("project_id")).toBe(false);
    expect(discussionMappingColumnNames.has("merge_request_iid")).toBe(false);
    expect(discussionMappingColumnNames.has("gitlab_discussion_id")).toBe(
      false,
    );
    expect(discussionMappingColumnNames.has("gitlab_comment_id")).toBe(false);
    expect(discussionMappingColumnNames.has("repository_id")).toBe(false);
    expect(discussionMappingColumnNames.has("platform_thread_id")).toBe(false);
    expect(discussionMappingColumnNames.has("platform_discussion_id")).toBe(
      true,
    );
    expect(discussionMappingColumnNames.has("bot_note")).toBe(false);
    expect(discussionMappingColumnNames.has("bot_comment")).toBe(true);
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "review_findings_interaction_run_identity_key_idx",
          unique: 1,
        }),
      ]),
    );
  });

  it("migrates legacy tenants in place without breaking dependent review rows", async () => {
    const databasePath = join(
      await mkdtemp(join(tmpdir(), "reviewphin-storage-")),
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
      CREATE TABLE interaction_jobs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        project_id INTEGER NOT NULL,
        merge_request_iid INTEGER NOT NULL,
        comment_id INTEGER NOT NULL,
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
      INSERT INTO tenants VALUES (
        'tenant_2',
        'https://gitlab.example.com::124',
        'https://gitlab.example.com',
        124,
        'token',
        'secret-2',
        999,
        'alternate-display-name',
        NULL,
        '2026-04-01T00:00:00.000Z',
        '2026-04-01T00:00:00.000Z'
      );
      INSERT INTO tenants VALUES (
        'tenant_3',
        'https://gitlab.example.com::125',
        'https://gitlab.example.com',
        125,
        'different-token',
        'secret-3',
        999,
        'review-bot',
        NULL,
        '2026-04-01T00:00:00.000Z',
        '2026-04-01T00:00:00.000Z'
      );
      INSERT INTO tenants VALUES (
        'tenant_4',
        'https://malformed.example.com::126',
        'https://malformed.example.com',
        126,
        'token',
        'secret-4',
        999,
        NULL,
        NULL,
        '2026-04-01T00:00:00.000Z',
        '2026-04-01T00:00:00.000Z'
      );
      INSERT INTO tenants VALUES (
        'tenant_5',
        'https://gitlab.example.com::127',
        'https://gitlab.example.com/api/v4',
        127,
        'token',
        'secret-5',
        999,
        'review-bot',
        NULL,
        '2026-04-01T00:00:00.000Z',
        '2026-04-01T00:00:00.000Z'
      );
      INSERT INTO interaction_jobs VALUES (
        'job_1',
        'tenant_1',
        'dedupe_1',
        123,
        7,
        55,
        'abc123',
        'queued',
        '{}',
        0,
        NULL,
        '2026-04-01T00:00:00.000Z',
        NULL,
        NULL
      );
    `);
    database.close();

    const storage = await openSqliteTestStorage(databasePath);

    await storage.upsertTenant(
      createGitLabTenantInput({
        apiToken: "token-updated",
        webhookSecret: "secret-updated",
      }),
    );

    const verifiedDb = new DatabaseSync(databasePath);
    const persistedTenant = verifiedDb
      .prepare(
        "SELECT id, tenant_key, platform, platform_connection_id, platform_config_json FROM tenants WHERE id = ?",
      )
      .get("tenant_1") as {
      id: string;
      tenant_key: string;
      platform: string;
      platform_connection_id: string;
      platform_config_json: string;
    };
    const persistedJob = verifiedDb
      .prepare(
        "SELECT tenant_id, code_review_id, comment_id, trigger_json FROM interaction_jobs WHERE id = ?",
      )
      .get("job_1") as {
      tenant_id: string;
      code_review_id: number;
      comment_id: number;
      trigger_json: string;
    };
    const migratedAssignments = verifiedDb
      .prepare("SELECT id, platform_connection_id FROM tenants ORDER BY id")
      .all() as Array<{ id: string; platform_connection_id: string }>;
    const migratedConnections = verifiedDb
      .prepare(
        "SELECT id, name, status FROM platform_connections WHERE name NOT LIKE 'test-%' ORDER BY name",
      )
      .all() as Array<{ id: string; name: string; status: string }>;
    const migrations = verifiedDb
      .prepare("SELECT COUNT(*) AS count FROM storage_migrations")
      .get() as { count: number };
    const tenantColumnNames = readTableColumnNames(verifiedDb, "tenants");
    verifiedDb.close();

    expect(persistedTenant).toEqual({
      id: "tenant_1",
      tenant_key: "https://gitlab.example.com::123",
      platform: "gitlab",
      platform_connection_id: expect.stringMatching(/^connection_/),
      platform_config_json: JSON.stringify({
        projectId: 123,
        webhookSecret: "secret-updated",
      }),
    });
    expect(persistedJob).toEqual({
      tenant_id: "tenant_1",
      code_review_id: 7,
      comment_id: 55,
      trigger_json: '{"kind":"comment","commentId":55}',
    });
    expect(migratedAssignments[0]?.platform_connection_id).toBe(
      migratedAssignments[1]?.platform_connection_id,
    );
    expect(migratedAssignments[2]?.platform_connection_id).not.toBe(
      migratedAssignments[0]?.platform_connection_id,
    );
    expect(migratedAssignments[4]?.platform_connection_id).toBe(
      migratedAssignments[0]?.platform_connection_id,
    );
    expect(
      migratedConnections.find(
        (connection) =>
          connection.id === migratedAssignments[3]?.platform_connection_id,
      )?.status,
    ).toBe("setup_required");
    expect(migratedConnections.map((connection) => connection.name)).toEqual([
      "gitlab-example",
      "gitlab-example-1",
      "malformed-example",
    ]);
    expect(tenantColumnNames).toEqual(
      new Set([
        "id",
        "tenant_key",
        "platform",
        "platform_connection_id",
        "platform_config_json",
        "model_profile_name",
        "created_at",
        "updated_at",
      ]),
    );
    expect(migrations.count).toBe(11);
    await storage.close();
  });

  it("renames legacy generic SQLite columns after earlier v1 migrations already ran", async () => {
    const databasePath = join(
      await mkdtemp(join(tmpdir(), "reviewphin-storage-")),
      "storage.sqlite",
    );
    const database = new DatabaseSync(databasePath);
    database.exec(`
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
        ('sqlite', 'sqlite:0006_v1_drop_legacy_tenant_columns', '2026-04-01T00:00:00.000Z');
      CREATE TABLE tenants (
        id TEXT PRIMARY KEY,
        tenant_key TEXT NOT NULL UNIQUE,
        platform TEXT NOT NULL,
        platform_config_json TEXT NOT NULL,
        model_profile_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE interaction_jobs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        code_review_id INTEGER NOT NULL,
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
      CREATE TABLE code_review_snapshots (
        id TEXT PRIMARY KEY,
        interaction_job_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        code_review_id INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        code_review_json TEXT NOT NULL,
        versions_json TEXT NOT NULL,
        changes_json TEXT NOT NULL,
        notes_json TEXT NOT NULL,
        discussions_json TEXT NOT NULL,
        instructions_json TEXT NOT NULL,
        workspace_strategy TEXT NOT NULL,
        created_at TEXT NOT NULL,
        project_memory_json TEXT,
        FOREIGN KEY (interaction_job_id) REFERENCES interaction_jobs(id),
        FOREIGN KEY (tenant_id) REFERENCES tenants(id)
      );
      CREATE TABLE interaction_runs (
        id TEXT PRIMARY KEY,
        interaction_job_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        status TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        model_profile_name TEXT,
        provider_base_url TEXT,
        provider_type TEXT,
        text_generation_model TEXT,
        FOREIGN KEY (interaction_job_id) REFERENCES interaction_jobs(id),
        FOREIGN KEY (tenant_id) REFERENCES tenants(id)
      );
      CREATE TABLE interaction_run_metrics (
        id TEXT PRIMARY KEY,
        interaction_run_id TEXT NOT NULL UNIQUE,
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
        updated_at TEXT NOT NULL,
        FOREIGN KEY (interaction_run_id) REFERENCES interaction_runs(id)
      );
      CREATE TABLE discussion_mappings (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        code_review_id INTEGER NOT NULL,
        identity_key TEXT NOT NULL,
        finding_fingerprint TEXT NOT NULL,
        title TEXT NOT NULL,
        severity TEXT NOT NULL,
        category TEXT NOT NULL,
        body TEXT NOT NULL,
        platform_thread_id TEXT NOT NULL,
        platform_comment_id INTEGER NOT NULL,
        anchor_json TEXT,
        position_json TEXT,
        bot_discussion INTEGER NOT NULL,
        bot_note INTEGER NOT NULL,
        note_author_id INTEGER,
        note_author_username TEXT,
        status TEXT NOT NULL,
        last_interaction_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id),
        FOREIGN KEY (last_interaction_run_id) REFERENCES interaction_runs(id),
        UNIQUE(tenant_id, code_review_id, platform_thread_id)
      );
      INSERT INTO tenants VALUES (
        'tenant_1',
        'https://gitlab.example.com::123',
        'gitlab',
        '{"baseUrl":"https://gitlab.example.com","projectId":123,"apiToken":"token","webhookSecret":"secret","botUserId":999,"botUsername":"review-bot"}',
        NULL,
        '2026-04-01T00:00:00.000Z',
        '2026-04-01T00:00:00.000Z'
      );
      INSERT INTO interaction_jobs VALUES (
        'job_1',
        'tenant_1',
        'dedupe_1',
        7,
        55,
        'abc123',
        'queued',
        '{}',
        0,
        NULL,
        '2026-04-01T00:00:00.000Z',
        NULL,
        NULL
      );
      INSERT INTO code_review_snapshots VALUES (
        'snapshot_1',
        'job_1',
        'tenant_1',
        7,
        'abc123',
        '{}',
        '[]',
        '[]',
        '[{"id":55}]',
        '[]',
        '[]',
        'hydrated',
        '2026-04-01T00:00:00.000Z',
        NULL
      );
      INSERT INTO interaction_runs VALUES (
        'run_1',
        'job_1',
        'tenant_1',
        'copilot-sdk',
        NULL,
        'completed',
        '{}',
        NULL,
        '2026-04-01T00:00:00.000Z',
        '2026-04-01T00:00:00.000Z',
        NULL,
        NULL,
        NULL,
        NULL
      );
      INSERT INTO interaction_run_metrics VALUES (
        'metrics_1',
        'run_1',
        'direct-mention',
        'first-pass-full',
        100,
        2,
        3,
        4,
        1,
        1,
        1,
        1,
        1,
        10,
        5,
        0,
        0,
        0,
        1000,
        1,
        0,
        '[]',
        '2026-04-01T00:00:00.000Z',
        '2026-04-01T00:00:00.000Z'
      );
      INSERT INTO discussion_mappings VALUES (
        'mapping_1',
        'tenant_1',
        7,
        'identity_1',
        'fingerprint_1',
        'Title',
        'medium',
        'correctness',
        'Body',
        'disc_1',
        55,
        NULL,
        NULL,
        1,
        1,
        999,
        'review-bot',
        'open',
        'run_1',
        '2026-04-01T00:00:00.000Z',
        '2026-04-01T00:00:00.000Z'
      );
    `);
    database.close();

    const storage = await openSqliteTestStorage(databasePath);
    await storage.close();

    const verifiedDb = new DatabaseSync(databasePath);
    expect(readTableColumnNames(verifiedDb, "interaction_jobs")).toEqual(
      expectColumnSetContaining(["comment_id"], ["note_id"]),
    );
    expect(readTableColumnNames(verifiedDb, "code_review_snapshots")).toEqual(
      expectColumnSetContaining(["comments_json"], ["notes_json"]),
    );
    expect(readTableColumnNames(verifiedDb, "interaction_run_metrics")).toEqual(
      expectColumnSetContaining(
        ["prompt_context_prior_discussions", "prompt_context_comments"],
        ["prompt_context_prior_threads", "prompt_context_notes"],
      ),
    );
    expect(readTableColumnNames(verifiedDb, "discussion_mappings")).toEqual(
      expectColumnSetContaining(
        [
          "platform_discussion_id",
          "bot_comment",
          "comment_author_id",
          "comment_author_username",
        ],
        [
          "platform_thread_id",
          "bot_note",
          "note_author_id",
          "note_author_username",
        ],
      ),
    );
    expect(
      verifiedDb
        .prepare(
          "SELECT comment_id, trigger_json, dedupe_key FROM interaction_jobs WHERE id = ?",
        )
        .get("job_1"),
    ).toEqual({
      comment_id: 55,
      trigger_json: '{"kind":"comment","commentId":55}',
      dedupe_key: "dedupe_1",
    });
    expect(
      verifiedDb
        .prepare("SELECT comments_json FROM code_review_snapshots WHERE id = ?")
        .get("snapshot_1"),
    ).toEqual({ comments_json: '[{"id":55}]' });
    expect(
      verifiedDb
        .prepare(
          "SELECT prompt_context_prior_discussions, prompt_context_comments FROM interaction_run_metrics WHERE id = ?",
        )
        .get("metrics_1"),
    ).toEqual({
      prompt_context_prior_discussions: 3,
      prompt_context_comments: 4,
    });
    expect(
      verifiedDb
        .prepare(
          "SELECT platform_discussion_id, bot_comment, comment_author_id, comment_author_username FROM discussion_mappings WHERE id = ?",
        )
        .get("mapping_1"),
    ).toEqual({
      platform_discussion_id: "disc_1",
      bot_comment: 1,
      comment_author_id: 999,
      comment_author_username: "review-bot",
    });
    expect(
      verifiedDb
        .prepare(
          "SELECT migration_id FROM storage_migrations ORDER BY migration_id",
        )
        .all(),
    ).toEqual([
      { migration_id: "sqlite:0001_v0_baseline" },
      { migration_id: "sqlite:0002_v1_platform_tenants" },
      { migration_id: "sqlite:0003_v1_review_entity_ids" },
      { migration_id: "sqlite:0004_v1_tenant_scoped_reviews" },
      { migration_id: "sqlite:0005_v1_code_review_snapshots" },
      { migration_id: "sqlite:0006_v1_drop_legacy_tenant_columns" },
      { migration_id: "sqlite:0007_v1_generic_storage_column_names" },
      { migration_id: "sqlite:0008_v2_platform_connections" },
      { migration_id: "sqlite:0009_v3_provider_triggers" },
      { migration_id: "sqlite:0010_v4_project_memories" },
      { migration_id: "sqlite:0011_v5_job_claims_and_reasoning_effort" },
    ]);
    verifiedDb.close();
  });

  it("returns latest prior finding state per identity and updates status in place", async () => {
    const databasePath = join(
      await mkdtemp(join(tmpdir(), "reviewphin-storage-")),
      "storage.sqlite",
    );
    const storage = await openSqliteTestStorage(databasePath);

    const tenant = await storage.upsertTenant(createGitLabTenantInput());

    await createCompletedRun(storage, tenant.id, 7, 55, "head-one", [
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
    ]);

    await createCompletedRun(storage, tenant.id, 7, 56, "head-two", [
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
    ]);

    const currentJob = await storage.createOrGetInteractionJob({
      tenantId: tenant.id,
      dedupeKey: "current-job",
      codeReviewId: 7,
      commentId: 57,
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
      await mkdtemp(join(tmpdir(), "reviewphin-storage-")),
      "storage.sqlite",
    );
    const storage = await openSqliteTestStorage(databasePath);

    const tenant = await storage.upsertTenant(createGitLabTenantInput());

    await createCompletedRun(storage, tenant.id, 7, 70, "head-completed", [
      createFinding({
        identityKey: "identity_status",
        title: "Persist status on completed run",
        body: "Completed version",
        status: "open",
      }),
    ]);

    await createFailedRun(storage, tenant.id, 7, 71, "head-failed", [
      createFinding({
        identityKey: "identity_status",
        title: "Persist status on completed run",
        body: "Failed version",
        status: "open",
      }),
    ]);

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
      codeReviewId: 7,
      commentId: 72,
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
      await mkdtemp(join(tmpdir(), "reviewphin-storage-")),
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

    expect(migrations).toEqual([
      { migration_id: "sqlite:0001_v0_baseline" },
      { migration_id: "sqlite:0002_v1_platform_tenants" },
      { migration_id: "sqlite:0003_v1_review_entity_ids" },
      { migration_id: "sqlite:0004_v1_tenant_scoped_reviews" },
      { migration_id: "sqlite:0005_v1_code_review_snapshots" },
      { migration_id: "sqlite:0006_v1_drop_legacy_tenant_columns" },
      { migration_id: "sqlite:0007_v1_generic_storage_column_names" },
      { migration_id: "sqlite:0008_v2_platform_connections" },
      { migration_id: "sqlite:0009_v3_provider_triggers" },
      { migration_id: "sqlite:0010_v4_project_memories" },
      { migration_id: "sqlite:0011_v5_job_claims_and_reasoning_effort" },
    ]);
  });

  it("stores only one finding row per identity for a review run", async () => {
    const databasePath = join(
      await mkdtemp(join(tmpdir(), "reviewphin-storage-")),
      "storage.sqlite",
    );
    const storage = await openSqliteTestStorage(databasePath);

    const tenant = await storage.upsertTenant(createGitLabTenantInput());

    const job = await storage.createOrGetInteractionJob({
      tenantId: tenant.id,
      dedupeKey: "dedupe-write-path",
      codeReviewId: 7,
      commentId: 80,
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
      await mkdtemp(join(tmpdir(), "reviewphin-storage-")),
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

    const tenant = await storage.upsertTenant(
      createGitLabTenantInput({ modelProfileName: "byok" }),
    );
    const job = await storage.createOrGetInteractionJob({
      tenantId: tenant.id,
      dedupeKey: "profiled-job",
      codeReviewId: 7,
      commentId: 55,
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
      await mkdtemp(join(tmpdir(), "reviewphin-storage-")),
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
    await storage.upsertTenant(
      createGitLabTenantInput({ modelProfileName: "shared-profile" }),
    );

    await expect(storage.deleteModelProfile("shared-profile")).rejects.toThrow(
      "still reference",
    );
  });

  it("deletes a tenant by normalized base URL and project ID", async () => {
    const databasePath = join(
      await mkdtemp(join(tmpdir(), "reviewphin-storage-")),
      "storage.sqlite",
    );
    const storage = await openSqliteTestStorage(databasePath);

    await storage.upsertTenant(
      createGitLabTenantInput({
        baseUrl: "https://gitlab.example.com/gitlab/",
        apiToken: "token-one",
        webhookSecret: "secret-one",
      }),
    );
    const secondTenant = await storage.upsertTenant(
      createGitLabTenantInput({
        projectId: 456,
        apiToken: "token-two",
        webhookSecret: "secret-two",
        botUserId: 1000,
        botUsername: "review-bot-2",
      }),
    );

    const deletedTenant =
      (
        await storage.deleteTenantWithSummary(
          "https://gitlab.example.com/gitlab::123",
        )
      )?.tenant ?? null;
    const remainingTenants = await listAll(storage.stores.tenants);

    expect(deletedTenant).toMatchObject({
      key: "https://gitlab.example.com/gitlab::123",
    });
    expect(remainingTenants).toHaveLength(1);
    expect(remainingTenants[0]).toMatchObject({
      id: secondTenant.id,
      key: secondTenant.key,
    });
  });

  it("deletes dependent review data before removing a tenant", async () => {
    const databasePath = join(
      await mkdtemp(join(tmpdir(), "reviewphin-storage-")),
      "storage.sqlite",
    );
    const storage = await openSqliteTestStorage(databasePath);

    const tenant = await storage.upsertTenant(
      createGitLabTenantInput({
        baseUrl: "https://gitlab.example.com/gitlab",
        apiToken: "token-one",
        webhookSecret: "secret-one",
      }),
    );

    const reviewJob = await storage.createOrGetInteractionJob({
      tenantId: tenant.id,
      dedupeKey: "delete-tenant-job",
      codeReviewId: 7,
      commentId: 55,
      headSha: "head-sha",
      payloadJson: "{}",
    });
    await storage.createCodeReviewSnapshot({
      interactionJobId: reviewJob.job.id,
      tenantId: tenant.id,
      codeReviewId: 7,
      headSha: "head-sha",
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
      identityKey: "delete-tenant-finding",
      findingFingerprint: "fingerprint-1",
      title: "Delete tenant finding",
      severity: "medium",
      category: "correctness",
      body: "The finding should be removed",
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

    const deletionSummary = await storage.getTenantDeletionSummary(tenant.key);
    expect(deletionSummary).toMatchObject({
      interactionJobCount: 1,
      codeReviewSnapshotCount: 1,
      interactionRunCount: 1,
      reviewFindingCount: 1,
      interactionRunMetricCount: 1,
      discussionMappingCount: 1,
      interactionJobIds: [reviewJob.job.id],
      interactionRunIds: [reviewRun.id],
    });

    const claimed = await storage.stores.interactionJobs.claimNext({
      workerId: "tenant-delete-test",
      claimToken: "tenant-delete-claim",
      now: new Date().toISOString(),
      claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      queuedAfter: "2020-01-01T00:00:00.000Z",
      maxJobRetries: 3,
    });
    expect(claimed?.id).toBe(reviewJob.job.id);
    await expect(storage.deleteTenantWithSummary(tenant.key)).rejects.toThrow(
      /in progress/,
    );
    const queuedJob = await storage.createOrGetInteractionJob({
      tenantId: tenant.id,
      dedupeKey: "tenant-delete-queued-job",
      codeReviewId: 8,
      commentId: 56,
      headSha: "def456",
      payloadJson: "{}",
    });
    await expect(storage.deleteTenantWithSummary(tenant.key)).rejects.toThrow(
      /in progress/,
    );
    expect(
      await storage.stores.interactionJobs.get(queuedJob.job.id),
    ).toMatchObject({
      status: "queued",
      finishedAt: null,
      lastError: null,
    });
    await storage.stores.interactionJobs.delete(queuedJob.job.id);
    expect(countRows(databasePath, "interaction_jobs")).toBe(1);
    expect(countRows(databasePath, "code_review_snapshots")).toBe(1);
    expect(countRows(databasePath, "interaction_runs")).toBe(1);
    expect(countRows(databasePath, "review_findings")).toBe(1);
    expect(countRows(databasePath, "interaction_run_metrics")).toBe(1);
    expect(countRows(databasePath, "discussion_mappings")).toBe(1);
    await storage.stores.interactionJobs.transitionClaim({
      jobId: reviewJob.job.id,
      claimToken: "tenant-delete-claim",
      status: "queued",
      retryCount: 0,
      lastError: null,
      availableAt: reviewJob.job.availableAt,
      finishedAt: null,
    });

    const deletedSummary = await storage.deleteTenantWithSummary(tenant.key);

    expect(deletedSummary).toMatchObject({
      tenant: {
        id: tenant.id,
      },
      interactionJobIds: [reviewJob.job.id],
      interactionRunIds: [reviewRun.id],
    });
    expect(countRows(databasePath, "tenants")).toBe(0);
    expect(countRows(databasePath, "interaction_jobs")).toBe(0);
    expect(countRows(databasePath, "code_review_snapshots")).toBe(0);
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

function readTableColumnNames(
  database: DatabaseSync,
  tableName: string,
): Set<string> {
  return new Set(
    (
      database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );
}

function expectColumnSetContaining(
  included: string[],
  excluded: string[],
): unknown {
  return {
    asymmetricMatch(value: unknown) {
      if (!(value instanceof Set)) {
        return false;
      }
      return (
        included.every((columnName) => value.has(columnName)) &&
        excluded.every((columnName) => !value.has(columnName))
      );
    },
    toString() {
      return `ColumnSetIncluding(${included.join(",")})Excluding(${excluded.join(",")})`;
    },
  };
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
  codeReviewId: number,
  commentId: number,
  headSha: string,
  findings: CreateReviewFindingInput[],
): Promise<void> {
  const job = await storage.createOrGetInteractionJob({
    tenantId,
    dedupeKey: `job-${commentId}`,
    codeReviewId,
    commentId,
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
  codeReviewId: number,
  commentId: number,
  headSha: string,
  findings: CreateReviewFindingInput[],
): Promise<void> {
  const job = await storage.createOrGetInteractionJob({
    tenantId,
    dedupeKey: `failed-job-${commentId}`,
    codeReviewId,
    commentId,
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
  codeReviewId: number,
  commentId: number,
  headSha: string,
  findings: CreateReviewFindingInput[],
): Promise<void> {
  const job = await storage.createOrGetInteractionJob({
    tenantId,
    dedupeKey: `cancelled-job-${commentId}`,
    codeReviewId,
    commentId,
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
      await mkdtemp(join(tmpdir(), "reviewphin-storage-")),
      "storage.sqlite",
    );
    const storage = await openSqliteTestStorage(databasePath);
    const tenant = await storage.upsertTenant(createGitLabTenantInput());

    await createCancelledRun(storage, tenant.id, 7, 88, "head-cancelled", [
      createFinding({
        identityKey: "cancelled-finding",
        title: "Cancelled finding",
        body: "This finding should be removed on cancellation.",
        status: "open",
      }),
    ]);

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
