import { Flotiq } from "@flotiq/flotiq-api-sdk";
import type {
  CodeReviewSnapshotHydrated,
  CodeReviewSnapshotHydratedTwice,
  DiscussionMapping,
  DiscussionMappingHydrated,
  DiscussionMappingHydratedTwice,
  InteractionJob,
  InteractionJobHydrated,
  InteractionJobHydratedTwice,
  InteractionRun,
  InteractionRunHydrated,
  InteractionRunHydratedTwice,
  InteractionRunMetrics,
  InteractionRunMetricsHydrated,
  InteractionRunMetricsHydratedTwice,
  CodeReviewSnapshot,
  ModelProfile,
  PlatformConnection,
  PlatformConnectionHydrated,
  PlatformConnectionHydratedTwice,
  ProjectMemory,
  ProjectMemoryHydrated,
  ProjectMemoryHydratedTwice,
  ReviewFinding,
  ReviewFindingHydrated,
  ReviewFindingHydratedTwice,
  Tenant,
  TenantHydrated,
  TenantHydratedTwice,
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
  type CodeReviewSnapshotFilters,
  type CodeReviewSnapshotOrderField,
  type CodeReviewSnapshotRecord,
  type ModelProfileFilters,
  type ModelProfileOrderField,
  type ModelProfileRecord,
  type PlatformConnectionFilters,
  type PlatformConnectionOrderField,
  type PlatformConnectionRecord,
  type ProjectMemoryFilters,
  type ProjectMemoryOrderField,
  type ProjectMemoryRecord,
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
import ensureV002CtdsExist from "./migrations/v002.js";
import ensureV003CtdsExist from "./migrations/v003.js";
import ensureV004CtdsExist from "./migrations/v004.js";
import { createFlotiqEntityStore } from "./store.js";
import type { Logger } from "pino";

const flotiqProviderEnvSchema = z.object({
  FLOTIQ_API_KEY: z.string().min(1),
});

const tenantRelationFields = {
  platformConnectionId: { contentType: "platform_connection" },
  modelProfileName: { contentType: "model_profile" },
} as const;

const projectMemoryRelationFields = {
  tenantId: { contentType: "tenant" },
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
      return "storage-v004";
    },
    async open() {
      // Flotiq is accessed over HTTP, so there is no persistent connection.
    },
    async prepare() {
      const migrations = {
        v002: () =>
          ensureV002CtdsExist(
            parsedEnv.FLOTIQ_API_KEY,
            logger?.child({ component: "migrations" }),
          ),
        v003: () =>
          ensureV003CtdsExist(
            parsedEnv.FLOTIQ_API_KEY,
            flotiqClient,
            logger?.child({ component: "migrations" }),
          ),
        v004: () =>
          ensureV004CtdsExist(
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
      ctdName: "model_profile",
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
    platformConnections: createFlotiqEntityStore<
      PlatformConnectionRecord,
      PlatformConnectionFilters,
      PlatformConnectionOrderField,
      PlatformConnection,
      PlatformConnection.FilterableFields,
      PlatformConnectionHydrated,
      PlatformConnectionHydratedTwice
    >({
      logger: createStoreLogger("platformConnections"),
      api: flotiqClient.content.platform_connection,
      ctdName: "platform_connection",
      toRecord: mapPlatformConnectionRecord,
      toRemote: mapIdentityEntity,
    }),
    tenants: createFlotiqEntityStore<
      TenantRecord,
      TenantFilters,
      TenantOrderField,
      Tenant,
      Tenant.FilterableFields,
      TenantHydrated,
      TenantHydratedTwice
    >({
      logger: createStoreLogger("tenants"),
      api: flotiqClient.content.tenant,
      ctdName: "tenant",
      toRecord: mapTenantRecord,
      toRemote: mapTenantEntity,
      relationFields: tenantRelationFields,
    }),
    projectMemories: createFlotiqEntityStore<
      ProjectMemoryRecord,
      ProjectMemoryFilters,
      ProjectMemoryOrderField,
      ProjectMemory,
      ProjectMemory.FilterableFields,
      ProjectMemoryHydrated,
      ProjectMemoryHydratedTwice
    >({
      logger: createStoreLogger("projectMemories"),
      api: flotiqClient.content.project_memory,
      ctdName: "project_memory",
      toRecord: mapProjectMemoryRecord,
      toRemote: mapIdentityEntity,
      relationFields: projectMemoryRelationFields,
    }),
    interactionJobs: createFlotiqEntityStore<
      InteractionJobRecord,
      InteractionJobFilters,
      InteractionJobOrderField,
      InteractionJob,
      InteractionJob.FilterableFields,
      InteractionJobHydrated,
      InteractionJobHydratedTwice
    >({
      logger: createStoreLogger("interactionJobs"),
      api: flotiqClient.content.interaction_job,
      ctdName: "interaction_job",
      toRecord: mapInteractionJobRecord,
      toRemote: mapIdentityEntity,
      emptyStringNullFields: ["lastError", "startedAt", "finishedAt"],
      relationFields: interactionJobRelationFields,
    }),
    codeReviewSnapshots: createFlotiqEntityStore<
      CodeReviewSnapshotRecord,
      CodeReviewSnapshotFilters,
      CodeReviewSnapshotOrderField,
      CodeReviewSnapshot,
      CodeReviewSnapshot.FilterableFields,
      CodeReviewSnapshotHydrated,
      CodeReviewSnapshotHydratedTwice
    >({
      logger: createStoreLogger("codeReviewSnapshots"),
      api: flotiqClient.content.code_review_snapshot,
      ctdName: "code_review_snapshot",
      toRecord: mapCodeReviewSnapshotRecord,
      toRemote: mapIdentityEntity,
      emptyStringNullFields: ["projectMemoryJson"],
      relationFields: mergeRequestSnapshotRelationFields,
    }),
    interactionRuns: createFlotiqEntityStore<
      InteractionRunRecord,
      InteractionRunFilters,
      InteractionRunOrderField,
      InteractionRun,
      InteractionRun.FilterableFields,
      InteractionRunHydrated,
      InteractionRunHydratedTwice
    >({
      logger: createStoreLogger("interactionRuns"),
      api: flotiqClient.content.interaction_run,
      ctdName: "interaction_run",
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
      InteractionRunMetrics.FilterableFields,
      InteractionRunMetricsHydrated,
      InteractionRunMetricsHydratedTwice
    >({
      logger: createStoreLogger("interactionRunMetrics"),
      api: flotiqClient.content.interaction_run_metrics,
      ctdName: "interaction_run_metrics",
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
      ReviewFinding.FilterableFields,
      ReviewFindingHydrated,
      ReviewFindingHydratedTwice
    >({
      logger: createStoreLogger("reviewFindings"),
      api: flotiqClient.content.review_finding,
      ctdName: "review_finding",
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
      DiscussionMapping.FilterableFields,
      DiscussionMappingHydrated,
      DiscussionMappingHydratedTwice
    >({
      logger: createStoreLogger("discussionMappings"),
      api: flotiqClient.content.discussion_mapping,
      ctdName: "discussion_mapping",
      toRecord: mapDiscussionMappingRecord,
      toRemote: mapDiscussionMappingEntity,
      emptyStringNullFields: [
        "anchorJson",
        "positionJson",
        "commentAuthorUsername",
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
    platform: readRequiredString(entity, "platform"),
    platformConnectionId: readRequiredRelationId(
      entity,
      "platformConnectionId",
    ),
    platformConfigJson: readRequiredString(entity, "platformConfigJson"),
    modelProfileName: readNullableRelationId(entity, "modelProfileName"),
    createdAt: readInternalTimestamp(entity, "createdAt"),
    updatedAt: readInternalTimestamp(entity, "updatedAt"),
  };
}

function mapPlatformConnectionRecord(
  entity: PlatformConnection,
): PlatformConnectionRecord {
  return {
    id: readRequiredString(entity, "id"),
    name: readRequiredString(entity, "name"),
    platform: readRequiredString(entity, "platform"),
    status: readRequiredString(
      entity,
      "status",
    ) as PlatformConnectionRecord["status"],
    platformConnectionConfigJson: readRequiredString(
      entity,
      "platformConnectionConfigJson",
    ),
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

function mapProjectMemoryRecord(entity: ProjectMemory): ProjectMemoryRecord {
  return {
    id: readRequiredString(entity, "id"),
    tenantId: readRequiredRelationId(entity, "tenantId"),
    entriesJson: readRequiredString(entity, "entriesJson"),
    createdAt: readInternalTimestamp(entity, "createdAt"),
    updatedAt: readInternalTimestamp(entity, "updatedAt"),
  };
}

function mapInteractionJobRecord(entity: InteractionJob): InteractionJobRecord {
  return {
    id: readRequiredString(entity, "id"),
    tenantId: readRequiredRelationId(entity, "tenantId"),
    dedupeKey: readRequiredString(entity, "dedupeKey"),
    codeReviewId: readRequiredNumberWithFallback(
      entity,
      "codeReviewId",
      "codeReviewId",
    ),
    commentId: readNullableNumber(entity, "commentId"),
    triggerJson:
      readNullableString(entity, "triggerJson") ??
      JSON.stringify({
        kind: "comment",
        commentId: readRequiredNumber(entity, "commentId"),
      }),
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

function mapCodeReviewSnapshotRecord(
  entity: CodeReviewSnapshot,
): CodeReviewSnapshotRecord {
  return {
    id: readRequiredString(entity, "id"),
    interactionJobId: readRequiredRelationId(entity, "interactionJobId"),
    tenantId: readRequiredRelationId(entity, "tenantId"),
    codeReviewId: readRequiredNumberWithFallback(
      entity,
      "codeReviewId",
      "mergeRequestIid",
    ),
    headSha: readRequiredString(entity, "headSha"),
    codeReviewJson: readRequiredString(entity, "codeReviewJson"),
    versionsJson: readRequiredString(entity, "versionsJson"),
    changesJson: readRequiredString(entity, "changesJson"),
    commentsJson: readRequiredString(entity, "commentsJson"),
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
    promptContextPriorDiscussions: readRequiredNumber(
      entity,
      "promptContextPriorDiscussions",
    ),
    promptContextComments: readRequiredNumber(entity, "promptContextComments"),
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
    codeReviewId: readRequiredNumberWithFallback(
      entity,
      "codeReviewId",
      "mergeRequestIid",
    ),
    identityKey: readRequiredString(entity, "identityKey"),
    findingFingerprint: readRequiredString(entity, "findingFingerprint"),
    title: readRequiredString(entity, "title"),
    severity: readRequiredString(entity, "severity"),
    category: readRequiredString(entity, "category"),
    body: readRequiredString(entity, "body"),
    platformDiscussionId: readRequiredStringWithFallback(
      entity,
      "platformDiscussionId",
      "gitlabDiscussionId",
    ),
    platformCommentId: readRequiredNumberWithFallback(
      entity,
      "platformCommentId",
      "gitlabNoteId",
    ),
    anchorJson: readNullableString(entity, "anchorJson"),
    positionJson: readNullableString(entity, "positionJson"),
    botDiscussion: readBoolean(entity, "botDiscussion") ?? false,
    botComment: readBoolean(entity, "botComment") ?? false,
    commentAuthorId: readNullableNumber(entity, "commentAuthorId"),
    commentAuthorUsername: readNullableString(entity, "commentAuthorUsername"),
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

function readRequiredStringWithFallback(
  entity: object,
  key: string,
  legacyKey: string,
): string {
  const value = readString(entity, key) ?? readString(entity, legacyKey);
  if (value === null) {
    throw new Error(
      `Flotiq object is missing required string field ${key} or legacy field ${legacyKey}`,
    );
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

function readRequiredNumberWithFallback(
  entity: object,
  key: string,
  legacyKey: string,
): number {
  const value = readNumber(entity, key) ?? readNumber(entity, legacyKey);
  if (value === null) {
    throw new Error(
      `Flotiq object is missing required number field ${key} or legacy field ${legacyKey}`,
    );
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
