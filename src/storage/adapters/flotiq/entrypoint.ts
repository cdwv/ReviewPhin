import { Flotiq } from "@flotiq/flotiq-api-sdk";
import type {
  DiscussionMapping,
  InteractionJob,
  InteractionRun,
  InteractionRunMetrics,
  MergeRequestSnapshot,
  ModelProfile,
  ReviewFinding,
  Tenant,
} from "@flotiq/flotiq-api-sdk";
import { z } from "zod";

import {
  type DiscussionMappingFilters,
  type DiscussionMappingOrderField,
  type DiscussionMappingRecord,
  type InteractionJobFilters,
  type InteractionJobOrderField,
  type InteractionJobRecord,
  type InteractionRunFilters,
  type InteractionRunMetricsFilters,
  type InteractionRunMetricsOrderField,
  type InteractionRunMetricsRecord,
  type InteractionRunOrderField,
  type InteractionRunRecord,
  type MergeRequestSnapshotFilters,
  type MergeRequestSnapshotOrderField,
  type MergeRequestSnapshotRecord,
  type ModelProfileFilters,
  type ModelProfileOrderField,
  type ModelProfileRecord,
  type ReviewFindingFilters,
  type ReviewFindingOrderField,
  type ReviewFindingRecord,
  type StorageStores,
  type TenantFilters,
  type TenantOrderField,
  type TenantRecord,
} from "../../contract/index.js";
import type {
  StorageProvider,
  StorageProviderFactoryContext,
} from "../../provider.js";
import ensureCTDsExist from "./migrations/v000.js";
import { createFlotiqEntityStore } from "./store.js";
import type { Logger } from "pino";

const flotiqProviderEnvSchema = z.object({
  FLOTIQ_API_KEY: z.string().min(1),
});

const tenantRelationFields = {
  modelProfileName: { contentType: "model_profile" },
} as const;

const interactionJobRelationFields = {
  tenantId: { contentType: "tenant" },
} as const;

const mergeRequestSnapshotRelationFields = {
  interactionJobId: { contentType: "interaction_job" },
  tenantId: { contentType: "tenant" },
} as const;

const interactionRunRelationFields = {
  interactionJobId: { contentType: "interaction_job" },
  tenantId: { contentType: "tenant" },
  modelProfileName: { contentType: "model_profile" },
} as const;

const interactionRunMetricsRelationFields = {
  interactionRunId: { contentType: "interaction_run" },
} as const;

const reviewFindingRelationFields = {
  interactionRunId: { contentType: "interaction_run" },
} as const;

const discussionMappingRelationFields = {
  tenantId: { contentType: "tenant" },
  lastInteractionRunId: { contentType: "interaction_run" },
} as const;

export function createStorageProvider(
  context: StorageProviderFactoryContext,
): StorageProvider {
  const logger = context.logger?.child({ storageProvider: "flotiq" });
  const parsedEnv = flotiqProviderEnvSchema.parse({
    FLOTIQ_API_KEY: context.env.FLOTIQ_API_KEY,
  });

  const flotiqClient = new Flotiq({
    apiKey: parsedEnv.FLOTIQ_API_KEY,
  });

  return {
    getProviderId() {
      return "flotiq";
    },
    getSupportedStorageContract() {
      return "storage-v000";
    },
    async open() {
      // Flotiq is accessed over HTTP, so there is no persistent connection.
    },
    async prepare() {
      const migrations = {
        v000: () =>
          ensureCTDsExist(
            parsedEnv.FLOTIQ_API_KEY,
            logger?.child({ component: "migrations" }),
          ),
      };

      const remoteMigrations = await flotiqClient.content.migrations
        ?.list()
        .catch((e: Error | { code: number }) => {
          if (
            ("code" in e && e.code === 404) ||
            ("message" in e &&
              typeof e.message === "string" &&
              e.message.includes("404"))
          )
            return { data: [] as { name: string }[] };
          logger?.error({ err: e }, "Failed to fetch Flotiq migrations.");
          throw e;
        });

      const appliedMigrationIds =
        remoteMigrations.data?.map(
          (migration: { name: string }) => migration.name,
        ) ?? ([] as string[]);
      const appliedMigrationIdSet = new Set(appliedMigrationIds);

      for (const [migrationId, migrationFn] of Object.entries(migrations)) {
        if (!appliedMigrationIdSet.has(migrationId)) {
          await migrationFn();
          await flotiqClient.content.migrations.create({
            name: migrationId,
          });
          appliedMigrationIdSet.add(migrationId);
          logger?.info({ migrationId }, "Applied Flotiq migration.");
        }
      }

      return {
        providerId: this.getProviderId(),
        storageContractRevision: this.getSupportedStorageContract(),
        appliedMigrationIds: [...appliedMigrationIdSet],
      };
    },
    createStores() {
      return createStores(flotiqClient, logger?.child({ component: "stores" }));
    },
    async close() {
      // Flotiq is accessed over HTTP, so there is no persistent connection.
    },
  };
}

function createStores(flotiqClient: Flotiq, logger?: Logger): StorageStores {
  const createStoreLogger = (store: string): Logger | undefined =>
    logger?.child({ store });

  return {
    modelProfiles: createFlotiqEntityStore<
      ModelProfileRecord,
      ModelProfileFilters,
      ModelProfileOrderField,
      ModelProfile,
      ModelProfile.FilterableFields
    >({
      logger: createStoreLogger("modelProfiles"),
      api: flotiqClient.content.model_profile,
      toRecord: mapModelProfileRecord,
      toRemote: mapModelProfileEntity,
      emptyStringNullFields: [
        "providerBaseUrl",
        "providerType",
        "wireApi",
        "authToken",
        "reviewModel",
        "textGenerationModel",
      ],
    }),
    tenants: createFlotiqEntityStore<
      TenantRecord,
      TenantFilters,
      TenantOrderField,
      Tenant,
      Tenant.FilterableFields
    >({
      logger: createStoreLogger("tenants"),
      api: flotiqClient.content.tenant,
      toRecord: mapTenantRecord,
      toRemote: mapTenantEntity,
      relationFields: tenantRelationFields,
    }),
    interactionJobs: createFlotiqEntityStore<
      InteractionJobRecord,
      InteractionJobFilters,
      InteractionJobOrderField,
      InteractionJob,
      InteractionJob.FilterableFields
    >({
      logger: createStoreLogger("interactionJobs"),
      api: flotiqClient.content.interaction_job,
      toRecord: mapInteractionJobRecord,
      toRemote: mapIdentityEntity,
      emptyStringNullFields: ["lastError", "startedAt", "finishedAt"],
      relationFields: interactionJobRelationFields,
    }),
    mergeRequestSnapshots: createFlotiqEntityStore<
      MergeRequestSnapshotRecord,
      MergeRequestSnapshotFilters,
      MergeRequestSnapshotOrderField,
      MergeRequestSnapshot,
      MergeRequestSnapshot.FilterableFields
    >({
      logger: createStoreLogger("mergeRequestSnapshots"),
      api: flotiqClient.content.merge_request_snapshot,
      toRecord: mapMergeRequestSnapshotRecord,
      toRemote: mapIdentityEntity,
      emptyStringNullFields: ["projectMemoryJson"],
      relationFields: mergeRequestSnapshotRelationFields,
    }),
    interactionRuns: createFlotiqEntityStore<
      InteractionRunRecord,
      InteractionRunFilters,
      InteractionRunOrderField,
      InteractionRun,
      InteractionRun.FilterableFields
    >({
      logger: createStoreLogger("interactionRuns"),
      api: flotiqClient.content.interaction_run,
      toRecord: mapInteractionRunRecord,
      toRemote: mapIdentityEntity,
      emptyStringNullFields: [
        "model",
        "providerBaseUrl",
        "providerType",
        "textGenerationModel",
        "resultJson",
        "error",
        "finishedAt",
      ],
      relationFields: interactionRunRelationFields,
    }),
    interactionRunMetrics: createFlotiqEntityStore<
      InteractionRunMetricsRecord,
      InteractionRunMetricsFilters,
      InteractionRunMetricsOrderField,
      InteractionRunMetrics,
      InteractionRunMetrics.FilterableFields
    >({
      logger: createStoreLogger("interactionRunMetrics"),
      api: flotiqClient.content.interaction_run_metrics,
      toRecord: mapInteractionRunMetricsRecord,
      toRemote: mapIdentityEntity,
      emptyStringNullFields: ["triggerKind", "promptMode"],
      relationFields: interactionRunMetricsRelationFields,
    }),
    reviewFindings: createFlotiqEntityStore<
      ReviewFindingRecord,
      ReviewFindingFilters,
      ReviewFindingOrderField,
      ReviewFinding,
      ReviewFinding.FilterableFields
    >({
      logger: createStoreLogger("reviewFindings"),
      api: flotiqClient.content.review_finding,
      toRecord: mapReviewFindingRecord,
      toRemote: mapReviewFindingEntity,
      emptyStringNullFields: ["anchorJson", "suggestionJson"],
      relationFields: reviewFindingRelationFields,
    }),
    discussionMappings: createFlotiqEntityStore<
      DiscussionMappingRecord,
      DiscussionMappingFilters,
      DiscussionMappingOrderField,
      DiscussionMapping,
      DiscussionMapping.FilterableFields
    >({
      logger: createStoreLogger("discussionMappings"),
      api: flotiqClient.content.discussion_mapping,
      toRecord: mapDiscussionMappingRecord,
      toRemote: mapDiscussionMappingEntity,
      emptyStringNullFields: [
        "anchorJson",
        "positionJson",
        "noteAuthorUsername",
      ],
      relationFields: discussionMappingRelationFields,
    }),
  };
}

function mapModelProfileRecord(entity: ModelProfile): ModelProfileRecord {
  return {
    name: readString(entity, "name") ?? readString(entity, "id") ?? "",
    providerBaseUrl: readNullableString(entity, "providerBaseUrl"),
    providerType: readNullableProviderType(entity, "providerType"),
    wireApi: readNullableWireApi(entity, "wireApi"),
    authToken: readNullableString(entity, "authToken"),
    reviewModel: readNullableString(entity, "reviewModel"),
    textGenerationModel: readNullableString(entity, "textGenerationModel"),
    isDefault: readBoolean(entity, "isDefault") ?? false,
    createdAt: readInternalTimestamp(entity, "createdAt"),
    updatedAt: readInternalTimestamp(entity, "updatedAt"),
  };
}

function mapModelProfileEntity(
  entity: ModelProfileRecord,
): Record<string, unknown> {
  return {
    id: entity.name,
    name: entity.name,
    providerBaseUrl: entity.providerBaseUrl,
    providerType: entity.providerType,
    wireApi: entity.wireApi,
    authToken: entity.authToken,
    reviewModel: entity.reviewModel,
    textGenerationModel: entity.textGenerationModel,
    isDefault: entity.isDefault,
  };
}

function mapTenantRecord(entity: Tenant): TenantRecord {
  return {
    id: readRequiredString(entity, "id"),
    key: readRequiredString(entity, "key"),
    baseUrl: readRequiredString(entity, "baseUrl"),
    projectId: readRequiredNumber(entity, "projectId"),
    apiToken: readRequiredString(entity, "apiToken"),
    webhookSecret: readRequiredString(entity, "webhookSecret"),
    botUserId: readRequiredNumber(entity, "botUserId"),
    botUsername: readRequiredString(entity, "botUsername"),
    modelProfileName: readNullableRelationId(entity, "modelProfileName"),
    createdAt: readInternalTimestamp(entity, "createdAt"),
    updatedAt: readInternalTimestamp(entity, "updatedAt"),
  };
}

function mapTenantEntity(entity: TenantRecord): Record<string, unknown> {
  return {
    ...mapIdentityEntity(entity),
    modelProfileName: entity.modelProfileName,
  };
}

function mapInteractionJobRecord(entity: InteractionJob): InteractionJobRecord {
  return {
    id: readRequiredString(entity, "id"),
    tenantId: readRequiredRelationId(entity, "tenantId"),
    dedupeKey: readRequiredString(entity, "dedupeKey"),
    projectId: readRequiredNumber(entity, "projectId"),
    mergeRequestIid: readRequiredNumber(entity, "mergeRequestIid"),
    noteId: readRequiredNumber(entity, "noteId"),
    headSha: readRequiredString(entity, "headSha"),
    status: readRequiredString(
      entity,
      "status",
    ) as InteractionJobRecord["status"],
    payloadJson: readRequiredString(entity, "payloadJson"),
    retryCount: readRequiredNumber(entity, "retryCount"),
    lastError: readNullableString(entity, "lastError"),
    enqueuedAt: readRequiredString(entity, "enqueuedAt"),
    startedAt: readNullableString(entity, "startedAt"),
    finishedAt: readNullableString(entity, "finishedAt"),
  };
}

function mapMergeRequestSnapshotRecord(
  entity: MergeRequestSnapshot,
): MergeRequestSnapshotRecord {
  return {
    id: readRequiredString(entity, "id"),
    interactionJobId: readRequiredRelationId(entity, "interactionJobId"),
    tenantId: readRequiredRelationId(entity, "tenantId"),
    mergeRequestIid: readRequiredNumber(entity, "mergeRequestIid"),
    headSha: readRequiredString(entity, "headSha"),
    mergeRequestJson: readRequiredString(entity, "mergeRequestJson"),
    versionsJson: readRequiredString(entity, "versionsJson"),
    changesJson: readRequiredString(entity, "changesJson"),
    notesJson: readRequiredString(entity, "notesJson"),
    discussionsJson: readRequiredString(entity, "discussionsJson"),
    instructionsJson: readRequiredString(entity, "instructionsJson"),
    projectMemoryJson: readNullableString(entity, "projectMemoryJson"),
    workspaceStrategy: readRequiredString(entity, "workspaceStrategy"),
    createdAt: readInternalTimestamp(entity, "createdAt"),
  };
}

function mapInteractionRunRecord(entity: InteractionRun): InteractionRunRecord {
  return {
    id: readRequiredString(entity, "id"),
    interactionJobId: readRequiredRelationId(entity, "interactionJobId"),
    tenantId: readRequiredRelationId(entity, "tenantId"),
    provider: readRequiredString(entity, "provider"),
    model: readNullableString(entity, "model"),
    modelProfileName: readNullableRelationId(entity, "modelProfileName"),
    providerBaseUrl: readNullableString(entity, "providerBaseUrl"),
    providerType: readNullableProviderType(entity, "providerType"),
    textGenerationModel: readNullableString(entity, "textGenerationModel"),
    status: readRequiredString(
      entity,
      "status",
    ) as InteractionRunRecord["status"],
    resultJson: readNullableString(entity, "resultJson"),
    error: readNullableString(entity, "error"),
    startedAt: readRequiredString(entity, "startedAt"),
    finishedAt: readNullableString(entity, "finishedAt"),
  };
}

function mapInteractionRunMetricsRecord(
  entity: InteractionRunMetrics,
): InteractionRunMetricsRecord {
  return {
    id: readRequiredString(entity, "id"),
    interactionRunId: readRequiredRelationId(entity, "interactionRunId"),
    triggerKind: readNullableString(entity, "triggerKind"),
    promptMode: readNullableString(entity, "promptMode"),
    promptChars: readRequiredNumber(entity, "promptChars"),
    promptContextChangedFiles: readRequiredNumber(
      entity,
      "promptContextChangedFiles",
    ),
    promptContextPriorThreads: readRequiredNumber(
      entity,
      "promptContextPriorThreads",
    ),
    promptContextNotes: readRequiredNumber(entity, "promptContextNotes"),
    assistantTurns: readRequiredNumber(entity, "assistantTurns"),
    assistantCalls: readRequiredNumber(entity, "assistantCalls"),
    toolExecutions: readRequiredNumber(entity, "toolExecutions"),
    viewToolCalls: readRequiredNumber(entity, "viewToolCalls"),
    globToolCalls: readRequiredNumber(entity, "globToolCalls"),
    inputTokens: readRequiredNumber(entity, "inputTokens"),
    outputTokens: readRequiredNumber(entity, "outputTokens"),
    cacheReadTokens: readRequiredNumber(entity, "cacheReadTokens"),
    cacheWriteTokens: readRequiredNumber(entity, "cacheWriteTokens"),
    reasoningTokens: readRequiredNumber(entity, "reasoningTokens"),
    apiDurationMs: readRequiredNumber(entity, "apiDurationMs"),
    premiumRequests: readRequiredNumber(entity, "premiumRequests"),
    repeatedViewReads: readRequiredNumber(entity, "repeatedViewReads"),
    repeatedViewPathsJson: readRequiredString(entity, "repeatedViewPathsJson"),
    createdAt: readInternalTimestamp(entity, "createdAt"),
    updatedAt: readInternalTimestamp(entity, "updatedAt"),
  };
}

function mapReviewFindingRecord(entity: ReviewFinding): ReviewFindingRecord {
  return {
    id: readRequiredString(entity, "id"),
    interactionRunId: readRequiredRelationId(entity, "interactionRunId"),
    identityKey: readRequiredString(entity, "identityKey"),
    severity: readRequiredString(entity, "severity"),
    category: readRequiredString(entity, "category"),
    title: readRequiredString(entity, "title"),
    body: readRequiredString(entity, "body"),
    anchorJson: readNullableString(entity, "anchorJson"),
    suggestionJson: readNullableString(entity, "suggestionJson"),
    status: (readNullableString(entity, "status") ??
      "open") as ReviewFindingRecord["status"],
    createdAt: readInternalTimestamp(entity, "createdAt"),
  };
}

function mapReviewFindingEntity(
  entity: ReviewFindingRecord,
): Record<string, unknown> {
  return {
    ...mapIdentityEntity(entity),
    status: entity.status,
  };
}

function mapDiscussionMappingRecord(
  entity: DiscussionMapping,
): DiscussionMappingRecord {
  return {
    id: readRequiredString(entity, "id"),
    tenantId: readRequiredRelationId(entity, "tenantId"),
    projectId: readRequiredNumber(entity, "projectId"),
    mergeRequestIid: readRequiredNumber(entity, "mergeRequestIid"),
    identityKey: readRequiredString(entity, "identityKey"),
    findingFingerprint: readRequiredString(entity, "findingFingerprint"),
    title: readRequiredString(entity, "title"),
    severity: readRequiredString(entity, "severity"),
    category: readRequiredString(entity, "category"),
    body: readRequiredString(entity, "body"),
    gitlabDiscussionId: readRequiredString(entity, "gitlabDiscussionId"),
    gitlabNoteId: readRequiredNumber(entity, "gitlabNoteId"),
    anchorJson: readNullableString(entity, "anchorJson"),
    positionJson: readNullableString(entity, "positionJson"),
    botDiscussion: readBoolean(entity, "botDiscussion") ?? false,
    botNote: readBoolean(entity, "botNote") ?? false,
    noteAuthorId: readNullableNumber(entity, "noteAuthorId"),
    noteAuthorUsername: readNullableString(entity, "noteAuthorUsername"),
    status: (readNullableString(entity, "status") ??
      "open") as DiscussionMappingRecord["status"],
    lastInteractionRunId: readNullableRelationId(
      entity,
      "lastInteractionRunId",
    ),
    createdAt: readInternalTimestamp(entity, "createdAt"),
    updatedAt: readInternalTimestamp(entity, "updatedAt"),
  };
}

function mapDiscussionMappingEntity(
  entity: DiscussionMappingRecord,
): Record<string, unknown> {
  return {
    ...mapIdentityEntity(entity),
    status: entity.status,
    lastInteractionRunId: entity.lastInteractionRunId,
  };
}

function mapIdentityEntity<TEntity extends object>(
  entity: TEntity,
): Record<string, unknown> {
  return { ...(entity as Record<string, unknown>) };
}

function readString(entity: object, key: string): string | null {
  const value = asUnknownRecord(entity)[key];
  return typeof value === "string" ? value : null;
}

function readRequiredString(entity: object, key: string): string {
  const value = readString(entity, key);
  if (value === null) {
    throw new Error(`Flotiq object is missing required string field ${key}`);
  }

  return value;
}

function readRequiredRelationId(entity: object, key: string): string {
  const value = readNullableRelationId(entity, key);
  if (value === null) {
    throw new Error(`Flotiq object is missing required relation field ${key}`);
  }

  return value;
}

function readNullableRelationId(entity: object, key: string): string | null {
  return extractRelationId(asUnknownRecord(entity)[key], key);
}

function readNullableString(entity: object, key: string): string | null {
  const value = asUnknownRecord(entity)[key];
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw new TypeError(`Flotiq object field ${key} must be a string or null`);
  }

  return value;
}

function readNumber(entity: object, key: string): number | null {
  const value = asUnknownRecord(entity)[key];
  return typeof value === "number" ? value : null;
}

function readRequiredNumber(entity: object, key: string): number {
  const value = readNumber(entity, key);
  if (value === null) {
    throw new Error(`Flotiq object is missing required number field ${key}`);
  }

  return value;
}

function readNullableNumber(entity: object, key: string): number | null {
  const value = asUnknownRecord(entity)[key];
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "number") {
    throw new TypeError(`Flotiq object field ${key} must be a number or null`);
  }

  return value;
}

function readBoolean(entity: object, key: string): boolean | null {
  const value = asUnknownRecord(entity)[key];
  return typeof value === "boolean" ? value : null;
}

function readInternalTimestamp(
  entity: object,
  key: "createdAt" | "updatedAt",
): string {
  const internal = asUnknownRecord(entity).internal;
  if (!internal || typeof internal !== "object") {
    throw new Error("Flotiq object is missing internal metadata");
  }

  const value = (internal as Record<string, unknown>)[key];
  if (typeof value !== "string") {
    throw new TypeError(`Flotiq object internal.${key} must be a string`);
  }

  return value;
}

function readNullableProviderType(
  entity: object,
  key: string,
): ModelProfileRecord["providerType"] {
  const value = readNullableString(entity, key);
  if (value === null) {
    return null;
  }

  if (value === "openai" || value === "azure" || value === "anthropic") {
    return value;
  }

  throw new Error(`Unsupported provider type ${value}`);
}

function readNullableWireApi(
  entity: object,
  key: string,
): ModelProfileRecord["wireApi"] {
  const value = readNullableString(entity, key);
  if (value === null) {
    return null;
  }

  if (value === "completions" || value === "responses") {
    return value;
  }

  throw new Error(`Unsupported wire api ${value}`);
}

function extractRelationId(value: unknown, key: string): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const relationEntries = value as unknown[];
    const firstRelation = relationEntries.find(
      (entry) => entry !== null && entry !== undefined,
    );

    return firstRelation === undefined
      ? null
      : extractRelationId(firstRelation, key);
  }

  if (typeof value === "object") {
    const relation = value as Record<string, unknown>;
    if (typeof relation.dataUrl === "string") {
      return parseRelationDataUrl(relation.dataUrl, key);
    }

    if (typeof relation.id === "string") {
      return relation.id;
    }
  }

  throw new TypeError(`Flotiq object field ${key} must be a relation or null`);
}

function parseRelationDataUrl(dataUrl: string, key: string): string {
  const lastSlashIndex = dataUrl.lastIndexOf("/");
  if (lastSlashIndex < 0 || lastSlashIndex === dataUrl.length - 1) {
    throw new TypeError(
      `Flotiq relation field ${key} has invalid dataUrl ${dataUrl}`,
    );
  }

  return dataUrl.slice(lastSlashIndex + 1);
}

function asUnknownRecord(entity: object): Record<string, unknown> {
  return entity as Record<string, unknown>;
}
