import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { TenantConfig } from "../config.js";
import type { ReviewAnchor, ReviewSuggestion } from "../review/types.js";
import { createId, createTenantKey } from "../utils/ids.js";
import type {
  CreateMergeRequestSnapshotInput,
  CreateReviewFindingInput,
  CreateInteractionJobInput,
  CreateInteractionRunInput,
  DiscussionMappingRecord,
  MergeRequestSnapshotRecord,
  ModelProfileRecord,
  PreviousCompletedInteractionRecord,
  PriorReviewFindingRecord,
  ReviewFindingStatus,
  InteractionRunMetricsRecord,
  InteractionJobRecord,
  InteractionRunRecord,
  TenantDeletionSummary,
  TenantRecord,
  UpsertModelProfileInput,
  UpsertInteractionRunMetricsInput,
  UpsertDiscussionMappingInput
} from "./types.js";
import type { Storage } from "./types.js";

interface SqliteStorageOptions {
  databasePath: string;
}

type Row = Record<string, unknown>;

export class SqliteStorage implements Storage {
  private readonly databasePath: string;
  private db: DatabaseSync | null = null;

  public constructor(options: SqliteStorageOptions) {
    this.databasePath = options.databasePath;
  }

  public async initialize(): Promise<void> {
    await mkdir(dirname(this.databasePath), { recursive: true });

    this.db = new DatabaseSync(this.databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
    `);
    migrateInteractionExecutionSchema(this.db);
    this.db.exec(`

      CREATE TABLE IF NOT EXISTS model_profiles (
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

      CREATE TABLE IF NOT EXISTS tenants (
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

      CREATE TABLE IF NOT EXISTS interaction_jobs (
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

      CREATE TABLE IF NOT EXISTS merge_request_snapshots (
        id TEXT PRIMARY KEY,
        interaction_job_id TEXT NOT NULL,
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
        created_at TEXT NOT NULL,
        FOREIGN KEY (interaction_job_id) REFERENCES interaction_jobs(id),
        FOREIGN KEY (tenant_id) REFERENCES tenants(id)
      );

      CREATE TABLE IF NOT EXISTS interaction_runs (
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
        finished_at TEXT,
        FOREIGN KEY (interaction_job_id) REFERENCES interaction_jobs(id),
        FOREIGN KEY (tenant_id) REFERENCES tenants(id)
      );

      CREATE TABLE IF NOT EXISTS review_findings (
        id TEXT PRIMARY KEY,
        interaction_run_id TEXT NOT NULL,
        identity_key TEXT NOT NULL,
        severity TEXT NOT NULL,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        anchor_json TEXT,
        suggestion_json TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        FOREIGN KEY (interaction_run_id) REFERENCES interaction_runs(id)
      );

      CREATE TABLE IF NOT EXISTS interaction_run_metrics (
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

      CREATE TABLE IF NOT EXISTS discussion_mappings (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        project_id INTEGER NOT NULL,
        merge_request_iid INTEGER NOT NULL,
        identity_key TEXT NOT NULL,
        finding_fingerprint TEXT NOT NULL,
        title TEXT NOT NULL,
        severity TEXT NOT NULL,
        category TEXT NOT NULL,
        body TEXT NOT NULL,
        gitlab_discussion_id TEXT NOT NULL,
        gitlab_note_id INTEGER NOT NULL,
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
        UNIQUE(tenant_id, merge_request_iid, gitlab_discussion_id)
      );
    `);
    ensureColumn(this.db, "model_profiles", "wire_api", "TEXT");
    ensureColumn(this.db, "tenants", "model_profile_name", "TEXT");
    ensureColumn(this.db, "merge_request_snapshots", "project_memory_json", "TEXT");
    ensureColumn(this.db, "interaction_runs", "model_profile_name", "TEXT");
    ensureColumn(this.db, "interaction_runs", "provider_base_url", "TEXT");
    ensureColumn(this.db, "interaction_runs", "provider_type", "TEXT");
    ensureColumn(this.db, "interaction_runs", "text_generation_model", "TEXT");
    normalizeReviewFindingsTable(this.db);
    dedupeReviewFindingsTable(this.db);
    this.db.exec(`
      DROP INDEX IF EXISTS review_findings_review_run_identity_key_idx;

      CREATE UNIQUE INDEX IF NOT EXISTS model_profiles_single_default_idx
      ON model_profiles (is_default)
      WHERE is_default = 1;

      CREATE UNIQUE INDEX IF NOT EXISTS review_findings_interaction_run_identity_key_idx
      ON review_findings (interaction_run_id, identity_key);
    `);
  }

  public async upsertModelProfile(input: UpsertModelProfileInput): Promise<ModelProfileRecord> {
    const database = this.getDb();
    const now = new Date().toISOString();

    database.exec("BEGIN IMMEDIATE");
    try {
      const existingRow = database.prepare("SELECT * FROM model_profiles WHERE name = ?").get(input.name) as Row | undefined;
      const existing = existingRow ? mapModelProfileRow(existingRow) : null;
      const resolvedInput = resolveModelProfileUpsertInput(existing, input);

      if (resolvedInput.isDefault) {
        database
          .prepare("UPDATE model_profiles SET is_default = 0, updated_at = ? WHERE is_default = 1 AND name != ?")
          .run(now, input.name);
      }

      database
        .prepare(`
          INSERT INTO model_profiles (
            name,
            provider_base_url,
            provider_type,
            wire_api,
            auth_token,
            review_model,
            text_generation_model,
            is_default,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET
            provider_base_url = excluded.provider_base_url,
            provider_type = excluded.provider_type,
            wire_api = excluded.wire_api,
            auth_token = excluded.auth_token,
            review_model = excluded.review_model,
            text_generation_model = excluded.text_generation_model,
            is_default = excluded.is_default,
            updated_at = excluded.updated_at
        `)
        .run(
          input.name,
          resolvedInput.providerBaseUrl,
          resolvedInput.providerType,
          resolvedInput.wireApi,
          resolvedInput.authToken,
          resolvedInput.reviewModel,
          resolvedInput.textGenerationModel,
          resolvedInput.isDefault ? 1 : 0,
          now,
          now
        );

      const row = database.prepare("SELECT * FROM model_profiles WHERE name = ?").get(input.name) as Row | undefined;
      if (!row) {
        throw new Error(`Failed to upsert model profile ${input.name}`);
      }

      database.exec("COMMIT");
      return mapModelProfileRow(row);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  public async listModelProfiles(): Promise<ModelProfileRecord[]> {
    const rows = this.getDb()
      .prepare("SELECT * FROM model_profiles ORDER BY is_default DESC, name ASC")
      .all() as Row[];
    return rows.map(mapModelProfileRow);
  }

  public async getModelProfileByName(name: string): Promise<ModelProfileRecord | null> {
    const row = this.getDb().prepare("SELECT * FROM model_profiles WHERE name = ?").get(name) as Row | undefined;
    return row ? mapModelProfileRow(row) : null;
  }

  public async getDefaultModelProfile(): Promise<ModelProfileRecord | null> {
    const row = this.getDb().prepare("SELECT * FROM model_profiles WHERE is_default = 1 LIMIT 1").get() as Row | undefined;
    return row ? mapModelProfileRow(row) : null;
  }

  public async setDefaultModelProfile(name: string | null): Promise<ModelProfileRecord | null> {
    const database = this.getDb();
    const now = new Date().toISOString();

    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare("UPDATE model_profiles SET is_default = 0, updated_at = ? WHERE is_default = 1").run(now);
      if (name === null) {
        database.exec("COMMIT");
        return null;
      }

      const result = database
        .prepare("UPDATE model_profiles SET is_default = 1, updated_at = ? WHERE name = ?")
        .run(now, name);
      if (result.changes === 0) {
        throw new Error(`Unknown model profile ${name}`);
      }

      const row = database.prepare("SELECT * FROM model_profiles WHERE name = ?").get(name) as Row | undefined;
      if (!row) {
        throw new Error(`Failed to load model profile ${name} after setting default`);
      }

      database.exec("COMMIT");
      return mapModelProfileRow(row);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  public async deleteModelProfile(name: string): Promise<ModelProfileRecord | null> {
    const database = this.getDb();
    const existing = database.prepare("SELECT * FROM model_profiles WHERE name = ?").get(name) as Row | undefined;
    if (!existing) {
      return null;
    }

    const tenantReferenceCount = asNumber(
      (database
        .prepare("SELECT COUNT(*) AS count FROM tenants WHERE model_profile_name = ?")
        .get(name) as Row).count
    );
    if (tenantReferenceCount > 0) {
      throw new Error(`Cannot delete model profile "${name}" because ${tenantReferenceCount} tenant(s) still reference it`);
    }

    database.prepare("DELETE FROM model_profiles WHERE name = ?").run(name);
    return mapModelProfileRow(existing);
  }

  public async upsertTenant(tenant: TenantConfig): Promise<TenantRecord> {
    const database = this.getDb();
    const existingRow = database
      .prepare("SELECT * FROM tenants WHERE base_url = ? AND project_id = ?")
      .get(tenant.baseUrl, tenant.projectId) as Row | undefined;
    const existing = existingRow ? mapTenantRow(existingRow) : null;
    const resolvedModelProfileName = tenant.modelProfileName === undefined
      ? (existing?.modelProfileName ?? null)
      : tenant.modelProfileName;
    if (resolvedModelProfileName) {
      assertModelProfileExists(database, resolvedModelProfileName);
    }

    const statement = database.prepare(`
      INSERT INTO tenants (
        id,
        tenant_key,
        base_url,
        project_id,
        api_token,
        webhook_secret,
        bot_user_id,
        bot_username,
        model_profile_name,
        created_at,
        updated_at
      )
      VALUES (
        :id,
        :tenantKey,
        :baseUrl,
        :projectId,
        :apiToken,
        :webhookSecret,
        :botUserId,
        :botUsername,
        :modelProfileName,
        :createdAt,
        :updatedAt
      )
      ON CONFLICT(base_url, project_id) DO UPDATE SET
        tenant_key = excluded.tenant_key,
        api_token = excluded.api_token,
        webhook_secret = excluded.webhook_secret,
        bot_user_id = excluded.bot_user_id,
        bot_username = excluded.bot_username,
        model_profile_name = excluded.model_profile_name,
        updated_at = excluded.updated_at
    `);

    const now = new Date().toISOString();
    statement.run({
      id: createId("tenant"),
      tenantKey: createTenantKey(tenant.baseUrl, tenant.projectId),
      baseUrl: tenant.baseUrl,
      projectId: tenant.projectId,
      apiToken: tenant.apiToken,
      webhookSecret: tenant.webhookSecret,
      botUserId: tenant.botUserId ?? null,
      botUsername: tenant.botUsername ?? null,
      modelProfileName: resolvedModelProfileName,
      createdAt: now,
      updatedAt: now
    });

    const row = database
      .prepare("SELECT * FROM tenants WHERE base_url = ? AND project_id = ?")
      .get(tenant.baseUrl, tenant.projectId) as Row | undefined;
    if (!row) {
      throw new Error(`Failed to upsert tenant ${tenant.baseUrl} project ${tenant.projectId}`);
    }

    return mapTenantRow(row);
  }

  public async listTenants(): Promise<TenantRecord[]> {
    return this.listAllTenants();
  }

  public async listTenantsByProjectId(projectId: number): Promise<TenantRecord[]> {
    const rows = this.getDb()
      .prepare("SELECT * FROM tenants WHERE project_id = ? ORDER BY base_url ASC")
      .all(projectId) as Row[];

    return rows.map(mapTenantRow);
  }

  public async getTenantById(tenantId: string): Promise<TenantRecord | null> {
    const row = this.getDb().prepare("SELECT * FROM tenants WHERE id = ?").get(tenantId) as Row | undefined;
    return row ? mapTenantRow(row) : null;
  }

  public async setTenantModelProfile(
    baseUrl: string,
    projectId: number,
    modelProfileName: string | null
  ): Promise<TenantRecord> {
    const database = this.getDb();
    const tenantKey = createTenantKey(baseUrl, projectId);
    if (modelProfileName) {
      assertModelProfileExists(database, modelProfileName);
    }

    const result = database
      .prepare("UPDATE tenants SET model_profile_name = ?, updated_at = ? WHERE tenant_key = ?")
      .run(modelProfileName, new Date().toISOString(), tenantKey);
    if (result.changes === 0) {
      throw new Error(`Tenant not found for ${baseUrl} :: ${projectId}`);
    }

    const row = database.prepare("SELECT * FROM tenants WHERE tenant_key = ?").get(tenantKey) as Row | undefined;
    if (!row) {
      throw new Error(`Failed to reload tenant ${baseUrl} :: ${projectId}`);
    }

    return mapTenantRow(row);
  }

  public async getTenantDeletionSummary(baseUrl: string, projectId: number): Promise<TenantDeletionSummary | null> {
    const database = this.getDb();
    const tenantKey = createTenantKey(baseUrl, projectId);
    const row = database
      .prepare("SELECT * FROM tenants WHERE tenant_key = ?")
      .get(tenantKey) as Row | undefined;
    if (!row) {
      return null;
    }

    return buildTenantDeletionSummary(database, mapTenantRow(row));
  }

  public async deleteTenantWithSummary(baseUrl: string, projectId: number): Promise<TenantDeletionSummary | null> {
    const database = this.getDb();
    database.exec("BEGIN IMMEDIATE");

    try {
      const summary = getTenantDeletionSummaryFromDb(database, baseUrl, projectId);
      if (!summary) {
        database.exec("ROLLBACK");
        return null;
      }

      database.prepare("DELETE FROM discussion_mappings WHERE tenant_id = ?").run(summary.tenant.id);
      database
        .prepare(
          `
            DELETE FROM interaction_run_metrics
            WHERE interaction_run_id IN (
              SELECT id FROM interaction_runs WHERE tenant_id = ?
            )
          `
        )
        .run(summary.tenant.id);
      database
        .prepare(
          `
            DELETE FROM review_findings
            WHERE interaction_run_id IN (
              SELECT id FROM interaction_runs WHERE tenant_id = ?
            )
          `
        )
        .run(summary.tenant.id);
      database.prepare("DELETE FROM merge_request_snapshots WHERE tenant_id = ?").run(summary.tenant.id);
      database.prepare("DELETE FROM interaction_runs WHERE tenant_id = ?").run(summary.tenant.id);
      database.prepare("DELETE FROM interaction_jobs WHERE tenant_id = ?").run(summary.tenant.id);
      database.prepare("DELETE FROM tenants WHERE id = ?").run(summary.tenant.id);
      database.exec("COMMIT");
      return summary;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  public async deleteTenant(baseUrl: string, projectId: number): Promise<TenantRecord | null> {
    const summary = await this.deleteTenantWithSummary(baseUrl, projectId);
    return summary?.tenant ?? null;
  }

  public async createOrGetInteractionJob(
    input: CreateInteractionJobInput
  ): Promise<{ job: InteractionJobRecord; created: boolean }> {
    const database = this.getDb();
    const existing = database.prepare("SELECT * FROM interaction_jobs WHERE dedupe_key = ?").get(input.dedupeKey) as
      | Row
      | undefined;

    if (existing) {
      return {
        job: mapInteractionJobRow(existing),
        created: false
      };
    }

    const now = new Date().toISOString();
    const jobId = createId("job");

    database
      .prepare(`
        INSERT INTO interaction_jobs (
          id,
          tenant_id,
          dedupe_key,
          project_id,
          merge_request_iid,
          note_id,
          head_sha,
          status,
          payload_json,
          retry_count,
          last_error,
          enqueued_at,
          started_at,
          finished_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0, NULL, ?, NULL, NULL)
      `)
      .run(
        jobId,
        input.tenantId,
        input.dedupeKey,
        input.projectId,
        input.mergeRequestIid,
        input.noteId,
        input.headSha,
        input.payloadJson,
        now
      );

    const created = await this.getInteractionJobById(jobId);
    if (!created) {
      throw new Error(`Failed to create interaction job ${jobId}`);
    }

    return { job: created, created: true };
  }

  public async getInteractionJobById(jobId: string): Promise<InteractionJobRecord | null> {
    const row = this.getDb().prepare("SELECT * FROM interaction_jobs WHERE id = ?").get(jobId) as Row | undefined;
    return row ? mapInteractionJobRow(row) : null;
  }

  public async listQueuedInteractionJobs(): Promise<InteractionJobRecord[]> {
    const rows = this.getDb()
      .prepare("SELECT * FROM interaction_jobs WHERE status = 'queued' ORDER BY enqueued_at ASC")
      .all() as Row[];
    return rows.map(mapInteractionJobRow);
  }

  public async markJobInProgress(jobId: string): Promise<void> {
    this.getDb()
      .prepare(
        "UPDATE interaction_jobs SET status = 'in_progress', started_at = ?, finished_at = NULL, last_error = NULL WHERE id = ?"
      )
      .run(new Date().toISOString(), jobId);
  }

  public async markJobCompleted(jobId: string): Promise<void> {
    this.getDb()
      .prepare("UPDATE interaction_jobs SET status = 'completed', finished_at = ?, last_error = NULL WHERE id = ?")
      .run(new Date().toISOString(), jobId);
  }

  public async markJobQueued(jobId: string, retryCount: number, error: string): Promise<void> {
    this.getDb()
      .prepare(
        "UPDATE interaction_jobs SET status = 'queued', retry_count = ?, last_error = ?, finished_at = NULL WHERE id = ?"
      )
      .run(retryCount, error, jobId);
  }

  public async markJobFailed(jobId: string, retryCount: number, error: string): Promise<void> {
    this.getDb()
      .prepare(
        "UPDATE interaction_jobs SET status = 'failed', retry_count = ?, last_error = ?, finished_at = ? WHERE id = ?"
      )
      .run(retryCount, error, new Date().toISOString(), jobId);
  }

  public async createMergeRequestSnapshot(
    input: CreateMergeRequestSnapshotInput
  ): Promise<MergeRequestSnapshotRecord> {
    const snapshotId = createId("snapshot");
    const now = new Date().toISOString();

    this.getDb()
      .prepare(`
        INSERT INTO merge_request_snapshots (
          id,
          interaction_job_id,
          tenant_id,
          merge_request_iid,
          head_sha,
          merge_request_json,
          versions_json,
          changes_json,
          notes_json,
          discussions_json,
          instructions_json,
          project_memory_json,
          workspace_strategy,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        snapshotId,
        input.interactionJobId,
        input.tenantId,
        input.mergeRequestIid,
        input.headSha,
        input.mergeRequestJson,
        input.versionsJson,
        input.changesJson,
        input.notesJson,
        input.discussionsJson,
        input.instructionsJson,
        input.projectMemoryJson,
        input.workspaceStrategy,
        now
      );

    return {
      id: snapshotId,
      interactionJobId: input.interactionJobId,
      tenantId: input.tenantId,
      mergeRequestIid: input.mergeRequestIid,
      headSha: input.headSha,
      mergeRequestJson: input.mergeRequestJson,
      versionsJson: input.versionsJson,
      changesJson: input.changesJson,
      notesJson: input.notesJson,
      discussionsJson: input.discussionsJson,
      instructionsJson: input.instructionsJson,
      projectMemoryJson: input.projectMemoryJson,
      workspaceStrategy: input.workspaceStrategy,
      createdAt: now
    };
  }

  public async createInteractionRun(input: CreateInteractionRunInput): Promise<InteractionRunRecord> {
    const interactionRunId = createId("run");
    const now = new Date().toISOString();

    this.getDb()
      .prepare(`
        INSERT INTO interaction_runs (
          id,
          interaction_job_id,
          tenant_id,
          provider,
          model,
          model_profile_name,
          provider_base_url,
          provider_type,
          text_generation_model,
          status,
          result_json,
          error,
          started_at,
          finished_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', NULL, NULL, ?, NULL)
      `)
      .run(
        interactionRunId,
        input.interactionJobId,
        input.tenantId,
        input.provider,
        input.model,
        input.modelProfileName,
        input.providerBaseUrl,
        input.providerType,
        input.textGenerationModel,
        now
      );

    return {
      id: interactionRunId,
      interactionJobId: input.interactionJobId,
      tenantId: input.tenantId,
      provider: input.provider,
      model: input.model,
      modelProfileName: input.modelProfileName,
      providerBaseUrl: input.providerBaseUrl,
      providerType: input.providerType,
      textGenerationModel: input.textGenerationModel,
      status: "in_progress",
      resultJson: null,
      error: null,
      startedAt: now,
      finishedAt: null
    };
  }

  public async getLatestCompletedInteractionForMergeRequest(
    tenantId: string,
    mergeRequestIid: number,
    currentInteractionJobId: string
  ): Promise<PreviousCompletedInteractionRecord | null> {
    const row = this.getDb()
      .prepare(`
        SELECT
          s.*,
          r.id AS interaction_run_id,
          r.finished_at AS interaction_run_finished_at,
          r.result_json AS interaction_run_result_json,
          j.id AS interaction_job_id,
          j.head_sha AS interaction_job_head_sha
        FROM merge_request_snapshots s
        INNER JOIN interaction_jobs j ON j.id = s.interaction_job_id
        INNER JOIN interaction_runs r ON r.interaction_job_id = j.id
        WHERE s.tenant_id = ?
          AND s.merge_request_iid = ?
          AND s.interaction_job_id != ?
          AND r.status = 'completed'
          AND r.result_json IS NOT NULL
        ORDER BY COALESCE(r.finished_at, r.started_at) DESC, s.created_at DESC
        LIMIT 1
      `)
      .get(tenantId, mergeRequestIid, currentInteractionJobId) as Row | undefined;

    if (!row) {
      return null;
    }

    return {
      interactionRunId: asString(row.interaction_run_id),
      interactionJobId: asString(row.interaction_job_id),
      finishedAt: asString(row.interaction_run_finished_at),
      headSha: asString(row.interaction_job_head_sha),
      resultJson: asString(row.interaction_run_result_json),
      snapshot: mapMergeRequestSnapshotRow(row)
    };
  }

  public async completeInteractionRun(interactionRunId: string, resultJson: string | null): Promise<void> {
    this.getDb()
      .prepare(
        "UPDATE interaction_runs SET status = 'completed', result_json = ?, error = NULL, finished_at = ? WHERE id = ?"
      )
      .run(resultJson, new Date().toISOString(), interactionRunId);
  }

  public async failInteractionRun(interactionRunId: string, error: string): Promise<void> {
    const database = this.getDb();
    database.prepare("DELETE FROM review_findings WHERE interaction_run_id = ?").run(interactionRunId);
    database
      .prepare("UPDATE interaction_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
      .run(error, new Date().toISOString(), interactionRunId);
  }

  public async upsertInteractionRunMetrics(input: UpsertInteractionRunMetricsInput): Promise<InteractionRunMetricsRecord> {
    const database = this.getDb();
    const existing = database.prepare("SELECT * FROM interaction_run_metrics WHERE interaction_run_id = ?").get(input.interactionRunId) as
      | Row
      | undefined;
    const id = existing ? asString(existing.id) : createId("metrics");
    const now = new Date().toISOString();

    database
      .prepare(`
        INSERT INTO interaction_run_metrics (
          id,
          interaction_run_id,
          trigger_kind,
          prompt_mode,
          prompt_chars,
          prompt_context_changed_files,
          prompt_context_prior_threads,
          prompt_context_notes,
          assistant_turns,
          assistant_calls,
          tool_executions,
          view_tool_calls,
          glob_tool_calls,
          input_tokens,
          output_tokens,
          cache_read_tokens,
          cache_write_tokens,
          reasoning_tokens,
          api_duration_ms,
          premium_requests,
          repeated_view_reads,
          repeated_view_paths_json,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(interaction_run_id) DO UPDATE SET
          trigger_kind = excluded.trigger_kind,
          prompt_mode = excluded.prompt_mode,
          prompt_chars = excluded.prompt_chars,
          prompt_context_changed_files = excluded.prompt_context_changed_files,
          prompt_context_prior_threads = excluded.prompt_context_prior_threads,
          prompt_context_notes = excluded.prompt_context_notes,
          assistant_turns = excluded.assistant_turns,
          assistant_calls = excluded.assistant_calls,
          tool_executions = excluded.tool_executions,
          view_tool_calls = excluded.view_tool_calls,
          glob_tool_calls = excluded.glob_tool_calls,
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          cache_read_tokens = excluded.cache_read_tokens,
          cache_write_tokens = excluded.cache_write_tokens,
          reasoning_tokens = excluded.reasoning_tokens,
          api_duration_ms = excluded.api_duration_ms,
          premium_requests = excluded.premium_requests,
          repeated_view_reads = excluded.repeated_view_reads,
          repeated_view_paths_json = excluded.repeated_view_paths_json,
          updated_at = excluded.updated_at
      `)
      .run(
        id,
        input.interactionRunId,
        input.triggerKind,
        input.promptMode,
        input.promptChars,
        input.promptContextChangedFiles,
        input.promptContextPriorThreads,
        input.promptContextNotes,
        input.assistantTurns,
        input.assistantCalls,
        input.toolExecutions,
        input.viewToolCalls,
        input.globToolCalls,
        input.inputTokens,
        input.outputTokens,
        input.cacheReadTokens,
        input.cacheWriteTokens,
        input.reasoningTokens,
        input.apiDurationMs,
        input.premiumRequests,
        input.repeatedViewReads,
        input.repeatedViewPathsJson,
        existing ? asString(existing.created_at) : now,
        now
      );

    const row = database.prepare("SELECT * FROM interaction_run_metrics WHERE interaction_run_id = ?").get(input.interactionRunId) as
      | Row
      | undefined;
    if (!row) {
      throw new Error(`Failed to persist metrics for interaction run ${input.interactionRunId}`);
    }

    return mapInteractionRunMetricsRow(row);
  }

  public async replaceReviewFindings(interactionRunId: string, findings: CreateReviewFindingInput[]): Promise<void> {
    const database = this.getDb();
    database.prepare("DELETE FROM review_findings WHERE interaction_run_id = ?").run(interactionRunId);

    const insert = database.prepare(`
      INSERT INTO review_findings (
        id,
        interaction_run_id,
        identity_key,
        severity,
        category,
        title,
        body,
        anchor_json,
        suggestion_json,
        status,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = new Date().toISOString();
    const latestFindingsByIdentity = new Map<string, CreateReviewFindingInput>();

    for (const finding of findings) {
      latestFindingsByIdentity.set(finding.identityKey, finding);
    }

    for (const finding of latestFindingsByIdentity.values()) {
      insert.run(
        createId("finding"),
        interactionRunId,
        finding.identityKey,
        finding.severity,
        finding.category,
        finding.title,
        finding.body,
        finding.anchorJson,
        finding.suggestionJson,
        finding.status,
        now
      );
    }
  }

  public async listPriorReviewFindings(
    tenantId: string,
    mergeRequestIid: number,
    currentInteractionJobId: string
  ): Promise<PriorReviewFindingRecord[]> {
    return this.listReviewFindings(tenantId, mergeRequestIid, currentInteractionJobId);
  }

  public async listLatestReviewFindings(tenantId: string, mergeRequestIid: number): Promise<PriorReviewFindingRecord[]> {
    return this.listReviewFindings(tenantId, mergeRequestIid);
  }

  private listReviewFindings(
    tenantId: string,
    mergeRequestIid: number,
    excludeInteractionJobId?: string
  ): PriorReviewFindingRecord[] {
    const excludeCurrentJobClause = excludeInteractionJobId ? "AND j.id != ?" : "";
    const bindings = excludeInteractionJobId
      ? [tenantId, mergeRequestIid, excludeInteractionJobId]
      : [tenantId, mergeRequestIid];
    const rows = this.getDb()
      .prepare(`
        WITH ranked_findings AS (
          SELECT
            rf.*,
            COALESCE(r.finished_at, r.started_at) AS reviewed_at,
            j.head_sha AS head_sha,
            ROW_NUMBER() OVER (
              PARTITION BY rf.identity_key
              ORDER BY
                COALESCE(r.finished_at, r.started_at) DESC,
                CASE rf.status
                  WHEN 'dismissed' THEN 0
                  WHEN 'resolved' THEN 1
                  ELSE 2
                END,
                rf.created_at DESC,
                rf.id DESC
            ) AS row_num
          FROM review_findings rf
          INNER JOIN interaction_runs r ON r.id = rf.interaction_run_id
          INNER JOIN interaction_jobs j ON j.id = r.interaction_job_id
          WHERE j.tenant_id = ?
            AND j.merge_request_iid = ?
            AND r.status = 'completed'
            ${excludeCurrentJobClause}
        )
        SELECT *
        FROM ranked_findings
        WHERE row_num = 1
        ORDER BY
          CASE status
            WHEN 'open' THEN 0
            WHEN 'dismissed' THEN 1
            ELSE 2
          END,
          reviewed_at DESC,
          created_at DESC
      `)
      .all(...bindings) as Row[];

    return rows.map(mapPriorReviewFindingRow);
  }

  public async updateReviewFindingStatus(
    tenantId: string,
    mergeRequestIid: number,
    identityKey: string,
    status: ReviewFindingStatus
  ): Promise<boolean> {
    const result = this.getDb()
      .prepare(`
        UPDATE review_findings
        SET status = ?
        WHERE id IN (
          SELECT rf.id
          FROM review_findings rf
          INNER JOIN interaction_runs r ON r.id = rf.interaction_run_id
          INNER JOIN interaction_jobs j ON j.id = r.interaction_job_id
          WHERE j.tenant_id = ?
            AND j.merge_request_iid = ?
            AND rf.identity_key = ?
            AND r.status = 'completed'
        )
      `)
      .run(status, tenantId, mergeRequestIid, identityKey);
    return result.changes > 0;
  }

  public async listDiscussionMappings(
    tenantId: string,
    mergeRequestIid: number
  ): Promise<DiscussionMappingRecord[]> {
    const rows = this.getDb()
      .prepare(
        "SELECT * FROM discussion_mappings WHERE tenant_id = ? AND merge_request_iid = ? ORDER BY updated_at DESC"
      )
      .all(tenantId, mergeRequestIid) as Row[];
    return rows.map(mapDiscussionMappingRow);
  }

  public async upsertDiscussionMapping(input: UpsertDiscussionMappingInput): Promise<DiscussionMappingRecord> {
    const database = this.getDb();
    const existing = database
      .prepare(
        "SELECT * FROM discussion_mappings WHERE tenant_id = ? AND merge_request_iid = ? AND gitlab_discussion_id = ?"
      )
      .get(input.tenantId, input.mergeRequestIid, input.gitlabDiscussionId) as Row | undefined;

    const id = existing ? String(existing.id) : input.id ?? createId("mapping");
    const now = new Date().toISOString();

    database
      .prepare(`
        INSERT INTO discussion_mappings (
          id,
          tenant_id,
          project_id,
          merge_request_iid,
          identity_key,
          finding_fingerprint,
          title,
          severity,
          category,
          body,
          gitlab_discussion_id,
          gitlab_note_id,
          anchor_json,
          position_json,
          bot_discussion,
          bot_note,
          note_author_id,
          note_author_username,
          status,
          last_interaction_run_id,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, merge_request_iid, gitlab_discussion_id) DO UPDATE SET
          identity_key = excluded.identity_key,
          finding_fingerprint = excluded.finding_fingerprint,
          title = excluded.title,
          severity = excluded.severity,
          category = excluded.category,
          body = excluded.body,
          gitlab_note_id = excluded.gitlab_note_id,
          anchor_json = excluded.anchor_json,
          position_json = excluded.position_json,
          bot_discussion = excluded.bot_discussion,
          bot_note = excluded.bot_note,
          note_author_id = excluded.note_author_id,
          note_author_username = excluded.note_author_username,
          status = excluded.status,
          last_interaction_run_id = excluded.last_interaction_run_id,
          updated_at = excluded.updated_at
      `)
      .run(
        id,
        input.tenantId,
        input.projectId,
        input.mergeRequestIid,
        input.identityKey,
        input.findingFingerprint,
        input.title,
        input.severity,
        input.category,
        input.body,
        input.gitlabDiscussionId,
        input.gitlabNoteId,
        input.anchorJson,
        input.positionJson,
        input.botDiscussion ? 1 : 0,
        input.botNote ? 1 : 0,
        input.noteAuthorId,
        input.noteAuthorUsername,
        input.status,
        input.lastInteractionRunId,
        existing ? String(existing.created_at) : now,
        now
      );

    const row = database
      .prepare(
        "SELECT * FROM discussion_mappings WHERE tenant_id = ? AND merge_request_iid = ? AND gitlab_discussion_id = ?"
      )
      .get(input.tenantId, input.mergeRequestIid, input.gitlabDiscussionId) as Row | undefined;

    if (!row) {
      throw new Error(`Failed to upsert discussion mapping for discussion ${input.gitlabDiscussionId}`);
    }

    return mapDiscussionMappingRow(row);
  }

  private listAllTenants(): TenantRecord[] {
    const rows = this.getDb().prepare("SELECT * FROM tenants ORDER BY base_url ASC, project_id ASC").all() as Row[];
    return rows.map(mapTenantRow);
  }

  private getDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("SQLite storage is not initialized");
    }

    return this.db;
  }
}

function mapModelProfileRow(row: Row): ModelProfileRecord {
  return {
    name: asString(row.name),
    providerBaseUrl: asNullableString(row.provider_base_url),
    providerType: asNullableProviderType(row.provider_type),
    wireApi: asNullableWireApi(row.wire_api),
    authToken: asNullableString(row.auth_token),
    reviewModel: asNullableString(row.review_model),
    textGenerationModel: asNullableString(row.text_generation_model),
    isDefault: asBoolean(row.is_default),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at)
  };
}

function resolveModelProfileUpsertInput(
  existing: ModelProfileRecord | null,
  input: UpsertModelProfileInput
): {
  name: string;
  providerBaseUrl: string | null;
  providerType: "openai" | "azure" | "anthropic" | null;
  wireApi: "completions" | "responses" | null;
  authToken: string | null;
  reviewModel: string | null;
  textGenerationModel: string | null;
  isDefault: boolean;
} {
  const providerBaseUrl = input.providerBaseUrl !== undefined
    ? input.providerBaseUrl
    : (existing?.providerBaseUrl ?? null);
  const providerType = providerBaseUrl === null && input.providerType === undefined
    ? null
    : (input.providerType !== undefined ? input.providerType : (existing?.providerType ?? null));
  const resolved = {
    name: input.name,
    providerBaseUrl,
    providerType,
    wireApi: input.wireApi !== undefined ? input.wireApi : (existing?.wireApi ?? null),
    authToken: input.authToken !== undefined ? input.authToken : (existing?.authToken ?? null),
    reviewModel: input.reviewModel !== undefined ? input.reviewModel : (existing?.reviewModel ?? null),
    textGenerationModel: input.textGenerationModel !== undefined
      ? input.textGenerationModel
      : (existing?.textGenerationModel ?? null),
    isDefault: input.isDefault !== undefined ? input.isDefault : (existing?.isDefault ?? false)
  };

  if (!resolved.providerBaseUrl && resolved.providerType) {
    throw new Error("provider type requires --base-url");
  }

  if (!resolved.providerBaseUrl && resolved.wireApi) {
    throw new Error("wire api requires --base-url");
  }

  if (resolved.providerBaseUrl && !resolved.reviewModel) {
    throw new Error("custom providers require --review-model");
  }

  return resolved;
}

function mapTenantRow(row: Row): TenantRecord {
  return {
    id: asString(row.id),
    key: asString(row.tenant_key),
    baseUrl: asString(row.base_url),
    projectId: asNumber(row.project_id),
    apiToken: asString(row.api_token),
    webhookSecret: asString(row.webhook_secret),
    botUserId: asNullableNumber(row.bot_user_id),
    botUsername: asNullableString(row.bot_username),
    modelProfileName: asNullableString(row.model_profile_name),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at)
  };
}

function mapInteractionJobRow(row: Row): InteractionJobRecord {
  return {
    id: asString(row.id),
    tenantId: asString(row.tenant_id),
    dedupeKey: asString(row.dedupe_key),
    projectId: asNumber(row.project_id),
    mergeRequestIid: asNumber(row.merge_request_iid),
    noteId: asNumber(row.note_id),
    headSha: asString(row.head_sha),
    status: asString(row.status) as InteractionJobRecord["status"],
    payloadJson: asString(row.payload_json),
    retryCount: asNumber(row.retry_count),
    lastError: asNullableString(row.last_error),
    enqueuedAt: asString(row.enqueued_at),
    startedAt: asNullableString(row.started_at),
    finishedAt: asNullableString(row.finished_at)
  };
}

function mapDiscussionMappingRow(row: Row): DiscussionMappingRecord {
  return {
    id: asString(row.id),
    tenantId: asString(row.tenant_id),
    projectId: asNumber(row.project_id),
    mergeRequestIid: asNumber(row.merge_request_iid),
    identityKey: asString(row.identity_key),
    findingFingerprint: asString(row.finding_fingerprint),
    title: asString(row.title),
    severity: asString(row.severity),
    category: asString(row.category),
    body: asString(row.body),
    gitlabDiscussionId: asString(row.gitlab_discussion_id),
    gitlabNoteId: asNumber(row.gitlab_note_id),
    anchorJson: asNullableString(row.anchor_json),
    positionJson: asNullableString(row.position_json),
    botDiscussion: asBoolean(row.bot_discussion),
    botNote: asBoolean(row.bot_note),
    noteAuthorId: asNullableNumber(row.note_author_id),
    noteAuthorUsername: asNullableString(row.note_author_username),
    status: asString(row.status) as DiscussionMappingRecord["status"],
    lastInteractionRunId: asNullableString(row.last_interaction_run_id),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at)
  };
}

function mapMergeRequestSnapshotRow(row: Row): MergeRequestSnapshotRecord {
  return {
    id: asString(row.id),
    interactionJobId: asString(row.interaction_job_id),
    tenantId: asString(row.tenant_id),
    mergeRequestIid: asNumber(row.merge_request_iid),
    headSha: asString(row.head_sha),
    mergeRequestJson: asString(row.merge_request_json),
    versionsJson: asString(row.versions_json),
    changesJson: asString(row.changes_json),
    notesJson: asString(row.notes_json),
    discussionsJson: asString(row.discussions_json),
    instructionsJson: asString(row.instructions_json),
    projectMemoryJson: asNullableString(row.project_memory_json),
    workspaceStrategy: asString(row.workspace_strategy),
    createdAt: asString(row.created_at)
  };
}

function mapInteractionRunMetricsRow(row: Row): InteractionRunMetricsRecord {
  return {
    id: asString(row.id),
    interactionRunId: asString(row.interaction_run_id),
    triggerKind: asNullableString(row.trigger_kind),
    promptMode: asNullableString(row.prompt_mode),
    promptChars: asNumber(row.prompt_chars),
    promptContextChangedFiles: asNumber(row.prompt_context_changed_files),
    promptContextPriorThreads: asNumber(row.prompt_context_prior_threads),
    promptContextNotes: asNumber(row.prompt_context_notes),
    assistantTurns: asNumber(row.assistant_turns),
    assistantCalls: asNumber(row.assistant_calls),
    toolExecutions: asNumber(row.tool_executions),
    viewToolCalls: asNumber(row.view_tool_calls),
    globToolCalls: asNumber(row.glob_tool_calls),
    inputTokens: asNumber(row.input_tokens),
    outputTokens: asNumber(row.output_tokens),
    cacheReadTokens: asNumber(row.cache_read_tokens),
    cacheWriteTokens: asNumber(row.cache_write_tokens),
    reasoningTokens: asNumber(row.reasoning_tokens),
    apiDurationMs: asNumber(row.api_duration_ms),
    premiumRequests: asNumber(row.premium_requests),
    repeatedViewReads: asNumber(row.repeated_view_reads),
    repeatedViewPathsJson: asString(row.repeated_view_paths_json),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at)
  };
}

function mapPriorReviewFindingRow(row: Row): PriorReviewFindingRecord {
  return {
    findingId: asString(row.id),
    identityKey: asString(row.identity_key),
    status: asString(row.status) as ReviewFindingStatus,
    title: asString(row.title),
    body: asString(row.body),
    severity: asString(row.severity),
    category: asString(row.category),
    anchor: parseAnchor(row.anchor_json),
    suggestion: parseSuggestion(row.suggestion_json),
    interactionRunId: asString(row.interaction_run_id),
    reviewedAt: asString(row.reviewed_at),
    headSha: asString(row.head_sha)
  };
}

function asString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`Expected string row value, received ${typeof value}`);
  }

  return value;
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return asString(value);
}

function asNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  throw new Error(`Expected numeric row value, received ${typeof value}`);
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  return asNumber(value);
}

function asNullableProviderType(value: unknown): "openai" | "azure" | "anthropic" | null {
  const parsed = asNullableString(value);
  if (parsed === null) {
    return null;
  }

  if (parsed === "openai" || parsed === "azure" || parsed === "anthropic") {
    return parsed;
  }

  throw new Error(`Expected provider type row value, received ${parsed}`);
}

function asNullableWireApi(value: unknown): "completions" | "responses" | null {
  const parsed = asNullableString(value);
  if (parsed === null) {
    return null;
  }

  if (parsed === "completions" || parsed === "responses") {
    return parsed;
  }

  throw new Error(`Expected wire api row value, received ${parsed}`);
}

function asBoolean(value: unknown): boolean {
  return asNumber(value) === 1;
}

function assertModelProfileExists(database: DatabaseSync, name: string): void {
  const row = database.prepare("SELECT name FROM model_profiles WHERE name = ?").get(name) as Row | undefined;
  if (!row) {
    throw new Error(`Unknown model profile ${name}`);
  }
}

function ensureColumn(database: DatabaseSync, tableName: string, columnName: string, definition: string): boolean {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all() as Row[];
  const hasColumn = columns.some((column) => asString(column.name) === columnName);
  if (!hasColumn) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    return true;
  }

  return false;
}

function hasTable(database: DatabaseSync, tableName: string): boolean {
  const row = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as Row | undefined;
  return Boolean(row);
}

function hasColumn(database: DatabaseSync, tableName: string, columnName: string): boolean {
  if (!hasTable(database, tableName)) {
    return false;
  }

  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all() as Row[];
  return columns.some((column) => asString(column.name) === columnName);
}

function migrateInteractionExecutionSchema(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec("BEGIN IMMEDIATE");

  try {
    migrateLegacyExecutionTable(database, {
      legacyTableName: "review_jobs",
      targetTableName: "interaction_jobs",
      selectColumns: `
        id,
        tenant_id,
        dedupe_key,
        project_id,
        merge_request_iid,
        note_id,
        head_sha,
        status,
        payload_json,
        retry_count,
        last_error,
        enqueued_at,
        started_at,
        finished_at
      `
    });
    migrateLegacyExecutionTable(database, {
      legacyTableName: "review_runs",
      targetTableName: "interaction_runs",
      selectColumns: `
        id,
        review_job_id AS interaction_job_id,
        tenant_id,
        provider,
        model,
        model_profile_name,
        provider_base_url,
        provider_type,
        text_generation_model,
        status,
        result_json,
        error,
        started_at,
        finished_at
      `
    });
    migrateLegacyExecutionTable(database, {
      legacyTableName: "review_run_metrics",
      targetTableName: "interaction_run_metrics",
      selectColumns: `
        id,
        review_run_id AS interaction_run_id,
        trigger_kind,
        prompt_mode,
        prompt_chars,
        prompt_context_changed_files,
        prompt_context_prior_threads,
        prompt_context_notes,
        assistant_turns,
        assistant_calls,
        tool_executions,
        view_tool_calls,
        glob_tool_calls,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        reasoning_tokens,
        api_duration_ms,
        premium_requests,
        repeated_view_reads,
        repeated_view_paths_json,
        created_at,
        updated_at
      `
    });

    renameLegacyColumn(database, "interaction_runs", "review_job_id", "interaction_job_id");
    renameLegacyColumn(database, "interaction_run_metrics", "review_run_id", "interaction_run_id");
    renameLegacyColumn(database, "merge_request_snapshots", "review_job_id", "interaction_job_id");
    renameLegacyColumn(database, "review_findings", "review_run_id", "interaction_run_id");
    renameLegacyColumn(database, "discussion_mappings", "last_review_run_id", "last_interaction_run_id");

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

function migrateLegacyExecutionTable(
  database: DatabaseSync,
  input: {
    legacyTableName: string;
    targetTableName: string;
    selectColumns: string;
  }
): void {
  if (!hasTable(database, input.legacyTableName)) {
    return;
  }

  if (!hasTable(database, input.targetTableName)) {
    database.exec(`ALTER TABLE ${input.legacyTableName} RENAME TO ${input.targetTableName}`);
    return;
  }

  database.exec(`
    INSERT OR IGNORE INTO ${input.targetTableName}
    SELECT ${input.selectColumns}
    FROM ${input.legacyTableName};
    DROP TABLE ${input.legacyTableName};
  `);
}

function renameLegacyColumn(database: DatabaseSync, tableName: string, legacyColumnName: string, targetColumnName: string): void {
  if (!hasColumn(database, tableName, legacyColumnName) || hasColumn(database, tableName, targetColumnName)) {
    return;
  }

  database.exec(`ALTER TABLE ${tableName} RENAME COLUMN ${legacyColumnName} TO ${targetColumnName}`);
}

function normalizeReviewFindingsTable(database: DatabaseSync): void {
  const columns = database.prepare("PRAGMA table_info(review_findings)").all() as Row[];
  if (columns.length === 0) {
    return;
  }

  const columnNames = new Set(columns.map((column) => asString(column.name)));
  const statusColumn = columns.find((column) => asString(column.name) === "status");
  const defaultValue = statusColumn ? asNullableString(statusColumn.dflt_value) : null;
  const expectedColumns = [
    "id",
    "interaction_run_id",
    "identity_key",
    "severity",
    "category",
    "title",
    "body",
    "anchor_json",
    "suggestion_json",
    "status",
    "created_at"
  ];
  const matchesTargetShape =
    columns.length === expectedColumns.length &&
    expectedColumns.every((columnName) => columnNames.has(columnName)) &&
    defaultValue === "'open'";

  if (matchesTargetShape) {
    database.prepare("UPDATE review_findings SET status = 'resolved' WHERE status IS NULL OR status = ''").run();
    return;
  }

  const anchorSelect = columnNames.has("anchor_json")
    ? "anchor_json"
    : columnNames.has("file_path") &&
        columnNames.has("start_line") &&
        columnNames.has("end_line") &&
        columnNames.has("side")
      ? `CASE
          WHEN file_path IS NOT NULL
            AND start_line IS NOT NULL
            AND end_line IS NOT NULL
            AND side IN ('new', 'old')
          THEN json_object(
            'path', file_path,
            'startLine', start_line,
            'endLine', end_line,
            'side', side
          )
          ELSE NULL
        END`
      : "NULL";
  const suggestionSelect = columnNames.has("suggestion_json") ? "suggestion_json" : "NULL";
  const statusSelect = columnNames.has("status")
    ? "CASE WHEN status IS NULL OR status = '' THEN 'resolved' ELSE status END"
    : "'resolved'";
  const createdAtSelect = columnNames.has("created_at") ? "created_at" : "CURRENT_TIMESTAMP";

  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    ALTER TABLE review_findings RENAME TO review_findings_legacy;
    CREATE TABLE review_findings (
      id TEXT PRIMARY KEY,
      interaction_run_id TEXT NOT NULL,
      identity_key TEXT NOT NULL,
      severity TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      anchor_json TEXT,
      suggestion_json TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      FOREIGN KEY (interaction_run_id) REFERENCES interaction_runs(id)
    );
    INSERT INTO review_findings (
      id,
      interaction_run_id,
      identity_key,
      severity,
      category,
      title,
      body,
      anchor_json,
      suggestion_json,
      status,
      created_at
    )
    SELECT
      id,
      ${columnNames.has("interaction_run_id") ? "interaction_run_id" : "review_run_id"},
      identity_key,
      severity,
      category,
      title,
      body,
      ${anchorSelect},
      ${suggestionSelect},
      ${statusSelect},
      ${createdAtSelect}
    FROM review_findings_legacy;
    DROP TABLE review_findings_legacy;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

function dedupeReviewFindingsTable(database: DatabaseSync): void {
  const duplicateRow = database
    .prepare(`
      SELECT interaction_run_id, identity_key, COUNT(*) AS duplicate_count
      FROM review_findings
      GROUP BY interaction_run_id, identity_key
      HAVING COUNT(*) > 1
      LIMIT 1
    `)
    .get() as Row | undefined;
  if (!duplicateRow) {
    return;
  }

  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    ALTER TABLE review_findings RENAME TO review_findings_dedup_source;
    CREATE TABLE review_findings (
      id TEXT PRIMARY KEY,
      interaction_run_id TEXT NOT NULL,
      identity_key TEXT NOT NULL,
      severity TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      anchor_json TEXT,
      suggestion_json TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      FOREIGN KEY (interaction_run_id) REFERENCES interaction_runs(id)
    );
    INSERT INTO review_findings (
      id,
      interaction_run_id,
      identity_key,
      severity,
      category,
      title,
      body,
      anchor_json,
      suggestion_json,
      status,
      created_at
    )
    WITH ranked_duplicates AS (
      SELECT
        *,
        ROW_NUMBER() OVER (
          PARTITION BY interaction_run_id, identity_key
          ORDER BY
            CASE status
              WHEN 'dismissed' THEN 0
              WHEN 'resolved' THEN 1
              ELSE 2
            END,
            created_at DESC,
            id DESC
        ) AS row_num
      FROM review_findings_dedup_source
    )
    SELECT
      id,
      interaction_run_id,
      identity_key,
      severity,
      category,
      title,
      body,
      anchor_json,
      suggestion_json,
      status,
      created_at
    FROM ranked_duplicates
    WHERE row_num = 1;
    DROP TABLE review_findings_dedup_source;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

function buildTenantDeletionSummary(database: DatabaseSync, tenant: TenantRecord): TenantDeletionSummary {
  const interactionJobIds = database
    .prepare("SELECT id FROM interaction_jobs WHERE tenant_id = ? ORDER BY id ASC")
    .all(tenant.id)
    .map((row) => asString((row as Row).id));
  const interactionRunIds = database
    .prepare("SELECT id FROM interaction_runs WHERE tenant_id = ? ORDER BY id ASC")
    .all(tenant.id)
    .map((row) => asString((row as Row).id));

  return {
    tenant,
    interactionJobCount: countRows(database, "interaction_jobs", tenant.id),
    mergeRequestSnapshotCount: countRows(database, "merge_request_snapshots", tenant.id),
    interactionRunCount: countRows(database, "interaction_runs", tenant.id),
    reviewFindingCount: countRowsForInteractionRuns(database, "review_findings", tenant.id),
    interactionRunMetricCount: countRowsForInteractionRuns(database, "interaction_run_metrics", tenant.id),
    discussionMappingCount: countRows(database, "discussion_mappings", tenant.id),
    interactionJobIds,
    interactionRunIds
  };
}

function getTenantDeletionSummaryFromDb(
  database: DatabaseSync,
  baseUrl: string,
  projectId: number
): TenantDeletionSummary | null {
  const tenantKey = createTenantKey(baseUrl, projectId);
  const row = database
    .prepare("SELECT * FROM tenants WHERE tenant_key = ?")
    .get(tenantKey) as Row | undefined;
  if (!row) {
    return null;
  }

  return buildTenantDeletionSummary(database, mapTenantRow(row));
}

function countRows(database: DatabaseSync, tableName: string, tenantId: string): number {
  const row = database
    .prepare(`SELECT COUNT(*) AS count FROM ${tableName} WHERE tenant_id = ?`)
    .get(tenantId) as Row;
  return asNumber(row.count);
}

function countRowsForInteractionRuns(database: DatabaseSync, tableName: string, tenantId: string): number {
  const row = database
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM ${tableName}
        WHERE interaction_run_id IN (
          SELECT id FROM interaction_runs WHERE tenant_id = ?
        )
      `
    )
    .get(tenantId) as Row;
  return asNumber(row.count);
}

function mapInteractionRunRow(row: Row): InteractionRunRecord {
  return {
    id: asString(row.id),
    interactionJobId: asString(row.interaction_job_id),
    tenantId: asString(row.tenant_id),
    provider: asString(row.provider),
    model: asNullableString(row.model),
    modelProfileName: asNullableString(row.model_profile_name),
    providerBaseUrl: asNullableString(row.provider_base_url),
    providerType: asNullableProviderType(row.provider_type),
    textGenerationModel: asNullableString(row.text_generation_model),
    status: asString(row.status) as InteractionRunRecord["status"],
    resultJson: asNullableString(row.result_json),
    error: asNullableString(row.error),
    startedAt: asString(row.started_at),
    finishedAt: asNullableString(row.finished_at)
  };
}

function parseAnchor(value: unknown): ReviewAnchor | null {
  const anchorJson = asNullableString(value);
  if (!anchorJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(anchorJson) as ReviewAnchor;
    if (
      typeof parsed?.path === "string" &&
      typeof parsed?.startLine === "number" &&
      typeof parsed?.endLine === "number" &&
      (parsed?.side === "new" || parsed?.side === "old")
    ) {
      return {
        path: parsed.path,
        ...(typeof parsed.oldPath === "string" ? { oldPath: parsed.oldPath } : {}),
        startLine: parsed.startLine,
        endLine: parsed.endLine,
        side: parsed.side
      };
    }
  } catch {
    return null;
  }

  return null;
}

function parseSuggestion(value: unknown): ReviewSuggestion | null {
  const suggestionJson = asNullableString(value);
  if (!suggestionJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(suggestionJson) as ReviewSuggestion;
    if (
      typeof parsed?.replacement === "string" &&
      typeof parsed?.startLine === "number" &&
      typeof parsed?.endLine === "number"
    ) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}
