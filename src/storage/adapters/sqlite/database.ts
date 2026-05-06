import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createId, createTenantKey } from "../../../utils/ids.js";
import type {
  DiscussionMappingRecord,
  DiscussionMappingFilters,
  DiscussionMappingOrderField,
  InteractionJobFilters,
  InteractionJobOrderField,
  InteractionRunFilters,
  InteractionRunMetricsFilters,
  InteractionRunMetricsOrderField,
  InteractionRunMetricsRecord,
  InteractionRunOrderField,
  MergeRequestSnapshotRecord,
  MergeRequestSnapshotFilters,
  MergeRequestSnapshotOrderField,
  ModelProfileRecord,
  ModelProfileFilters,
  ModelProfileOrderField,
  PriorReviewFindingRecord,
  ReviewFindingRecord,
  ReviewFindingFilters,
  ReviewFindingOrderField,
  ReviewFindingStatus,
  InteractionJobRecord,
  InteractionRunRecord,
  ReviewAnchor,
  StorageStores,
  StoreListInput,
  StoreValueFilter,
  TenantFilters,
  TenantOrderField,
  TenantRecord,
  ReviewSuggestion,
  StorageTenantInput,
  UpsertModelProfileInput,
  UpsertInteractionRunMetricsInput,
  UpsertDiscussionMappingInput
} from "../../contract/index.js";
import { applySqliteMigrations } from "./migrations.js";
import { Logger } from "pino";

interface SqliteStoreDatabaseOptions {
  databasePath: string;
  logger?: Logger;
}

type Row = Record<string, unknown>;
type SqlValue = string | number | null;

export class SqliteStoreDatabase {
  private readonly databasePath: string;
  private db: DatabaseSync | null = null;

  private readonly logger: Logger | undefined;

  public constructor(options: SqliteStoreDatabaseOptions) {
    this.databasePath = options.databasePath;
    this.logger = options.logger;
  }

  public async open(): Promise<void> {
    if (this.db) {
      return;
    }

    await mkdir(dirname(this.databasePath), { recursive: true });
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
    `);
  }

  public async prepare(): Promise<readonly string[]> {
    return applySqliteMigrations(this.getDb(), "sqlite", this.logger);
  }

  public async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  public createStores(): StorageStores {
    return {
      modelProfiles: {
        get: (id) => this.getModelProfileByName(id),
        getMany: (ids) => this.getModelProfilesByNames(ids),
        find: (filters) => this.findModelProfileRecord(filters),
        list: (input) => this.listModelProfileRecords(input),
        upsert: (entity) => this.upsertModelProfileRecord(entity),
        replace: (entity) => this.replaceModelProfileRecord(entity),
        update: ({ value }) => this.replaceModelProfileRecord(value),
        patch: (input) => this.patchModelProfileRecord(input.id, input.value),
        delete: (id) => this.deleteModelProfileRecord(id),
        deleteMany: (ids) => this.deleteModelProfileRecords(ids)
      },
      tenants: {
        get: (id) => this.getTenantById(id),
        getMany: (ids) => this.getTenantRecordsByIds(ids),
        find: (filters) => this.findTenantRecord(filters),
        list: (input) => this.listTenantRecords(input),
        upsert: (entity) => this.upsertTenantRecord(entity),
        replace: (entity) => this.replaceTenantRecord(entity),
        update: ({ value }) => this.replaceTenantRecord(value),
        patch: (input) => this.patchTenantRecord(input.id, input.value),
        delete: (id) => this.deleteTenantRecord(id),
        deleteMany: (ids) => this.deleteTenantRecords(ids)
      },
      interactionJobs: {
        get: (id) => this.getInteractionJobById(id),
        getMany: (ids) => this.getInteractionJobRecordsByIds(ids),
        find: (filters) => this.findInteractionJobRecord(filters),
        list: (input) => this.listInteractionJobRecords(input),
        upsert: (entity) => this.upsertInteractionJobRecord(entity),
        replace: (entity) => this.replaceInteractionJobRecord(entity),
        update: ({ value }) => this.replaceInteractionJobRecord(value),
        patch: (input) => this.patchInteractionJobRecord(input.id, input.value),
        delete: (id) => this.deleteInteractionJobRecord(id),
        deleteMany: (ids) => this.deleteInteractionJobRecords(ids)
      },
      mergeRequestSnapshots: {
        get: (id) => this.getMergeRequestSnapshotRecord(id),
        getMany: (ids) => this.getMergeRequestSnapshotRecordsByIds(ids),
        find: (filters) => this.findMergeRequestSnapshotRecord(filters),
        list: (input) => this.listMergeRequestSnapshotRecords(input),
        upsert: (entity) => this.upsertMergeRequestSnapshotRecord(entity),
        replace: (entity) => this.replaceMergeRequestSnapshotRecord(entity),
        update: ({ value }) => this.replaceMergeRequestSnapshotRecord(value),
        patch: (input) => this.patchMergeRequestSnapshotRecord(input.id, input.value),
        delete: (id) => this.deleteMergeRequestSnapshotRecord(id),
        deleteMany: (ids) => this.deleteMergeRequestSnapshotRecords(ids)
      },
      interactionRuns: {
        get: (id) => this.getInteractionRunRecord(id),
        getMany: (ids) => this.getInteractionRunRecordsByIds(ids),
        find: (filters) => this.findInteractionRunRecord(filters),
        list: (input) => this.listInteractionRunRecords(input),
        upsert: (entity) => this.upsertInteractionRunRecord(entity),
        replace: (entity) => this.replaceInteractionRunRecord(entity),
        update: ({ value }) => this.replaceInteractionRunRecord(value),
        patch: (input) => this.patchInteractionRunRecord(input.id, input.value),
        delete: (id) => this.deleteInteractionRunRecord(id),
        deleteMany: (ids) => this.deleteInteractionRunRecords(ids)
      },
      interactionRunMetrics: {
        get: (id) => this.getInteractionRunMetricsRecord(id),
        getMany: (ids) => this.getInteractionRunMetricsRecordsByIds(ids),
        find: (filters) => this.findInteractionRunMetricsRecord(filters),
        list: (input) => this.listInteractionRunMetricsRecords(input),
        upsert: (entity) => this.upsertInteractionRunMetricsRecord(entity),
        replace: (entity) => this.replaceInteractionRunMetricsRecord(entity),
        update: ({ value }) => this.replaceInteractionRunMetricsRecord(value),
        patch: (input) => this.patchInteractionRunMetricsRecord(input.id, input.value),
        delete: (id) => this.deleteInteractionRunMetricsRecord(id),
        deleteMany: (ids) => this.deleteInteractionRunMetricsRecords(ids)
      },
      reviewFindings: {
        get: (id) => this.getReviewFindingRecord(id),
        getMany: (ids) => this.getReviewFindingRecordsByIds(ids),
        find: (filters) => this.findReviewFindingRecord(filters),
        list: (input) => this.listReviewFindingRecords(input),
        upsert: (entity) => this.upsertReviewFindingRecord(entity),
        replace: (entity) => this.replaceReviewFindingRecord(entity),
        update: ({ value }) => this.replaceReviewFindingRecord(value),
        patch: (input) => this.patchReviewFindingRecord(input.id, input.value),
        delete: (id) => this.deleteReviewFindingRecord(id),
        deleteMany: (ids) => this.deleteReviewFindingRecords(ids)
      },
      discussionMappings: {
        get: (id) => this.getDiscussionMappingRecord(id),
        getMany: (ids) => this.getDiscussionMappingRecordsByIds(ids),
        find: (filters) => this.findDiscussionMappingRecord(filters),
        list: (input) => this.listDiscussionMappingRecords(input),
        upsert: (entity) => this.upsertDiscussionMappingRecord(entity),
        replace: (entity) => this.replaceDiscussionMappingRecord(entity),
        update: ({ value }) => this.replaceDiscussionMappingRecord(value),
        patch: (input) => this.patchDiscussionMappingRecord(input.id, input.value),
        delete: (id) => this.deleteDiscussionMappingRecord(id),
        deleteMany: (ids) => this.deleteDiscussionMappingRecords(ids)
      }
    };
  }

  private async upsertModelProfile(input: UpsertModelProfileInput): Promise<ModelProfileRecord> {
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

  private async getModelProfileByName(name: string): Promise<ModelProfileRecord | null> {
    const row = this.getDb().prepare("SELECT * FROM model_profiles WHERE name = ?").get(name) as Row | undefined;
    return row ? mapModelProfileRow(row) : null;
  }

  private async deleteModelProfile(name: string): Promise<ModelProfileRecord | null> {
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

  private async upsertTenant(tenant: StorageTenantInput): Promise<TenantRecord> {
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

  private async getTenantById(tenantId: string): Promise<TenantRecord | null> {
    const row = this.getDb().prepare("SELECT * FROM tenants WHERE id = ?").get(tenantId) as Row | undefined;
    return row ? mapTenantRow(row) : null;
  }

  private async getInteractionJobById(jobId: string): Promise<InteractionJobRecord | null> {
    const row = this.getDb().prepare("SELECT * FROM interaction_jobs WHERE id = ?").get(jobId) as Row | undefined;
    return row ? mapInteractionJobRow(row) : null;
  }

  private async upsertInteractionRunMetrics(input: UpsertInteractionRunMetricsInput): Promise<InteractionRunMetricsRecord> {
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

  private async upsertDiscussionMapping(input: UpsertDiscussionMappingInput): Promise<DiscussionMappingRecord> {
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

  private async getModelProfilesByNames(names: string[]): Promise<ModelProfileRecord[]> {
    return selectRowsByIds(this.getDb(), "model_profiles", "name", names, mapModelProfileRow);
  }

  private async findModelProfileRecord(filters: ModelProfileFilters): Promise<ModelProfileRecord | null> {
    return findRow(this.getDb(), "model_profiles", filters, modelProfileFilterColumns, mapModelProfileRow);
  }

  private async listModelProfileRecords(input: StoreListInput<ModelProfileFilters, ModelProfileOrderField>): Promise<ModelProfileRecord[]> {
    return listRows(this.getDb(), "model_profiles", input, modelProfileFilterColumns, modelProfileOrderColumns, mapModelProfileRow);
  }

  private async upsertModelProfileRecord(entity: ModelProfileRecord): Promise<ModelProfileRecord> {
    return this.upsertModelProfile({
      name: entity.name,
      providerBaseUrl: entity.providerBaseUrl,
      providerType: entity.providerType,
      wireApi: entity.wireApi,
      authToken: entity.authToken,
      reviewModel: entity.reviewModel,
      textGenerationModel: entity.textGenerationModel,
      isDefault: entity.isDefault
    });
  }

  private async replaceModelProfileRecord(entity: ModelProfileRecord): Promise<ModelProfileRecord> {
    if (!(await this.getModelProfileByName(entity.name))) {
      throw new Error(`Unknown model profile ${entity.name}`);
    }

    return this.upsertModelProfileRecord(entity);
  }

  private async patchModelProfileRecord(name: string, value: Partial<ModelProfileRecord>): Promise<ModelProfileRecord> {
    const existing = await this.getModelProfileByName(name);
    if (!existing) {
      throw new Error(`Unknown model profile ${name}`);
    }

    return this.upsertModelProfileRecord({ ...existing, ...value, name: existing.name });
  }

  private async deleteModelProfileRecord(name: string): Promise<void> {
    await this.deleteModelProfile(name);
  }

  private async deleteModelProfileRecords(names: string[]): Promise<void> {
    for (const name of names) {
      await this.deleteModelProfileRecord(name);
    }
  }

  private async getTenantRecordsByIds(ids: string[]): Promise<TenantRecord[]> {
    return selectRowsByIds(this.getDb(), "tenants", "id", ids, mapTenantRow);
  }

  private async findTenantRecord(filters: TenantFilters): Promise<TenantRecord | null> {
    return findRow(this.getDb(), "tenants", filters, tenantFilterColumns, mapTenantRow);
  }

  private async listTenantRecords(input: StoreListInput<TenantFilters, TenantOrderField>): Promise<TenantRecord[]> {
    return listRows(this.getDb(), "tenants", input, tenantFilterColumns, tenantOrderColumns, mapTenantRow);
  }

  private async upsertTenantRecord(entity: TenantRecord): Promise<TenantRecord> {
    return this.upsertTenant({
      baseUrl: entity.baseUrl,
      projectId: entity.projectId,
      apiToken: entity.apiToken,
      webhookSecret: entity.webhookSecret,
      botUserId: entity.botUserId ?? undefined,
      botUsername: entity.botUsername ?? "",
      modelProfileName: entity.modelProfileName
    });
  }

  private async replaceTenantRecord(entity: TenantRecord): Promise<TenantRecord> {
    if (!(await this.getTenantById(entity.id))) {
      throw new Error(`Unknown tenant ${entity.id}`);
    }

    return this.upsertTenantRecord(entity);
  }

  private async patchTenantRecord(id: string, value: Partial<TenantRecord>): Promise<TenantRecord> {
    const existing = await this.getTenantById(id);
    if (!existing) {
      throw new Error(`Unknown tenant ${id}`);
    }

    return this.upsertTenantRecord({ ...existing, ...value, id: existing.id, key: existing.key });
  }

  private async deleteTenantRecord(id: string): Promise<void> {
    this.getDb().prepare("DELETE FROM tenants WHERE id = ?").run(id);
  }

  private async deleteTenantRecords(ids: string[]): Promise<void> {
    deleteRowsByIds(this.getDb(), "tenants", "id", ids);
  }

  private async getInteractionJobRecordsByIds(ids: string[]): Promise<InteractionJobRecord[]> {
    return selectRowsByIds(this.getDb(), "interaction_jobs", "id", ids, mapInteractionJobRow);
  }

  private async findInteractionJobRecord(filters: InteractionJobFilters): Promise<InteractionJobRecord | null> {
    return findRow(this.getDb(), "interaction_jobs", filters, interactionJobFilterColumns, mapInteractionJobRow);
  }

  private async listInteractionJobRecords(
    input: StoreListInput<InteractionJobFilters, InteractionJobOrderField>
  ): Promise<InteractionJobRecord[]> {
    return listRows(this.getDb(), "interaction_jobs", input, interactionJobFilterColumns, interactionJobOrderColumns, mapInteractionJobRow);
  }

  private async upsertInteractionJobRecord(entity: InteractionJobRecord): Promise<InteractionJobRecord> {
    const database = this.getDb();
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
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(dedupe_key) DO UPDATE SET
          dedupe_key = interaction_jobs.dedupe_key
      `)
      .run(
        entity.id,
        entity.tenantId,
        entity.dedupeKey,
        entity.projectId,
        entity.mergeRequestIid,
        entity.noteId,
        entity.headSha,
        entity.status,
        entity.payloadJson,
        entity.retryCount,
        entity.lastError,
        entity.enqueuedAt,
        entity.startedAt,
        entity.finishedAt
      );

    const row = database.prepare("SELECT * FROM interaction_jobs WHERE dedupe_key = ?").get(entity.dedupeKey) as Row | undefined;
    if (!row) {
      throw new Error(`Failed to upsert interaction job ${entity.dedupeKey}`);
    }

    return mapInteractionJobRow(row);
  }

  private async replaceInteractionJobRecord(entity: InteractionJobRecord): Promise<InteractionJobRecord> {
    const database = this.getDb();
    const result = database
      .prepare(`
        UPDATE interaction_jobs
        SET tenant_id = ?, dedupe_key = ?, project_id = ?, merge_request_iid = ?, note_id = ?, head_sha = ?,
            status = ?, payload_json = ?, retry_count = ?, last_error = ?, enqueued_at = ?, started_at = ?, finished_at = ?
        WHERE id = ?
      `)
      .run(
        entity.tenantId,
        entity.dedupeKey,
        entity.projectId,
        entity.mergeRequestIid,
        entity.noteId,
        entity.headSha,
        entity.status,
        entity.payloadJson,
        entity.retryCount,
        entity.lastError,
        entity.enqueuedAt,
        entity.startedAt,
        entity.finishedAt,
        entity.id
      );
    if (result.changes === 0) {
      throw new Error(`Unknown interaction job ${entity.id}`);
    }

    return (await this.getInteractionJobById(entity.id))!;
  }

  private async patchInteractionJobRecord(id: string, value: Partial<InteractionJobRecord>): Promise<InteractionJobRecord> {
    const existing = await this.getInteractionJobById(id);
    if (!existing) {
      throw new Error(`Unknown interaction job ${id}`);
    }

    return this.replaceInteractionJobRecord({ ...existing, ...value, id: existing.id });
  }

  private async deleteInteractionJobRecord(id: string): Promise<void> {
    this.getDb().prepare("DELETE FROM interaction_jobs WHERE id = ?").run(id);
  }

  private async deleteInteractionJobRecords(ids: string[]): Promise<void> {
    deleteRowsByIds(this.getDb(), "interaction_jobs", "id", ids);
  }

  private async getMergeRequestSnapshotRecord(id: string): Promise<MergeRequestSnapshotRecord | null> {
    const row = this.getDb().prepare("SELECT * FROM merge_request_snapshots WHERE id = ?").get(id) as Row | undefined;
    return row ? mapMergeRequestSnapshotRow(row) : null;
  }

  private async getMergeRequestSnapshotRecordsByIds(ids: string[]): Promise<MergeRequestSnapshotRecord[]> {
    return selectRowsByIds(this.getDb(), "merge_request_snapshots", "id", ids, mapMergeRequestSnapshotRow);
  }

  private async findMergeRequestSnapshotRecord(
    filters: MergeRequestSnapshotFilters
  ): Promise<MergeRequestSnapshotRecord | null> {
    return findRow(this.getDb(), "merge_request_snapshots", filters, mergeRequestSnapshotFilterColumns, mapMergeRequestSnapshotRow);
  }

  private async listMergeRequestSnapshotRecords(
    input: StoreListInput<MergeRequestSnapshotFilters, MergeRequestSnapshotOrderField>
  ): Promise<MergeRequestSnapshotRecord[]> {
    return listRows(
      this.getDb(),
      "merge_request_snapshots",
      input,
      mergeRequestSnapshotFilterColumns,
      mergeRequestSnapshotOrderColumns,
      mapMergeRequestSnapshotRow
    );
  }

  private async upsertMergeRequestSnapshotRecord(entity: MergeRequestSnapshotRecord): Promise<MergeRequestSnapshotRecord> {
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
        ON CONFLICT(id) DO UPDATE SET
          interaction_job_id = excluded.interaction_job_id,
          tenant_id = excluded.tenant_id,
          merge_request_iid = excluded.merge_request_iid,
          head_sha = excluded.head_sha,
          merge_request_json = excluded.merge_request_json,
          versions_json = excluded.versions_json,
          changes_json = excluded.changes_json,
          notes_json = excluded.notes_json,
          discussions_json = excluded.discussions_json,
          instructions_json = excluded.instructions_json,
          project_memory_json = excluded.project_memory_json,
          workspace_strategy = excluded.workspace_strategy,
          created_at = excluded.created_at
      `)
      .run(
        entity.id,
        entity.interactionJobId,
        entity.tenantId,
        entity.mergeRequestIid,
        entity.headSha,
        entity.mergeRequestJson,
        entity.versionsJson,
        entity.changesJson,
        entity.notesJson,
        entity.discussionsJson,
        entity.instructionsJson,
        entity.projectMemoryJson,
        entity.workspaceStrategy,
        entity.createdAt
      );

    return (await this.getMergeRequestSnapshotRecord(entity.id))!;
  }

  private async replaceMergeRequestSnapshotRecord(entity: MergeRequestSnapshotRecord): Promise<MergeRequestSnapshotRecord> {
    if (!(await this.getMergeRequestSnapshotRecord(entity.id))) {
      throw new Error(`Unknown merge request snapshot ${entity.id}`);
    }

    return this.upsertMergeRequestSnapshotRecord(entity);
  }

  private async patchMergeRequestSnapshotRecord(
    id: string,
    value: Partial<MergeRequestSnapshotRecord>
  ): Promise<MergeRequestSnapshotRecord> {
    const existing = await this.getMergeRequestSnapshotRecord(id);
    if (!existing) {
      throw new Error(`Unknown merge request snapshot ${id}`);
    }

    return this.replaceMergeRequestSnapshotRecord({ ...existing, ...value, id: existing.id });
  }

  private async deleteMergeRequestSnapshotRecord(id: string): Promise<void> {
    this.getDb().prepare("DELETE FROM merge_request_snapshots WHERE id = ?").run(id);
  }

  private async deleteMergeRequestSnapshotRecords(ids: string[]): Promise<void> {
    deleteRowsByIds(this.getDb(), "merge_request_snapshots", "id", ids);
  }

  private async getInteractionRunRecord(id: string): Promise<InteractionRunRecord | null> {
    const row = this.getDb().prepare("SELECT * FROM interaction_runs WHERE id = ?").get(id) as Row | undefined;
    return row ? mapInteractionRunRow(row) : null;
  }

  private async getInteractionRunRecordsByIds(ids: string[]): Promise<InteractionRunRecord[]> {
    return selectRowsByIds(this.getDb(), "interaction_runs", "id", ids, mapInteractionRunRow);
  }

  private async findInteractionRunRecord(filters: InteractionRunFilters): Promise<InteractionRunRecord | null> {
    return findRow(this.getDb(), "interaction_runs", filters, interactionRunFilterColumns, mapInteractionRunRow);
  }

  private async listInteractionRunRecords(
    input: StoreListInput<InteractionRunFilters, InteractionRunOrderField>
  ): Promise<InteractionRunRecord[]> {
    return listRows(this.getDb(), "interaction_runs", input, interactionRunFilterColumns, interactionRunOrderColumns, mapInteractionRunRow);
  }

  private async upsertInteractionRunRecord(entity: InteractionRunRecord): Promise<InteractionRunRecord> {
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
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          interaction_job_id = excluded.interaction_job_id,
          tenant_id = excluded.tenant_id,
          provider = excluded.provider,
          model = excluded.model,
          model_profile_name = excluded.model_profile_name,
          provider_base_url = excluded.provider_base_url,
          provider_type = excluded.provider_type,
          text_generation_model = excluded.text_generation_model,
          status = excluded.status,
          result_json = excluded.result_json,
          error = excluded.error,
          started_at = excluded.started_at,
          finished_at = excluded.finished_at
      `)
      .run(
        entity.id,
        entity.interactionJobId,
        entity.tenantId,
        entity.provider,
        entity.model,
        entity.modelProfileName,
        entity.providerBaseUrl,
        entity.providerType,
        entity.textGenerationModel,
        entity.status,
        entity.resultJson,
        entity.error,
        entity.startedAt,
        entity.finishedAt
      );

    return (await this.getInteractionRunRecord(entity.id))!;
  }

  private async replaceInteractionRunRecord(entity: InteractionRunRecord): Promise<InteractionRunRecord> {
    if (!(await this.getInteractionRunRecord(entity.id))) {
      throw new Error(`Unknown interaction run ${entity.id}`);
    }

    return this.upsertInteractionRunRecord(entity);
  }

  private async patchInteractionRunRecord(id: string, value: Partial<InteractionRunRecord>): Promise<InteractionRunRecord> {
    const existing = await this.getInteractionRunRecord(id);
    if (!existing) {
      throw new Error(`Unknown interaction run ${id}`);
    }

    return this.replaceInteractionRunRecord({ ...existing, ...value, id: existing.id });
  }

  private async deleteInteractionRunRecord(id: string): Promise<void> {
    this.getDb().prepare("DELETE FROM interaction_runs WHERE id = ?").run(id);
  }

  private async deleteInteractionRunRecords(ids: string[]): Promise<void> {
    deleteRowsByIds(this.getDb(), "interaction_runs", "id", ids);
  }

  private async getInteractionRunMetricsRecord(id: string): Promise<InteractionRunMetricsRecord | null> {
    const row = this.getDb().prepare("SELECT * FROM interaction_run_metrics WHERE id = ?").get(id) as Row | undefined;
    return row ? mapInteractionRunMetricsRow(row) : null;
  }

  private async getInteractionRunMetricsRecordsByIds(ids: string[]): Promise<InteractionRunMetricsRecord[]> {
    return selectRowsByIds(this.getDb(), "interaction_run_metrics", "id", ids, mapInteractionRunMetricsRow);
  }

  private async findInteractionRunMetricsRecord(
    filters: InteractionRunMetricsFilters
  ): Promise<InteractionRunMetricsRecord | null> {
    return findRow(this.getDb(), "interaction_run_metrics", filters, interactionRunMetricsFilterColumns, mapInteractionRunMetricsRow);
  }

  private async listInteractionRunMetricsRecords(
    input: StoreListInput<InteractionRunMetricsFilters, InteractionRunMetricsOrderField>
  ): Promise<InteractionRunMetricsRecord[]> {
    return listRows(
      this.getDb(),
      "interaction_run_metrics",
      input,
      interactionRunMetricsFilterColumns,
      interactionRunMetricsOrderColumns,
      mapInteractionRunMetricsRow
    );
  }

  private async upsertInteractionRunMetricsRecord(entity: InteractionRunMetricsRecord): Promise<InteractionRunMetricsRecord> {
    return this.upsertInteractionRunMetrics({
      interactionRunId: entity.interactionRunId,
      triggerKind: entity.triggerKind,
      promptMode: entity.promptMode,
      promptChars: entity.promptChars,
      promptContextChangedFiles: entity.promptContextChangedFiles,
      promptContextPriorThreads: entity.promptContextPriorThreads,
      promptContextNotes: entity.promptContextNotes,
      assistantTurns: entity.assistantTurns,
      assistantCalls: entity.assistantCalls,
      toolExecutions: entity.toolExecutions,
      viewToolCalls: entity.viewToolCalls,
      globToolCalls: entity.globToolCalls,
      inputTokens: entity.inputTokens,
      outputTokens: entity.outputTokens,
      cacheReadTokens: entity.cacheReadTokens,
      cacheWriteTokens: entity.cacheWriteTokens,
      reasoningTokens: entity.reasoningTokens,
      apiDurationMs: entity.apiDurationMs,
      premiumRequests: entity.premiumRequests,
      repeatedViewReads: entity.repeatedViewReads,
      repeatedViewPathsJson: entity.repeatedViewPathsJson
    });
  }

  private async replaceInteractionRunMetricsRecord(entity: InteractionRunMetricsRecord): Promise<InteractionRunMetricsRecord> {
    if (!(await this.getInteractionRunMetricsRecord(entity.id))) {
      throw new Error(`Unknown interaction run metrics ${entity.id}`);
    }

    return this.upsertInteractionRunMetricsRecord(entity);
  }

  private async patchInteractionRunMetricsRecord(
    id: string,
    value: Partial<InteractionRunMetricsRecord>
  ): Promise<InteractionRunMetricsRecord> {
    const existing = await this.getInteractionRunMetricsRecord(id);
    if (!existing) {
      throw new Error(`Unknown interaction run metrics ${id}`);
    }

    return this.upsertInteractionRunMetricsRecord({ ...existing, ...value, id: existing.id });
  }

  private async deleteInteractionRunMetricsRecord(id: string): Promise<void> {
    this.getDb().prepare("DELETE FROM interaction_run_metrics WHERE id = ?").run(id);
  }

  private async deleteInteractionRunMetricsRecords(ids: string[]): Promise<void> {
    deleteRowsByIds(this.getDb(), "interaction_run_metrics", "id", ids);
  }

  private async getReviewFindingRecord(id: string): Promise<ReviewFindingRecord | null> {
    const row = this.getDb().prepare("SELECT * FROM review_findings WHERE id = ?").get(id) as Row | undefined;
    return row ? mapReviewFindingRow(row) : null;
  }

  private async getReviewFindingRecordsByIds(ids: string[]): Promise<ReviewFindingRecord[]> {
    return selectRowsByIds(this.getDb(), "review_findings", "id", ids, mapReviewFindingRow);
  }

  private async findReviewFindingRecord(filters: ReviewFindingFilters): Promise<ReviewFindingRecord | null> {
    return findRow(this.getDb(), "review_findings", filters, reviewFindingFilterColumns, mapReviewFindingRow);
  }

  private async listReviewFindingRecords(
    input: StoreListInput<ReviewFindingFilters, ReviewFindingOrderField>
  ): Promise<ReviewFindingRecord[]> {
    return listRows(this.getDb(), "review_findings", input, reviewFindingFilterColumns, reviewFindingOrderColumns, mapReviewFindingRow);
  }

  private async upsertReviewFindingRecord(entity: ReviewFindingRecord): Promise<ReviewFindingRecord> {
    this.getDb()
      .prepare(`
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
        ON CONFLICT(id) DO UPDATE SET
          interaction_run_id = excluded.interaction_run_id,
          identity_key = excluded.identity_key,
          severity = excluded.severity,
          category = excluded.category,
          title = excluded.title,
          body = excluded.body,
          anchor_json = excluded.anchor_json,
          suggestion_json = excluded.suggestion_json,
          status = excluded.status,
          created_at = excluded.created_at
      `)
      .run(
        entity.id,
        entity.interactionRunId,
        entity.identityKey,
        entity.severity,
        entity.category,
        entity.title,
        entity.body,
        entity.anchorJson,
        entity.suggestionJson,
        entity.status,
        entity.createdAt
      );

    return (await this.getReviewFindingRecord(entity.id))!;
  }

  private async replaceReviewFindingRecord(entity: ReviewFindingRecord): Promise<ReviewFindingRecord> {
    if (!(await this.getReviewFindingRecord(entity.id))) {
      throw new Error(`Unknown review finding ${entity.id}`);
    }

    return this.upsertReviewFindingRecord(entity);
  }

  private async patchReviewFindingRecord(id: string, value: Partial<ReviewFindingRecord>): Promise<ReviewFindingRecord> {
    const existing = await this.getReviewFindingRecord(id);
    if (!existing) {
      throw new Error(`Unknown review finding ${id}`);
    }

    return this.replaceReviewFindingRecord({ ...existing, ...value, id: existing.id });
  }

  private async deleteReviewFindingRecord(id: string): Promise<void> {
    this.getDb().prepare("DELETE FROM review_findings WHERE id = ?").run(id);
  }

  private async deleteReviewFindingRecords(ids: string[]): Promise<void> {
    deleteRowsByIds(this.getDb(), "review_findings", "id", ids);
  }

  private async getDiscussionMappingRecord(id: string): Promise<DiscussionMappingRecord | null> {
    const row = this.getDb().prepare("SELECT * FROM discussion_mappings WHERE id = ?").get(id) as Row | undefined;
    return row ? mapDiscussionMappingRow(row) : null;
  }

  private async getDiscussionMappingRecordsByIds(ids: string[]): Promise<DiscussionMappingRecord[]> {
    return selectRowsByIds(this.getDb(), "discussion_mappings", "id", ids, mapDiscussionMappingRow);
  }

  private async findDiscussionMappingRecord(filters: DiscussionMappingFilters): Promise<DiscussionMappingRecord | null> {
    return findRow(this.getDb(), "discussion_mappings", filters, discussionMappingFilterColumns, mapDiscussionMappingRow);
  }

  private async listDiscussionMappingRecords(
    input: StoreListInput<DiscussionMappingFilters, DiscussionMappingOrderField>
  ): Promise<DiscussionMappingRecord[]> {
    return listRows(
      this.getDb(),
      "discussion_mappings",
      input,
      discussionMappingFilterColumns,
      discussionMappingOrderColumns,
      mapDiscussionMappingRow
    );
  }

  private async upsertDiscussionMappingRecord(entity: DiscussionMappingRecord): Promise<DiscussionMappingRecord> {
    return this.upsertDiscussionMapping({
      id: entity.id,
      tenantId: entity.tenantId,
      projectId: entity.projectId,
      mergeRequestIid: entity.mergeRequestIid,
      identityKey: entity.identityKey,
      findingFingerprint: entity.findingFingerprint,
      title: entity.title,
      severity: entity.severity,
      category: entity.category,
      body: entity.body,
      gitlabDiscussionId: entity.gitlabDiscussionId,
      gitlabNoteId: entity.gitlabNoteId,
      anchorJson: entity.anchorJson,
      positionJson: entity.positionJson,
      botDiscussion: entity.botDiscussion,
      botNote: entity.botNote,
      noteAuthorId: entity.noteAuthorId,
      noteAuthorUsername: entity.noteAuthorUsername,
      status: entity.status,
      lastInteractionRunId: entity.lastInteractionRunId
    });
  }

  private async replaceDiscussionMappingRecord(entity: DiscussionMappingRecord): Promise<DiscussionMappingRecord> {
    if (!(await this.getDiscussionMappingRecord(entity.id))) {
      throw new Error(`Unknown discussion mapping ${entity.id}`);
    }

    return this.upsertDiscussionMappingRecord(entity);
  }

  private async patchDiscussionMappingRecord(
    id: string,
    value: Partial<DiscussionMappingRecord>
  ): Promise<DiscussionMappingRecord> {
    const existing = await this.getDiscussionMappingRecord(id);
    if (!existing) {
      throw new Error(`Unknown discussion mapping ${id}`);
    }

    return this.upsertDiscussionMappingRecord({ ...existing, ...value, id: existing.id });
  }

  private async deleteDiscussionMappingRecord(id: string): Promise<void> {
    this.getDb().prepare("DELETE FROM discussion_mappings WHERE id = ?").run(id);
  }

  private async deleteDiscussionMappingRecords(ids: string[]): Promise<void> {
    deleteRowsByIds(this.getDb(), "discussion_mappings", "id", ids);
  }

  private getDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("SQLite storage is not initialized");
    }

    return this.db;
  }
}

const modelProfileFilterColumns: Record<keyof ModelProfileFilters, string> = {
  name: "name",
  isDefault: "is_default",
  createdAt: "created_at",
  updatedAt: "updated_at"
};

const modelProfileOrderColumns: Record<ModelProfileOrderField, string> = {
  name: "name",
  isDefault: "is_default",
  createdAt: "created_at",
  updatedAt: "updated_at"
};

const tenantFilterColumns: Record<keyof TenantFilters, string> = {
  id: "id",
  key: "tenant_key",
  baseUrl: "base_url",
  projectId: "project_id",
  modelProfileName: "model_profile_name",
  createdAt: "created_at",
  updatedAt: "updated_at"
};

const tenantOrderColumns: Record<TenantOrderField, string> = {
  id: "id",
  key: "tenant_key",
  baseUrl: "base_url",
  projectId: "project_id",
  modelProfileName: "model_profile_name",
  createdAt: "created_at",
  updatedAt: "updated_at"
};

const interactionJobFilterColumns: Record<keyof InteractionJobFilters, string> = {
  id: "id",
  tenantId: "tenant_id",
  dedupeKey: "dedupe_key",
  projectId: "project_id",
  mergeRequestIid: "merge_request_iid",
  status: "status",
  enqueuedAt: "enqueued_at",
  startedAt: "started_at",
  finishedAt: "finished_at"
};

const interactionJobOrderColumns: Record<InteractionJobOrderField, string> = {
  tenantId: "tenant_id",
  dedupeKey: "dedupe_key",
  projectId: "project_id",
  mergeRequestIid: "merge_request_iid",
  status: "status",
  enqueuedAt: "enqueued_at",
  startedAt: "started_at",
  finishedAt: "finished_at",
  id: "id"
};

const mergeRequestSnapshotFilterColumns: Record<keyof MergeRequestSnapshotFilters, string> = {
  id: "id",
  interactionJobId: "interaction_job_id",
  tenantId: "tenant_id",
  mergeRequestIid: "merge_request_iid",
  createdAt: "created_at"
};

const mergeRequestSnapshotOrderColumns: Record<MergeRequestSnapshotOrderField, string> = {
  interactionJobId: "interaction_job_id",
  tenantId: "tenant_id",
  mergeRequestIid: "merge_request_iid",
  createdAt: "created_at",
  id: "id"
};

const interactionRunFilterColumns: Record<keyof InteractionRunFilters, string> = {
  id: "id",
  interactionJobId: "interaction_job_id",
  tenantId: "tenant_id",
  status: "status",
  resultJson: "result_json",
  startedAt: "started_at",
  finishedAt: "finished_at"
};

const interactionRunOrderColumns: Record<InteractionRunOrderField, string> = {
  interactionJobId: "interaction_job_id",
  tenantId: "tenant_id",
  status: "status",
  resultJson: "result_json",
  startedAt: "started_at",
  finishedAt: "finished_at",
  id: "id"
};

const interactionRunMetricsFilterColumns: Record<keyof InteractionRunMetricsFilters, string> = {
  id: "id",
  interactionRunId: "interaction_run_id",
  createdAt: "created_at",
  updatedAt: "updated_at"
};

const interactionRunMetricsOrderColumns: Record<InteractionRunMetricsOrderField, string> = {
  interactionRunId: "interaction_run_id",
  createdAt: "created_at",
  updatedAt: "updated_at",
  id: "id"
};

const reviewFindingFilterColumns: Record<keyof ReviewFindingFilters, string> = {
  id: "id",
  interactionRunId: "interaction_run_id",
  identityKey: "identity_key",
  status: "status",
  createdAt: "created_at"
};

const reviewFindingOrderColumns: Record<ReviewFindingOrderField, string> = {
  interactionRunId: "interaction_run_id",
  identityKey: "identity_key",
  status: "status",
  createdAt: "created_at",
  id: "id"
};

const discussionMappingFilterColumns: Record<keyof DiscussionMappingFilters, string> = {
  id: "id",
  tenantId: "tenant_id",
  mergeRequestIid: "merge_request_iid",
  gitlabDiscussionId: "gitlab_discussion_id",
  identityKey: "identity_key",
  status: "status",
  updatedAt: "updated_at",
  createdAt: "created_at"
};

const discussionMappingOrderColumns: Record<DiscussionMappingOrderField, string> = {
  tenantId: "tenant_id",
  mergeRequestIid: "merge_request_iid",
  gitlabDiscussionId: "gitlab_discussion_id",
  identityKey: "identity_key",
  status: "status",
  updatedAt: "updated_at",
  createdAt: "created_at",
  id: "id"
};

function selectRowsByIds<TEntity>(
  database: DatabaseSync,
  tableName: string,
  idColumn: string,
  ids: string[],
  mapRow: (row: Row) => TEntity
): TEntity[] {
  if (ids.length === 0) {
    return [];
  }

  const rows = database
    .prepare(`SELECT * FROM ${tableName} WHERE ${idColumn} IN (${buildSqlPlaceholders(ids.length)})`)
    .all(...ids) as Row[];
  const byId = new Map(rows.map((row) => [asString(row[idColumn]), mapRow(row)]));
  return ids.flatMap((id) => {
    const entity = byId.get(id);
    return entity ? [entity] : [];
  });
}

function deleteRowsByIds(database: DatabaseSync, tableName: string, idColumn: string, ids: string[]): void {
  if (ids.length === 0) {
    return;
  }

  database.prepare(`DELETE FROM ${tableName} WHERE ${idColumn} IN (${buildSqlPlaceholders(ids.length)})`).run(...ids);
}

function findRow<TEntity, TFilters extends object>(
  database: DatabaseSync,
  tableName: string,
  filters: TFilters,
  filterColumns: Record<keyof TFilters, string>,
  mapRow: (row: Row) => TEntity
): TEntity | null {
  const rows = listRows(
    database,
    tableName,
    { filters, page: 1, pageSize: 1 },
    filterColumns,
    {} as Record<never, string>,
    mapRow
  );
  return rows[0] ?? null;
}

function listRows<
  TEntity,
  TFilters extends object,
  TOrder extends string
>(
  database: DatabaseSync,
  tableName: string,
  input: StoreListInput<TFilters, TOrder>,
  filterColumns: Record<keyof TFilters, string>,
  orderColumns: Record<TOrder, string>,
  mapRow: (row: Row) => TEntity
): TEntity[] {
  const { clause, params } = buildWhereClause(input.filters, filterColumns);
  const orderClause = input.order && input.order.length > 0
    ? ` ORDER BY ${input.order.map((entry) => `${orderColumns[entry.field]} ${entry.direction.toUpperCase()}`).join(", ")}`
    : "";
  const limit = Math.max(1, input.pageSize);
  const offset = Math.max(0, (input.page - 1) * input.pageSize);
  const rows = database
    .prepare(`SELECT * FROM ${tableName}${clause}${orderClause} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as Row[];
  return rows.map(mapRow);
}

function buildWhereClause<TFilters extends object>(
  filters: TFilters | undefined,
  filterColumns: Record<keyof TFilters, string>
): { clause: string; params: SqlValue[] } {
  if (!filters) {
    return { clause: "", params: [] };
  }

  const clauses: string[] = [];
  const params: SqlValue[] = [];

  for (const [field, filter] of Object.entries(filters) as Array<[keyof TFilters, StoreValueFilter<unknown> | undefined]>) {
    if (!filter) {
      continue;
    }

    const column = filterColumns[field];
    if ("isNull" in filter && filter.isNull !== undefined) {
      clauses.push(`${column} IS ${filter.isNull ? "" : "NOT "}NULL`);
    }

    if ("eq" in filter && filter.eq !== undefined) {
      if (filter.eq === null) {
        clauses.push(`${column} IS NULL`);
      } else {
        clauses.push(`${column} = ?`);
        params.push(toSqlValue(filter.eq));
      }
    }

    if ("neq" in filter && filter.neq !== undefined) {
      if (filter.neq === null) {
        clauses.push(`${column} IS NOT NULL`);
      } else {
        clauses.push(`${column} != ?`);
        params.push(toSqlValue(filter.neq));
      }
    }

    if ("in" in filter && filter.in !== undefined) {
      if (filter.in.length === 0) {
        clauses.push("1 = 0");
      } else {
        clauses.push(`${column} IN (${buildSqlPlaceholders(filter.in.length)})`);
        params.push(...filter.in.map(toSqlValue));
      }
    }

    if ("notIn" in filter && filter.notIn !== undefined && filter.notIn.length > 0) {
      clauses.push(`${column} NOT IN (${buildSqlPlaceholders(filter.notIn.length)})`);
      params.push(...filter.notIn.map(toSqlValue));
    }
  }

  return {
    clause: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "",
    params
  };
}

function toSqlValue(value: unknown): SqlValue {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  if (typeof value === "number" || typeof value === "string" || value === null) {
    return value;
  }

  throw new Error(`Unsupported SQL filter value type: ${typeof value}`);
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

function mapReviewFindingRow(row: Row): ReviewFindingRecord {
  return {
    id: asString(row.id),
    interactionRunId: asString(row.interaction_run_id),
    identityKey: asString(row.identity_key),
    severity: asString(row.severity),
    category: asString(row.category),
    title: asString(row.title),
    body: asString(row.body),
    anchorJson: asNullableString(row.anchor_json),
    suggestionJson: asNullableString(row.suggestion_json),
    status: asString(row.status) as ReviewFindingStatus,
    createdAt: asString(row.created_at)
  };
}

function buildSqlPlaceholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
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
