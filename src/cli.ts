import { access, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import {
  loadConfig,
  modelProfileNameSchema,
  tenantConfigSchema,
} from "./config.js";
import { loadLocalEnvFile } from "./env.js";
import { maskSecret } from "./review/model-profiles.js";
import {
  readHarnessRunMetrics,
  type PremiumRequestsByModelMetric,
} from "./harness/run-metrics.js";
import {
  initializeStorageRuntime,
  type InitializedStorageRuntime,
} from "./storage/runtime.js";
import { listAll, type StorageHelpers } from "./storage/storage-helpers.js";
import { createInteractionJobDedupeKey } from "./utils/ids.js";
import { createLogger } from "./logger.js";
import type {
  DiscussionMappingRecord,
  EntityStore,
  InteractionJobRecord,
  InteractionRunRecord,
  CodeReviewSnapshotRecord,
  PreviousCompletedInteractionRecord,
  PlatformConnectionRecord,
  PriorReviewFindingRecord,
  StorageStores,
  StoreListOrder,
  TenantDeletionSummary,
  TenantRecord,
} from "./storage/contract/index.js";
import {
  getPlatforms,
  initializePlatformRegistry,
} from "./platforms/platform-registry.js";
import { getGitLabTenantConfig } from "./platforms/gitlab/tenant-config.js";

interface ParsedCliArgs {
  readonly positionals: string[];
  readonly options: Record<string, string | boolean>;
}

interface RunMetricsRow {
  readonly run: string;
  readonly premiumRequests: number;
  readonly premiumRequestsByModel: PremiumRequestsByModelMetric[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly toolCalls: number;
  readonly durationMs: number;
}

interface SummaryMetricsRow {
  readonly stat: string;
  readonly premiumRequests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly toolCalls: number;
  readonly durationMs: number;
}

interface ModelPremiumRequestsStatsRow {
  readonly model: string;
  readonly runs: number;
  readonly premiumRequests: number;
  readonly min: number;
  readonly max: number;
  readonly avg: number;
  readonly p25: number;
  readonly p50: number;
  readonly p75: number;
  readonly p90: number;
}

interface TenantArtifactSummary {
  readonly workspacePaths: string[];
  readonly runLogPaths: string[];
  readonly existingWorkspaceCount: number;
  readonly existingRunLogCount: number;
}

const tenantAddSchema = tenantConfigSchema.extend({
  platform: z.string().default("gitlab"),
  connection: z.string().min(1),
  databasePath: z.string().min(1).optional(),
});

const tenantLookupBaseSchema = tenantConfigSchema.extend({
  databasePath: z.string().min(1).optional(),
  tenantId: z.string().min(1).optional(),
  tenantKey: z.string().min(1).optional(),
});

const tenantLookupSchema =
  tenantLookupBaseSchema.superRefine(refineTenantLookup);

const tenantProfileSchema = tenantLookupBaseSchema
  .extend({
    modelProfileName: modelProfileNameSchema,
  })
  .superRefine(refineTenantLookup);

const modelProfileSchema = z.object({
  name: modelProfileNameSchema,
  providerBaseUrl: z.string().url().optional(),
  providerType: z.enum(["openai", "azure", "anthropic"]).optional(),
  wireApi: z.enum(["completions", "responses"]).optional(),
  authToken: z.string().min(1).optional(),
  reviewModel: z.string().min(1).optional(),
  textGenerationModel: z.string().min(1).optional(),
  isDefault: z.boolean().optional(),
  databasePath: z.string().min(1).optional(),
});

const clearableModelProfileFields = [
  "base-url",
  "provider-type",
  "wire-api",
  "auth-token",
  "review-model",
  "text-generation-model",
] as const;

const modelProfileLookupSchema = z.object({
  name: modelProfileNameSchema,
  databasePath: z.string().min(1).optional(),
});

const storageMigrationSchema = z.object({
  fromProviderModule: z.string().min(1),
  toProviderModule: z.string().min(1),
  fromSqliteDatabasePath: z.string().min(1).optional(),
  toSqliteDatabasePath: z.string().min(1).optional(),
});

const mergeRequestDescribeSchema = z
  .object({
    tenantId: z.string().min(1).optional(),
    tenantKey: z.string().min(1).optional(),
    codeReviewId: z.coerce.number().int().nonnegative(),
    currentInteractionJobId: z.string().min(1).optional(),
    triggerNoteId: z.coerce.number().int().positive().optional(),
    triggerNoteAction: z.enum(["create", "update"]).optional(),
    triggerNoteUpdatedAt: z.string().datetime({ offset: true }).optional(),
    triggerNoteBody: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    const hasTenantId = value.tenantId !== undefined;
    const hasTenantKey = value.tenantKey !== undefined;
    const hasTriggerDetails =
      value.triggerNoteId !== undefined ||
      value.triggerNoteAction !== undefined ||
      value.triggerNoteUpdatedAt !== undefined ||
      value.triggerNoteBody !== undefined;

    if (!hasTenantId && !hasTenantKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide --tenant-id or --key.",
        path: ["tenantId"],
      });
    }

    if (hasTenantId && hasTenantKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide either --tenant-id or --key, not both.",
        path: ["tenantId"],
      });
    }

    if (hasTriggerDetails && value.triggerNoteId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Provide --trigger-comment-id when supplying trigger dedupe inputs.",
        path: ["triggerNoteId"],
      });
    }

    if (
      value.triggerNoteAction === "update" &&
      value.triggerNoteUpdatedAt === undefined &&
      value.triggerNoteBody === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Provide --trigger-comment-updated-at or --trigger-comment-body for update trigger dedupe checks.",
        path: ["triggerNoteUpdatedAt"],
      });
    }
  });

interface CodeReviewTriggerDedupeInput {
  readonly commentId: number;
  readonly commentAction: "create" | "update";
  readonly commentUpdatedAt?: string | undefined;
  readonly commentBody?: string | undefined;
}

interface StorageEndpointOptions {
  readonly providerModule: string;
  readonly sqliteDatabasePath?: string | undefined;
}

interface StorageMigrationStep {
  readonly label: keyof StorageStores;
  run(
    source: StorageStores,
    target: StorageStores,
    context: StorageMigrationContext,
  ): Promise<number>;
}

interface StorageMigrationContext {
  readonly tenantIds: Map<string, string>;
  readonly interactionJobIds: Map<string, string>;
  readonly interactionRunIds: Map<string, string>;
}

const STORAGE_MIGRATION_PAGE_SIZE = 20;

const storageMigrationSteps: readonly StorageMigrationStep[] = [
  {
    label: "modelProfiles",
    run: (source, target) =>
      migrateEntityStore(
        source.modelProfiles,
        target.modelProfiles,
        "modelProfiles",
        {
          order: ascendingOrder("name"),
        },
      ),
  },
  {
    label: "platformConnections",
    run: (source, target) =>
      migrateEntityStore(
        source.platformConnections,
        target.platformConnections,
        "platformConnections",
        { order: ascendingOrder("id") },
      ),
  },
  {
    label: "tenants",
    run: (source, target, context) =>
      migrateTenants(source.tenants, target.tenants, context, {
        order: ascendingOrder("id"),
      }),
  },
  {
    label: "projectMemories",
    run: (source, target, context) =>
      migrateEntityStore(
        source.projectMemories,
        target.projectMemories,
        "projectMemories",
        {
          order: ascendingOrder("id"),
          mapEntity: (entity) => ({
            ...entity,
            tenantId: resolveMappedId(
              context.tenantIds,
              entity.tenantId,
              "tenant",
            ),
          }),
        },
      ),
  },
  {
    label: "interactionJobs",
    run: (source, target, context) =>
      migrateInteractionJobs(
        source.interactionJobs,
        target.interactionJobs,
        context,
        {
          order: ascendingOrder("id"),
        },
      ),
  },
  {
    label: "codeReviewSnapshots",
    run: (source, target, context) =>
      migrateEntityStore(
        source.codeReviewSnapshots,
        target.codeReviewSnapshots,
        "codeReviewSnapshots",
        {
          order: ascendingOrder("id"),
          mapEntity: (entity) => ({
            ...entity,
            interactionJobId: resolveMappedId(
              context.interactionJobIds,
              entity.interactionJobId,
              "interaction job",
            ),
            tenantId: resolveMappedId(
              context.tenantIds,
              entity.tenantId,
              "tenant",
            ),
          }),
        },
      ),
  },
  {
    label: "interactionRuns",
    run: (source, target, context) =>
      migrateInteractionRuns(
        source.interactionRuns,
        target.interactionRuns,
        context,
        {
          order: ascendingOrder("id"),
        },
      ),
  },
  {
    label: "interactionRunMetrics",
    run: (source, target, context) =>
      migrateEntityStore(
        source.interactionRunMetrics,
        target.interactionRunMetrics,
        "interactionRunMetrics",
        {
          order: ascendingOrder("id"),
          mapEntity: (entity) => ({
            ...entity,
            interactionRunId: resolveMappedId(
              context.interactionRunIds,
              entity.interactionRunId,
              "interaction run",
            ),
          }),
        },
      ),
  },
  {
    label: "reviewFindings",
    run: (source, target, context) =>
      migrateEntityStore(
        source.reviewFindings,
        target.reviewFindings,
        "reviewFindings",
        {
          order: ascendingOrder("id"),
          mapEntity: (entity) => ({
            ...entity,
            interactionRunId: resolveMappedId(
              context.interactionRunIds,
              entity.interactionRunId,
              "interaction run",
            ),
          }),
        },
      ),
  },
  {
    label: "discussionMappings",
    run: (source, target, context) =>
      migrateEntityStore(
        source.discussionMappings,
        target.discussionMappings,
        "discussionMappings",
        {
          order: ascendingOrder("id"),
          mapEntity: (entity) => ({
            ...entity,
            tenantId: resolveMappedId(
              context.tenantIds,
              entity.tenantId,
              "tenant",
            ),
            lastInteractionRunId: entity.lastInteractionRunId
              ? resolveMappedId(
                  context.interactionRunIds,
                  entity.lastInteractionRunId,
                  "interaction run",
                )
              : null,
          }),
        },
      ),
  },
];

export async function runCli(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  loadLocalEnvFile();
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const { positionals, options } = parseCliArgs(argv);
  const [resource, action, subAction] = positionals;

  if (options.help === true || options.help === "true") {
    printHelp(positionals);
    return 0;
  }

  if (resource === "tenant" && action === "add") {
    await initializePlatformRegistry({
      platformModules: config.platformModules,
      env: process.env,
      logger: logger.child({ component: "platform-registry" }),
    });

    const rawData: Record<string, unknown> = {};
    for (const key in options) {
      const camelKey = key.replace(/-([a-z])/g, (match, p1: string) =>
        p1.toUpperCase(),
      );
      rawData[camelKey] = options[key];
    }
    rawData.modelProfileName = options["model-profile"];
    const tenant = tenantAddSchema.parse(rawData);
    const platform = getPlatforms().find(
      (p) => p.getPlatformInfo().slug === tenant.platform,
    );
    if (!platform) {
      throw new Error(
        `Unsupported platform: ${tenant.platform}. Supported platforms are: ${getPlatforms()
          .map((p) => p.getPlatformInfo().slug)
          .join(", ")}`,
      );
    }
    const platformSchema = platform.getTenantRegistrationSchema();
    const parsedPlatformConfig = platformSchema.parse(rawData);

    return withStorage(options, config, async (storage) => {
      const connection = await storage.resolvePlatformConnection(
        tenant.connection,
      );
      if (!connection) {
        throw new Error(`Platform connection ${tenant.connection} not found`);
      }
      if (connection.platform !== platform.getPlatformInfo().slug) {
        throw new Error(
          `Platform connection ${connection.name} uses ${connection.platform}, expected ${platform.getPlatformInfo().slug}`,
        );
      }
      if (connection.status !== "ready") {
        throw new Error(`Platform connection ${connection.name} is not ready`);
      }
      await platform.onBeforeAddTenant?.(parsedPlatformConfig, connection);
      const newTenant = {
        key: platform.getTenantKey(parsedPlatformConfig, connection),
        platform: platform.getPlatformInfo().slug,
        platformConnectionId: connection.id,
        platformConfigJson: JSON.stringify(parsedPlatformConfig),
        ...(tenant.modelProfileName !== undefined
          ? { modelProfileName: tenant.modelProfileName }
          : {}),
      };
      const savedTenant = await storage.upsertTenant(newTenant);
      process.stdout.write(
        [
          "Tenant saved.",
          `id: ${savedTenant.id}`,
          `key: ${savedTenant.key}`,
          `modelProfile: ${savedTenant.modelProfileName ?? "(none)"}`,
        ].join("\n") + "\n",
      );
      return 0;
    });
  }

  if (resource === "platform" && action === "connection" && subAction) {
    await initializePlatformRegistry({
      platformModules: config.platformModules,
      env: process.env,
      logger: logger.child({ component: "platform-registry" }),
    });
    const rawData = mapCliOptions(options);

    if (subAction === "add") {
      const name = z.string().min(1).parse(options.name);
      const platformSlug = z
        .string()
        .min(1)
        .default("gitlab")
        .parse(options.platform);
      const platform = getPlatforms().find(
        (candidate) => candidate.getPlatformInfo().slug === platformSlug,
      );
      if (!platform) {
        throw new Error(`Unsupported platform: ${platformSlug}`);
      }
      const connectionConfig = platform
        .getConnectionRegistrationSchema()
        .parse(rawData);
      const recreate = options.recreate === true || options.recreate === "true";

      return withStorage(options, config, async (storage) => {
        const existing = await storage.resolvePlatformConnection(name);
        if (existing && !recreate) {
          throw new Error(`Platform connection name "${name}" already exists`);
        }
        if (existing && existing.platform !== platformSlug) {
          throw new Error(
            `Platform connection ${name} uses ${existing.platform}, expected ${platformSlug}`,
          );
        }
        const lifecycle = existing
          ? ((await platform.onBeforeRecreateConnection?.(
              existing,
              connectionConfig,
            )) ?? {
              status:
                (await platform.onBeforeAddConnection?.(connectionConfig)) ??
                "ready",
            })
          : {
              status:
                (await platform.onBeforeAddConnection?.(connectionConfig)) ??
                "ready",
            };
        writePlatformConnectionNotices(lifecycle.notices);
        const saved = existing
          ? await storage.updatePlatformConnection({
              reference: existing.id,
              status: lifecycle.status,
              platformConnectionConfigJson: JSON.stringify(connectionConfig),
            })
          : await storage.createPlatformConnection({
              name,
              platform: platformSlug,
              status: lifecycle.status,
              platformConnectionConfigJson: JSON.stringify(connectionConfig),
            });
        const setupUrl = platform.getConnectionSetupUrl?.(connectionConfig);
        process.stdout.write(
          `${formatPlatformConnection(saved)}${setupUrl ? `Setup URL: ${setupUrl}\n` : ""}`,
        );
        return 0;
      });
    }

    if (subAction === "list") {
      return withStorage(options, config, async (storage) => {
        const connections = await listAll(storage.stores.platformConnections, {
          order: [{ field: "name", direction: "asc" }],
        });
        process.stdout.write(
          `${JSON.stringify(connections.map(summarizePlatformConnection), null, 2)}\n`,
        );
        return 0;
      });
    }

    const reference = z
      .string()
      .min(1)
      .parse(options.connection ?? options.name);
    return withStorage(options, config, async (storage) => {
      const existing = await storage.resolvePlatformConnection(reference);
      if (!existing) {
        throw new Error(`Platform connection ${reference} not found`);
      }
      if (subAction === "describe") {
        process.stdout.write(
          `${JSON.stringify(summarizePlatformConnection(existing), null, 2)}\n`,
        );
        return 0;
      }
      if (subAction === "remove") {
        const platform = getPlatforms().find(
          (candidate) => candidate.getPlatformInfo().slug === existing.platform,
        );
        if (!platform) {
          throw new Error(`Unsupported platform: ${existing.platform}`);
        }
        writePlatformConnectionNotices(
          await platform.onBeforeRemoveConnection?.(existing),
        );
        await storage.deletePlatformConnection(reference);
        process.stdout.write(`Platform connection ${existing.name} removed.\n`);
        return 0;
      }
      if (subAction !== "update") {
        throw new Error(`Unsupported platform connection action: ${subAction}`);
      }
      if (typeof options.name === "string" && options.name !== existing.name) {
        throw new Error("Platform connection name is immutable");
      }
      if (
        typeof options.platform === "string" &&
        options.platform !== existing.platform
      ) {
        throw new Error("Platform connection platform is immutable");
      }
      const platform = getPlatforms().find(
        (candidate) => candidate.getPlatformInfo().slug === existing.platform,
      );
      if (!platform) {
        throw new Error(`Unsupported platform: ${existing.platform}`);
      }
      const currentConfig = JSON.parse(
        existing.platformConnectionConfigJson,
      ) as Record<string, unknown>;
      const patch = Object.fromEntries(
        Object.entries(rawData).filter(
          ([key]) =>
            ![
              "name",
              "platform",
              "connection",
              "sqliteDatabasePath",
              "storageProviderModule",
            ].includes(key),
        ),
      );
      const combined = platform
        .getConnectionRegistrationSchema()
        .parse({ ...currentConfig, ...patch });
      const status =
        (await platform.onBeforeUpdateConnection?.(existing, combined)) ??
        existing.status;
      const updated = await storage.updatePlatformConnection({
        reference,
        status,
        platformConnectionConfigJson: JSON.stringify(combined),
      });
      process.stdout.write(formatPlatformConnection(updated));
      return 0;
    });
  }

  if (resource === "tenant" && action === "list") {
    return withStorage(options, config, async (storage) => {
      const tenants = await listAll(storage.stores.tenants, {
        order: [{ field: "key", direction: "asc" }],
      });
      if (tenants.length === 0) {
        process.stdout.write("No tenants registered.\n");
        return 0;
      }

      process.stdout.write(
        `${JSON.stringify(
          tenants.map((tenant) => ({
            id: tenant.id,
            key: tenant.key,
            platform: tenant.platform,
            modelProfileName: tenant.modelProfileName,
          })),
          null,
          2,
        )}\n`,
      );
      return 0;
    });
  }

  if (resource === "tenant" && action === "set-profile") {
    const tenant = tenantProfileSchema.parse({
      tenantId: options["tenant-id"],
      tenantKey: options.key,
      modelProfileName: options["model-profile"],
      databasePath: options["sqlite-database-path"],
    });
    return withStorage(options, config, async (storage) => {
      const persistedTenant = await resolveTenantByLookup(storage, tenant);
      if (!persistedTenant) {
        throw new Error(
          tenant.tenantId
            ? `Tenant ${tenant.tenantId} not found`
            : `Tenant ${tenant.tenantKey} not found`,
        );
      }
      const updatedTenant = await storage.setTenantModelProfile(
        persistedTenant.key,
        tenant.modelProfileName,
      );
      process.stdout.write(
        [
          "Tenant profile updated.",
          `id: ${updatedTenant.id}`,
          `key: ${updatedTenant.key}`,
          `modelProfile: ${updatedTenant.modelProfileName ?? "(none)"}`,
        ].join("\n") + "\n",
      );
      return 0;
    });
  }

  if (resource === "tenant" && action === "clear-profile") {
    const tenant = tenantLookupSchema.parse({
      tenantId: options["tenant-id"],
      tenantKey: options.key,
      databasePath: options["sqlite-database-path"],
    });
    return withStorage(options, config, async (storage) => {
      const persistedTenant = await resolveTenantByLookup(storage, tenant);
      if (!persistedTenant) {
        throw new Error(
          tenant.tenantId
            ? `Tenant ${tenant.tenantId} not found`
            : `Tenant ${tenant.tenantKey} not found`,
        );
      }
      const updatedTenant = await storage.setTenantModelProfile(
        persistedTenant.key,
        null,
      );
      process.stdout.write(
        [
          "Tenant profile cleared.",
          `id: ${updatedTenant.id}`,
          `key: ${updatedTenant.key}`,
        ].join("\n") + "\n",
      );
      return 0;
    });
  }

  if (resource === "tenant" && action === "remove") {
    const tenant = tenantLookupSchema.parse({
      tenantId: options["tenant-id"],
      tenantKey: options.key,
      databasePath: options["sqlite-database-path"],
    });
    const workspaceRoot =
      typeof options["workspace-root"] === "string"
        ? resolve(options["workspace-root"])
        : config.workspaceRoot;
    const runLogDir =
      typeof options["run-log-dir"] === "string"
        ? resolve(options["run-log-dir"])
        : config.runLogDir;
    const assumeYes = options.yes === true || options.yes === "true";
    return withStorage(options, config, async (storage, storageContext) => {
      const persistedTenant = await resolveTenantByLookup(storage, tenant);
      if (!persistedTenant) {
        process.stdout.write(
          tenant.tenantId
            ? `Tenant ${tenant.tenantId} not found.\n`
            : `Tenant not found for ${tenant.tenantKey}.\n`,
        );
        return 1;
      }
      const deletionSummary = await storage.getTenantDeletionSummary(
        persistedTenant.key,
      );
      if (!deletionSummary) {
        process.stdout.write(`Tenant not found for ${persistedTenant.key}\n`);
        return 1;
      }

      const artifactSummary = await collectTenantArtifactSummary(
        deletionSummary,
        workspaceRoot,
        runLogDir,
      );
      process.stdout.write(
        formatTenantRemovalSummary(
          deletionSummary,
          artifactSummary,
          storageContext.sqliteDatabasePath ??
            resolve("./data/review-worker.sqlite"),
          workspaceRoot,
          runLogDir,
        ),
      );

      if (!assumeYes) {
        if (!process.stdin.isTTY) {
          process.stdout.write(
            "Tenant removal requires confirmation. Re-run with --yes in non-interactive mode.\n",
          );
          return 1;
        }

        const confirmed = await promptForConfirmation(
          "Continue and remove all tenant data? [y/N] ",
        );
        if (!confirmed) {
          process.stdout.write("Tenant removal aborted.\n");
          return 1;
        }
      }

      const deletedSummary = await storage.deleteTenantWithSummary(
        persistedTenant.key,
      );
      if (!deletedSummary) {
        throw new Error(
          `Tenant ${persistedTenant.key} disappeared during removal`,
        );
      }

      await deleteTenantArtifactsForSummary(
        deletedSummary,
        workspaceRoot,
        runLogDir,
      );

      process.stdout.write(
        [
          "Tenant removed.",
          `id: ${deletedSummary.tenant.id}`,
          `key: ${deletedSummary.tenant.key}`,
        ].join("\n") + "\n",
      );
      return 0;
    });
  }

  if (resource === "model-profile" && action === "add") {
    assertNoConflictingModelProfileFieldOptions(options);
    const profile = modelProfileSchema.parse({
      name: options.name,
      providerBaseUrl: options["base-url"],
      providerType: options["provider-type"],
      wireApi: options["wire-api"],
      authToken: options["auth-token"],
      reviewModel: options["review-model"],
      textGenerationModel: options["text-generation-model"],
      isDefault:
        "default" in options
          ? options.default === true || options.default === "true"
          : undefined,
      databasePath: options["sqlite-database-path"],
    });
    return withStorage(options, config, async (storage) => {
      const clearBaseUrl =
        options["clear-base-url"] === true ||
        options["clear-base-url"] === "true";
      const clearProviderType =
        clearBaseUrl ||
        options["clear-provider-type"] === true ||
        options["clear-provider-type"] === "true";
      const clearWireApi =
        clearBaseUrl ||
        options["clear-wire-api"] === true ||
        options["clear-wire-api"] === "true";

      const savedProfile = await storage.upsertModelProfile({
        name: profile.name,
        ...(clearBaseUrl ? { providerBaseUrl: null } : {}),
        ...("base-url" in options && !clearBaseUrl
          ? { providerBaseUrl: profile.providerBaseUrl ?? null }
          : {}),
        ...(clearProviderType ? { providerType: null } : {}),
        ...("provider-type" in options && !clearProviderType
          ? { providerType: profile.providerType ?? null }
          : {}),
        ...(clearWireApi ? { wireApi: null } : {}),
        ...("wire-api" in options && !clearWireApi
          ? { wireApi: profile.wireApi ?? null }
          : {}),
        ...(options["clear-auth-token"] === true ||
        options["clear-auth-token"] === "true"
          ? { authToken: null }
          : {}),
        ...("auth-token" in options &&
        !(
          options["clear-auth-token"] === true ||
          options["clear-auth-token"] === "true"
        )
          ? { authToken: profile.authToken ?? null }
          : {}),
        ...(options["clear-review-model"] === true ||
        options["clear-review-model"] === "true"
          ? { reviewModel: null }
          : {}),
        ...("review-model" in options &&
        !(
          options["clear-review-model"] === true ||
          options["clear-review-model"] === "true"
        )
          ? { reviewModel: profile.reviewModel ?? null }
          : {}),
        ...(options["clear-text-generation-model"] === true ||
        options["clear-text-generation-model"] === "true"
          ? { textGenerationModel: null }
          : {}),
        ...("text-generation-model" in options &&
        !(
          options["clear-text-generation-model"] === true ||
          options["clear-text-generation-model"] === "true"
        )
          ? { textGenerationModel: profile.textGenerationModel ?? null }
          : {}),
        ...("default" in options
          ? { isDefault: profile.isDefault ?? false }
          : {}),
      });
      process.stdout.write(
        formatModelProfileSummary("Model profile saved.", savedProfile),
      );
      return 0;
    });
  }

  if (resource === "model-profile" && action === "list") {
    return withStorage(options, config, async (storage) => {
      const profiles = await listAll(storage.stores.modelProfiles, {
        order: [
          { field: "isDefault", direction: "desc" },
          { field: "name", direction: "asc" },
        ],
      });
      if (profiles.length === 0) {
        process.stdout.write("No model profiles configured.\n");
        return 0;
      }

      process.stdout.write(
        `${JSON.stringify(
          profiles.map((profile) => ({
            name: profile.name,
            providerBaseUrl: profile.providerBaseUrl,
            providerType: profile.providerType,
            wireApi: profile.wireApi,
            reviewModel: profile.reviewModel,
            textGenerationModel: profile.textGenerationModel,
            isDefault: profile.isDefault,
            authToken: maskSecret(profile.authToken),
          })),
          null,
          2,
        )}\n`,
      );
      return 0;
    });
  }

  if (resource === "model-profile" && action === "remove") {
    const profile = modelProfileLookupSchema.parse({
      name: options.name,
      databasePath: options["sqlite-database-path"],
    });
    return withStorage(options, config, async (storage) => {
      const removedProfile = await storage.deleteModelProfile(profile.name);
      if (!removedProfile) {
        process.stdout.write(`Model profile ${profile.name} not found.\n`);
        return 1;
      }

      process.stdout.write(
        formatModelProfileSummary("Model profile removed.", removedProfile),
      );
      return 0;
    });
  }

  if (resource === "model-profile" && action === "set-default") {
    const profile = modelProfileLookupSchema.parse({
      name: options.name,
      databasePath: options["sqlite-database-path"],
    });
    return withStorage(options, config, async (storage) => {
      const updatedProfile = await storage.setDefaultModelProfile(profile.name);
      if (!updatedProfile) {
        process.stdout.write("No model profile selected as default.\n");
        return 1;
      }

      process.stdout.write(
        formatModelProfileSummary(
          "Default model profile updated.",
          updatedProfile,
        ),
      );
      return 0;
    });
  }

  if (resource === "model-profile" && action === "clear-default") {
    return withStorage(options, config, async (storage) => {
      await storage.setDefaultModelProfile(null);
      process.stdout.write("Default model profile cleared.\n");
      return 0;
    });
  }

  if (resource === "storage" && action === "migrate") {
    const migration = storageMigrationSchema.parse({
      fromProviderModule:
        options["from-storage-provider-module"] ??
        options["source-storage-provider-module"],
      toProviderModule:
        options["to-storage-provider-module"] ??
        options["destination-storage-provider-module"],
      fromSqliteDatabasePath:
        options["from-sqlite-database-path"] ??
        options["source-sqlite-database-path"],
      toSqliteDatabasePath:
        options["to-sqlite-database-path"] ??
        options["destination-sqlite-database-path"],
    });

    return withStoragePair(
      {
        providerModule: migration.fromProviderModule,
        sqliteDatabasePath: migration.fromSqliteDatabasePath,
      },
      {
        providerModule: migration.toProviderModule,
        sqliteDatabasePath: migration.toSqliteDatabasePath,
      },
      async (sourceRuntime, targetRuntime) => {
        const migratedCounts = await migrateStorageStores(
          sourceRuntime.storage.stores,
          targetRuntime.storage.stores,
        );
        process.stdout.write(
          formatStorageMigrationSummary(
            sourceRuntime,
            targetRuntime,
            migratedCounts,
          ),
        );
        return 0;
      },
    );
  }

  if (resource === "mr" && action === "describe") {
    return runCodeReviewDescribeCommand(options, config);
  }

  if (resource === "metrics" && action === "sessions") {
    const config = loadConfig();
    const runLogDir =
      typeof options["run-log-dir"] === "string"
        ? resolve(options["run-log-dir"])
        : config.runLogDir;
    const runRows = await loadRunMetricsRows(runLogDir);

    if (runRows.length === 0) {
      process.stdout.write(
        `No readable Copilot session logs found in ${runLogDir}.\n`,
      );
      return 0;
    }

    const modelPremiumRequestsRows =
      buildModelPremiumRequestsStatsRows(runRows);
    process.stdout.write(
      [
        formatRunMetricsTable(runRows),
        formatSummaryMetricsTable(buildSummaryMetricsRows(runRows)),
        ...(modelPremiumRequestsRows.length > 0
          ? [formatModelPremiumRequestsStatsTable(modelPremiumRequestsRows)]
          : []),
      ].join("\n\n") + "\n",
    );
    return 0;
  }

  printHelp(positionals);
  return 1;
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) {
      positionals.push(token ?? "");
      continue;
    }

    const option = token.slice(2);
    const [key, inlineValue] = option.split("=", 2);
    if (!key) {
      continue;
    }

    if (inlineValue !== undefined) {
      options[key] = inlineValue;
      continue;
    }

    const nextToken = argv[index + 1];
    if (nextToken && !nextToken.startsWith("--")) {
      options[key] = nextToken;
      index += 1;
      continue;
    }

    options[key] = true;
  }

  return { positionals, options };
}

async function withStorage<T>(
  options: Record<string, string | boolean>,
  config: ReturnType<typeof loadConfig>,
  run: (
    storage: StorageHelpers,
    context: { sqliteDatabasePath?: string | undefined },
  ) => Promise<T>,
): Promise<T> {
  const env = {
    ...process.env,
  };
  if (typeof options["sqlite-database-path"] === "string") {
    env.SQLITE_DATABASE_PATH = options["sqlite-database-path"];
  }

  const storageRuntime = await initializeStorageRuntime({
    providerModule:
      typeof options["storage-provider-module"] === "string"
        ? options["storage-provider-module"]
        : config.storageProviderModule,
    env,
  });

  try {
    return await run(storageRuntime.storage, {
      sqliteDatabasePath:
        typeof env.SQLITE_DATABASE_PATH === "string"
          ? resolve(env.SQLITE_DATABASE_PATH)
          : undefined,
    });
  } finally {
    await storageRuntime.provider.close();
  }
}

export function detectCliCommand(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
): string {
  if (env.REVIEWPHIN_CLI_COMMAND?.trim()) {
    return env.REVIEWPHIN_CLI_COMMAND.trim();
  }

  if (env.npm_lifecycle_event === "cli" && env.npm_execpath?.includes("pnpm")) {
    return "pnpm cli";
  }

  const scriptPath = argv[1];
  return scriptPath ? `node ${scriptPath}` : "reviewphin";
}

function printHelp(
  positionals: string[] = [],
  fallbackToAllCommands = true,
): boolean {
  const cliCommand = detectCliCommand();
  const platforms = getPlatforms();
  const commands: string[] = [];
  for (const platform of platforms) {
    const info = platform.getPlatformInfo();

    const platformParams: {
      paramString: string;
      isOptional: boolean;
      priority?: number | undefined;
    }[] = [
      {
        paramString: `--platform ${info.slug}`,
        /**
         * even though technically optional and has defaults, platform probably should be always provided for clarity
         */
        isOptional: false,
        priority: -1,
      },
      {
        paramString: `--model-profile <name>`,
        isOptional: true,
      },
      {
        paramString: `--connection <name-or-id>`,
        isOptional: false,
        priority: -0.75,
      },
      {
        paramString: `--sqlite-database-path <path>`,
        isOptional: true,
        priority: 1,
      },
      {
        paramString: `--storage-provider-module <module>`,
        isOptional: true,
        priority: 2,
      },
    ];
    platformParams.push(
      ...getSchemaCliParams(platform.getTenantRegistrationSchema()),
    );

    const sortedParams = platformParams.toSorted(
      (a, b) => (a.priority ?? 0) - (b.priority ?? 0),
    );

    const paramStrings = sortedParams.map((p) =>
      p.isOptional ? `[${p.paramString}]` : p.paramString,
    );

    commands.push(`tenant add ${paramStrings.join(" ")}`);

    const connectionParams = getSchemaCliParams(
      platform.getConnectionRegistrationSchema(),
    );
    commands.push(
      `platform connection add --name <name> --platform ${info.slug} ${formatCliParams(connectionParams)} [--recreate]`,
      `platform connection update --connection <name-or-id> ${formatCliParams(
        connectionParams.map((param) => ({ ...param, isOptional: true })),
      )}`,
    );
  }
  commands.push(
    "platform connection remove --connection <name-or-id>",
    "platform connection list",
    "platform connection describe --connection <name-or-id>",
    "tenant list [--sqlite-database-path <path>] [--storage-provider-module <module>]",
    "tenant set-profile (--tenant-id <id> | --key <key>) --model-profile <name> [--sqlite-database-path <path>] [--storage-provider-module <module>]",
    "tenant clear-profile (--tenant-id <id> | --key <key>) [--sqlite-database-path <path>] [--storage-provider-module <module>]",
    "tenant remove (--tenant-id <id> | --key <key>) [--sqlite-database-path <path>] [--storage-provider-module <module>] [--workspace-root <path>] [--run-log-dir <path>] [--yes]",
    "model-profile add --name <name> [--base-url <url>] [--clear-base-url] [--provider-type <type>] [--clear-provider-type] [--wire-api <mode>] [--clear-wire-api] [--auth-token <token>] [--clear-auth-token] [--review-model <name>] [--clear-review-model] [--text-generation-model <name>] [--clear-text-generation-model] [--default] [--sqlite-database-path <path>] [--storage-provider-module <module>]",
    "model-profile list [--sqlite-database-path <path>] [--storage-provider-module <module>]",
    "model-profile remove --name <name> [--sqlite-database-path <path>] [--storage-provider-module <module>]",
    "model-profile set-default --name <name> [--sqlite-database-path <path>] [--storage-provider-module <module>]",
    "model-profile clear-default [--sqlite-database-path <path>] [--storage-provider-module <module>]",
    "storage migrate --from-storage-provider-module <module> [--from-sqlite-database-path <path>] --to-storage-provider-module <module> [--to-sqlite-database-path <path>]",
    "mr describe (--tenant-id <id> | --key <key>) --code-review-id <id> [--current-interaction-job-id <id>] [--trigger-comment-id <id> --trigger-comment-action <create|update> [--trigger-comment-updated-at <iso>] [--trigger-comment-body <text>]] [--json] [--sqlite-database-path <path>] [--storage-provider-module <module>]",
    "metrics sessions [--run-log-dir <path>]",
  );

  const positionalPrefix = positionals.join(" ");
  const matchingCommands = positionalPrefix
    ? commands.filter(
        (command) =>
          command === positionalPrefix ||
          command.startsWith(`${positionalPrefix} `),
      )
    : commands;
  if (matchingCommands.length === 0 && !fallbackToAllCommands) {
    return false;
  }
  const displayedCommands =
    matchingCommands.length > 0 ? matchingCommands : commands;

  const usageLines = displayedCommands
    .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((command) => `  ${cliCommand} ${command} [--help]`);

  process.stdout.write(["Usage:", ...usageLines].join("\n") + "\n");
  return true;
}

interface CliHelpParam {
  readonly paramString: string;
  readonly isOptional: boolean;
  readonly priority?: number | undefined;
}

function getSchemaCliParams(
  schema: z.ZodObject<z.ZodRawShape>,
): CliHelpParam[] {
  return Object.entries(schema.shape).map(([key, propertySchema]) => {
    const optionName = key
      .split(/(?=[A-Z])/)
      .join("-")
      .toLowerCase();
    const isOptional = (propertySchema as z.ZodType).safeParse(
      undefined,
    ).success;

    return {
      paramString: `--${optionName} <value>`,
      isOptional,
      priority: isOptional ? 0 : -0.5,
    };
  });
}

function formatCliParams(params: readonly CliHelpParam[]): string {
  return params
    .toSorted((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    .map((param) =>
      param.isOptional ? `[${param.paramString}]` : param.paramString,
    )
    .join(" ");
}

async function runCodeReviewDescribeCommand(
  options: Record<string, string | boolean>,
  config: ReturnType<typeof loadConfig>,
): Promise<number> {
  const jsonOutput = options.json === true || options.json === "true";
  const input = mergeRequestDescribeSchema.parse({
    tenantId: options["tenant-id"],
    tenantKey: options.key,
    codeReviewId: options["code-review-id"] ?? options["merge-request-iid"],
    currentInteractionJobId: options["current-interaction-job-id"],
    triggerNoteId: options["trigger-comment-id"],
    triggerNoteAction: options["trigger-comment-action"],
    triggerNoteUpdatedAt: options["trigger-comment-updated-at"],
    triggerNoteBody: options["trigger-comment-body"],
  });

  return withStorage(options, config, async (storage) => {
    const tenant = await resolveDescribeTenant(storage, input);
    if (!tenant) {
      process.stdout.write(
        formatMissingDescribeTenantMessage(input.tenantId, input.tenantKey),
      );
      return 1;
    }

    const interactionJobs = await listCodeReviewInteractionJobs(
      storage,
      tenant,
      input.codeReviewId,
    );
    if (
      input.currentInteractionJobId &&
      !interactionJobs.some((job) => job.id === input.currentInteractionJobId)
    ) {
      process.stdout.write(
        `Interaction job ${input.currentInteractionJobId} not found for tenant ${tenant.id} merge request ${input.codeReviewId}.\n`,
      );
      return 1;
    }

    const currentInteractionJobId =
      input.currentInteractionJobId ?? interactionJobs[0]?.id ?? null;
    const description = await buildCodeReviewDescription(
      storage,
      tenant,
      input.codeReviewId,
      interactionJobs,
      currentInteractionJobId,
      resolveCodeReviewTriggerDedupeInput(input),
    );

    process.stdout.write(
      jsonOutput
        ? `${JSON.stringify(description, null, 2)}\n`
        : formatCodeReviewDescription(description),
    );
    return 0;
  });
}

async function resolveDescribeTenant(
  storage: StorageHelpers,
  input: {
    tenantId?: string | undefined;
    tenantKey?: string | undefined;
  },
): Promise<TenantRecord | null> {
  if (input.tenantId) {
    return storage.stores.tenants.get(input.tenantId);
  }

  return storage.stores.tenants.find({
    key: { eq: input.tenantKey! },
  });
}

async function resolveTenantByLookup(
  storage: StorageHelpers,
  input: {
    tenantId?: string | undefined;
    tenantKey?: string | undefined;
  },
): Promise<TenantRecord | null> {
  return resolveDescribeTenant(storage, input);
}

function refineTenantLookup(
  value: {
    tenantId?: string | undefined;
    tenantKey?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const hasTenantId = value.tenantId !== undefined;
  const hasTenantKey = value.tenantKey !== undefined;

  if (!hasTenantId && !hasTenantKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide --tenant-id or --key.",
      path: ["tenantId"],
    });
  }

  if (hasTenantId && hasTenantKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide either --tenant-id or --key, not both.",
      path: ["tenantId"],
    });
  }
}

async function listCodeReviewInteractionJobs(
  storage: StorageHelpers,
  tenant: TenantRecord,
  codeReviewId: number,
): Promise<InteractionJobRecord[]> {
  return listProjectScopedCodeReviewInteractionJobs(
    storage,
    tenant,
    codeReviewId,
  );
}

async function listProjectScopedCodeReviewInteractionJobs(
  storage: StorageHelpers,
  tenant: TenantRecord,
  codeReviewId: number,
): Promise<InteractionJobRecord[]> {
  return listAll(storage.stores.interactionJobs, {
    filters: {
      codeReviewId: { eq: codeReviewId },
      tenantId: { eq: tenant.id },
    },
    order: [
      { field: "enqueuedAt", direction: "desc" },
      { field: "id", direction: "desc" },
    ],
  });
}

async function buildCodeReviewDescription(
  storage: StorageHelpers,
  tenant: TenantRecord,
  codeReviewId: number,
  interactionJobs: readonly InteractionJobRecord[],
  currentInteractionJobId: string | null,
  triggerDedupeInput?: CodeReviewTriggerDedupeInput,
) {
  const interactionJobIds = interactionJobs.map((job) => job.id);
  const hasInteractionJobs = interactionJobIds.length > 0;

  const [
    interactionRuns,
    snapshots,
    discussionMappings,
    interactionJobDiagnostics,
    latestReviewFindingsOverall,
    latestCompletedInteractionOverall,
    previousCompletedInteractionRelativeToCurrent,
    priorReviewFindingsRelativeToCurrent,
  ] = await Promise.all([
    loadInteractionRunsForJobs(storage, interactionJobIds),
    loadSnapshotsForJobs(storage, interactionJobIds),
    listAll(storage.stores.discussionMappings, {
      filters: {
        tenantId: { eq: tenant.id },
        codeReviewId: { eq: codeReviewId },
      },
      order: [
        { field: "updatedAt", direction: "desc" },
        { field: "id", direction: "desc" },
      ],
    }),
    buildInteractionJobDiagnostics(storage, tenant, codeReviewId),
    storage.listLatestReviewFindings(tenant.id, codeReviewId),
    hasInteractionJobs
      ? storage.getLatestCompletedInteractionForCodeReview(
          tenant.id,
          codeReviewId,
          "",
        )
      : Promise.resolve(null),
    currentInteractionJobId
      ? storage.getLatestCompletedInteractionForCodeReview(
          tenant.id,
          codeReviewId,
          currentInteractionJobId,
        )
      : Promise.resolve(null),
    currentInteractionJobId
      ? storage.listPriorReviewFindings(
          tenant.id,
          codeReviewId,
          currentInteractionJobId,
        )
      : Promise.resolve([]),
  ]);

  return {
    tenant: summarizeTenant(tenant),
    codeReviewId,
    currentInteractionJobId,
    dedupeInspection: summarizeTriggerDedupeInspection(
      tenant,
      codeReviewId,
      interactionJobs,
      triggerDedupeInput,
    ),
    interactionJobDiagnostics,
    counts: {
      interactionJobs: interactionJobs.length,
      interactionRuns: interactionRuns.length,
      codeReviewSnapshots: snapshots.length,
      discussionMappings: discussionMappings.length,
      latestReviewFindingsOverall: latestReviewFindingsOverall.length,
      priorReviewFindingsRelativeToCurrent:
        priorReviewFindingsRelativeToCurrent.length,
    },
    latestInteractionJob: interactionJobs[0]
      ? summarizeInteractionJob(interactionJobs[0])
      : null,
    latestCompletedInteractionOverall: summarizePreviousCompletedInteraction(
      latestCompletedInteractionOverall,
    ),
    previousCompletedInteractionRelativeToCurrent:
      summarizePreviousCompletedInteraction(
        previousCompletedInteractionRelativeToCurrent,
      ),
    latestReviewFindingsOverall: latestReviewFindingsOverall.map(
      summarizePriorReviewFinding,
    ),
    priorReviewFindingsRelativeToCurrent:
      priorReviewFindingsRelativeToCurrent.map(summarizePriorReviewFinding),
    interactionJobs: interactionJobs.map(summarizeInteractionJob),
    interactionRuns: interactionRuns.map(summarizeInteractionRun),
    codeReviewSnapshots: snapshots.map(summarizeSnapshot),
    discussionMappings: discussionMappings.map(summarizeDiscussionMapping),
  };
}

async function buildInteractionJobDiagnostics(
  storage: StorageHelpers,
  tenant: TenantRecord,
  codeReviewId: number,
) {
  const [jobsByTenantAndCodeReview, jobsByTenantOnly] = await Promise.all([
    listAll(storage.stores.interactionJobs, {
      filters: {
        tenantId: { eq: tenant.id },
        codeReviewId: { eq: codeReviewId },
      },
      order: [
        { field: "enqueuedAt", direction: "desc" },
        { field: "id", direction: "desc" },
      ],
    }),
    listAll(storage.stores.interactionJobs, {
      filters: {
        tenantId: { eq: tenant.id },
      },
      order: [
        { field: "enqueuedAt", direction: "desc" },
        { field: "id", direction: "desc" },
      ],
    }),
  ]);

  return {
    counts: {
      byTenantAndCodeReview: jobsByTenantAndCodeReview.length,
      byTenantOnly: jobsByTenantOnly.length,
    },
    samples: {
      byTenantAndCodeReview: jobsByTenantAndCodeReview
        .slice(0, 10)
        .map(summarizeInteractionJob),
      byTenantOnly: jobsByTenantOnly.slice(0, 10).map(summarizeInteractionJob),
    },
  };
}

async function loadInteractionRunsForJobs(
  storage: StorageHelpers,
  interactionJobIds: readonly string[],
): Promise<InteractionRunRecord[]> {
  if (interactionJobIds.length === 0) {
    return [];
  }

  return listAll(storage.stores.interactionRuns, {
    filters: {
      interactionJobId: { in: interactionJobIds },
    },
    order: [
      { field: "startedAt", direction: "desc" },
      { field: "id", direction: "desc" },
    ],
  });
}

async function loadSnapshotsForJobs(
  storage: StorageHelpers,
  interactionJobIds: readonly string[],
): Promise<CodeReviewSnapshotRecord[]> {
  if (interactionJobIds.length === 0) {
    return [];
  }

  return listAll(storage.stores.codeReviewSnapshots, {
    filters: {
      interactionJobId: { in: interactionJobIds },
    },
    order: [{ field: "createdAt", direction: "desc" }],
  });
}

function formatMissingDescribeTenantMessage(
  tenantId: string | undefined,
  tenantKey: string | undefined,
): string {
  if (tenantId) {
    return `Tenant ${tenantId} not found.\n`;
  }

  return `Tenant not found for ${tenantKey}.\n`;
}

function summarizeTenant(tenant: TenantRecord) {
  const gitLabConfig =
    tenant.platform === "gitlab" ? getGitLabTenantConfig(tenant) : null;

  return {
    id: tenant.id,
    key: tenant.key,
    platform: tenant.platform,
    ...(gitLabConfig
      ? {
          projectId: gitLabConfig.projectId,
        }
      : {}),
    modelProfileName: tenant.modelProfileName,
    platformConnectionId: tenant.platformConnectionId,
  };
}

function summarizePlatformConnection(connection: PlatformConnectionRecord) {
  return {
    id: connection.id,
    name: connection.name,
    platform: connection.platform,
    status: connection.status,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

function formatPlatformConnection(
  connection: PlatformConnectionRecord,
): string {
  return `${JSON.stringify(summarizePlatformConnection(connection), null, 2)}\n`;
}

function mapCliOptions(
  options: Record<string, string | boolean>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(options).map(([key, value]) => [
      key.replace(/-([a-z])/g, (_match, letter: string) =>
        letter.toUpperCase(),
      ),
      value,
    ]),
  );
}

function summarizeInteractionJob(interactionJob: InteractionJobRecord) {
  return {
    id: interactionJob.id,
    dedupeKey: interactionJob.dedupeKey,
    tenantId: interactionJob.tenantId,
    codeReviewId: interactionJob.codeReviewId,
    commentId: interactionJob.commentId,
    headSha: interactionJob.headSha,
    status: interactionJob.status,
    retryCount: interactionJob.retryCount,
    lastError: interactionJob.lastError,
    enqueuedAt: interactionJob.enqueuedAt,
    startedAt: interactionJob.startedAt,
    finishedAt: interactionJob.finishedAt,
  };
}

function summarizeInteractionRun(interactionRun: InteractionRunRecord) {
  return {
    id: interactionRun.id,
    interactionJobId: interactionRun.interactionJobId,
    tenantId: interactionRun.tenantId,
    provider: interactionRun.provider,
    model: interactionRun.model,
    modelProfileName: interactionRun.modelProfileName,
    providerBaseUrl: interactionRun.providerBaseUrl,
    providerType: interactionRun.providerType,
    textGenerationModel: interactionRun.textGenerationModel,
    status: interactionRun.status,
    error: interactionRun.error,
    startedAt: interactionRun.startedAt,
    finishedAt: interactionRun.finishedAt,
    hasResultJson: interactionRun.resultJson !== null,
    resultJsonBytes: interactionRun.resultJson?.length ?? 0,
  };
}

function summarizeSnapshot(snapshot: CodeReviewSnapshotRecord) {
  return {
    id: snapshot.id,
    interactionJobId: snapshot.interactionJobId,
    tenantId: snapshot.tenantId,
    codeReviewId: snapshot.codeReviewId,
    headSha: snapshot.headSha,
    workspaceStrategy: snapshot.workspaceStrategy,
    createdAt: snapshot.createdAt,
    codeReviewJsonBytes: snapshot.codeReviewJson.length,
    versionsJsonBytes: snapshot.versionsJson.length,
    changesJsonBytes: snapshot.changesJson.length,
    commentsJsonBytes: snapshot.commentsJson.length,
    discussionsJsonBytes: snapshot.discussionsJson.length,
    instructionsJsonBytes: snapshot.instructionsJson.length,
    hasProjectMemoryJson: snapshot.projectMemoryJson !== null,
  };
}

function summarizePreviousCompletedInteraction(
  interaction: PreviousCompletedInteractionRecord | null,
) {
  if (!interaction) {
    return null;
  }

  return {
    interactionRunId: interaction.interactionRunId,
    interactionJobId: interaction.interactionJobId,
    finishedAt: interaction.finishedAt,
    headSha: interaction.headSha,
    resultJsonBytes: interaction.resultJson.length,
    snapshot: summarizeSnapshot(interaction.snapshot),
  };
}

function summarizePriorReviewFinding(finding: PriorReviewFindingRecord) {
  return {
    findingId: finding.findingId,
    identityKey: finding.identityKey,
    status: finding.status,
    title: finding.title,
    body: finding.body,
    severity: finding.severity,
    category: finding.category,
    anchor: finding.anchor,
    suggestion: finding.suggestion,
    interactionRunId: finding.interactionRunId,
    reviewedAt: finding.reviewedAt,
    headSha: finding.headSha,
  };
}

function summarizeDiscussionMapping(
  discussionMapping: DiscussionMappingRecord,
) {
  return {
    id: discussionMapping.id,
    tenantId: discussionMapping.tenantId,
    codeReviewId: discussionMapping.codeReviewId,
    identityKey: discussionMapping.identityKey,
    status: discussionMapping.status,
    platformDiscussionId: discussionMapping.platformDiscussionId,
    platformCommentId: discussionMapping.platformCommentId,
    botDiscussion: discussionMapping.botDiscussion,
    botComment: discussionMapping.botComment,
    commentAuthorId: discussionMapping.commentAuthorId,
    commentAuthorUsername: discussionMapping.commentAuthorUsername,
    lastInteractionRunId: discussionMapping.lastInteractionRunId,
    createdAt: discussionMapping.createdAt,
    updatedAt: discussionMapping.updatedAt,
  };
}

function resolveCodeReviewTriggerDedupeInput(
  input: z.infer<typeof mergeRequestDescribeSchema>,
): CodeReviewTriggerDedupeInput | undefined {
  if (input.triggerNoteId === undefined) {
    return undefined;
  }

  return {
    commentId: input.triggerNoteId,
    commentAction: input.triggerNoteAction ?? "create",
    commentUpdatedAt: input.triggerNoteUpdatedAt,
    commentBody: input.triggerNoteBody,
  };
}

function summarizeTriggerDedupeInspection(
  tenant: TenantRecord,
  codeReviewId: number,
  interactionJobs: readonly InteractionJobRecord[],
  triggerInput?: CodeReviewTriggerDedupeInput,
) {
  const existingJobs = interactionJobs.map((job) => ({
    jobId: job.id,
    commentId: job.commentId,
    dedupeKey: job.dedupeKey,
    status: job.status,
    enqueuedAt: job.enqueuedAt,
  }));

  if (tenant.platform !== "gitlab") {
    return {
      triggerProvided: triggerInput !== undefined,
      supported: false,
      reason:
        "Trigger-comment dedupe inspection is currently available for GitLab tenants only.",
      existingJobs,
    };
  }

  if (!triggerInput) {
    return {
      triggerProvided: false,
      supported: true,
      existingJobs,
    };
  }

  const tenantConfig = getGitLabTenantConfig(tenant);
  const candidateDedupeKey = createInteractionJobDedupeKey({
    baseUrl: tenant.key.split("::")[0] ?? "",
    projectId: tenantConfig.projectId,
    codeReviewId,
    commentId: triggerInput.commentId,
    commentAction: triggerInput.commentAction,
    commentUpdatedAt: triggerInput.commentUpdatedAt,
    commentBody: triggerInput.commentBody,
  });
  const matchingJob = interactionJobs.find(
    (job) => job.dedupeKey === candidateDedupeKey,
  );

  return {
    triggerProvided: true,
    supported: true,
    existingJobs,
    candidate: {
      commentId: triggerInput.commentId,
      commentAction: triggerInput.commentAction,
      commentUpdatedAt: triggerInput.commentUpdatedAt ?? null,
      triggerCommentBodyProvided: triggerInput.commentBody !== undefined,
      candidateDedupeKey,
      matchingExistingJobId: matchingJob?.id ?? null,
      wouldCreateNewJob: matchingJob === undefined,
    },
  };
}

type CodeReviewDescribeOutput = Awaited<
  ReturnType<typeof buildCodeReviewDescription>
>;

function formatCodeReviewDescription(
  description: CodeReviewDescribeOutput,
): string {
  const latestReviewLines = description.latestInteractionJob
    ? [
        "",
        "Latest Review",
        `job: ${description.latestInteractionJob.id} (${description.latestInteractionJob.status})`,
        `commentId: ${description.latestInteractionJob.commentId}`,
        `headSha: ${shortenValue(description.latestInteractionJob.headSha)}`,
        `enqueuedAt: ${description.latestInteractionJob.enqueuedAt}`,
        `finishedAt: ${description.latestInteractionJob.finishedAt ?? "(none)"}`,
      ]
    : [];
  const latestFindingLines =
    description.latestReviewFindingsOverall.length > 0
      ? [
          "",
          "Latest Findings",
          ...formatFindingsSummary(description.latestReviewFindingsOverall),
        ]
      : [];

  const lines = [
    "Merge Request",
    `tenant: ${description.tenant.key} (${description.tenant.platform})`,
    `tenant: ${description.tenant.id}`,
    `codeReviewId: ${description.codeReviewId}`,
    "",
    "Current State",
    `currentInteractionJobId: ${description.currentInteractionJobId ?? "(none)"}`,
    `interactionJobs: ${description.counts.interactionJobs}`,
    `interactionRuns: ${description.counts.interactionRuns}`,
    `codeReviewSnapshots: ${description.counts.codeReviewSnapshots}`,
    `discussionMappings: ${description.counts.discussionMappings}`,
    `latestReviewFindingsOverall: ${description.counts.latestReviewFindingsOverall}`,
    `priorReviewFindingsRelativeToCurrent: ${description.counts.priorReviewFindingsRelativeToCurrent}`,
    ...latestReviewLines,
    "",
    "History Signal",
    `tenant+mr jobs: ${description.interactionJobDiagnostics.counts.byTenantAndCodeReview}`,
    `tenant jobs total: ${description.interactionJobDiagnostics.counts.byTenantOnly}`,
    `assessment: ${buildCodeReviewAssessment(description)}`,
    "",
    "Previous Review",
    `latestCompletedInteractionOverall: ${formatPreviousInteractionSummary(description.latestCompletedInteractionOverall)}`,
    `previousCompletedInteractionRelativeToCurrent: ${formatPreviousInteractionSummary(description.previousCompletedInteractionRelativeToCurrent)}`,
    "",
    "Dedupe",
    ...formatDedupeInspection(description.dedupeInspection),
    ...latestFindingLines,
  ];

  return `${lines.join("\n")}\n`;
}

function buildCodeReviewAssessment(
  description: CodeReviewDescribeOutput,
): string {
  const diagnostics = description.interactionJobDiagnostics.counts;
  if (diagnostics.byTenantOnly > diagnostics.byTenantAndCodeReview) {
    return "Tenant-wide history exceeds merge-request-scoped history; this tenant has additional review activity outside the current merge request.";
  }

  if (diagnostics.byTenantAndCodeReview > 1) {
    return "Multiple MR jobs are visible in storage.";
  }

  return "Only one MR job is visible with the current filters.";
}

function formatPreviousInteractionSummary(
  interaction: CodeReviewDescribeOutput["latestCompletedInteractionOverall"],
): string {
  if (!interaction) {
    return "none";
  }

  return `${interaction.interactionJobId} @ ${interaction.finishedAt}`;
}

function formatDedupeInspection(
  dedupeInspection: CodeReviewDescribeOutput["dedupeInspection"],
): string[] {
  if (!dedupeInspection.supported) {
    return [
      `trigger inspection: ${dedupeInspection.triggerProvided ? "provided" : "not provided"}`,
      `candidate: unsupported for this platform`,
      `reason: ${dedupeInspection.reason}`,
      `visible MR jobs for dedupe: ${dedupeInspection.existingJobs.length}`,
    ];
  }

  if (!dedupeInspection.triggerProvided) {
    return [
      `trigger inspection: not provided`,
      `visible MR jobs for dedupe: ${dedupeInspection.existingJobs.length}`,
    ];
  }

  const candidate = dedupeInspection.candidate;
  if (!candidate) {
    return [`trigger inspection: provided`, `candidate: unavailable`];
  }

  return [
    `trigger inspection: provided`,
    `wouldCreateNewJob: ${candidate.wouldCreateNewJob ? "yes" : "no"}`,
    `matchingExistingJobId: ${candidate.matchingExistingJobId ?? "(none)"}`,
    `triggerCommentId: ${candidate.commentId}`,
    `triggerCommentAction: ${candidate.commentAction}`,
  ];
}

function formatFindingsSummary(
  findings: CodeReviewDescribeOutput["latestReviewFindingsOverall"],
): string[] {
  const visibleFindings = findings
    .slice(0, 5)
    .map(
      (finding) =>
        `- ${finding.status} ${finding.severity} ${finding.category}: ${finding.title}`,
    );
  const hiddenCount = findings.length - visibleFindings.length;

  return hiddenCount > 0
    ? [...visibleFindings, `- ... ${hiddenCount} more`]
    : visibleFindings;
}

function shortenValue(value: string, length = 12): string {
  if (value.length <= length) {
    return value;
  }

  return value.slice(0, length);
}

async function withStoragePair<T>(
  sourceOptions: StorageEndpointOptions,
  targetOptions: StorageEndpointOptions,
  run: (
    sourceRuntime: InitializedStorageRuntime,
    targetRuntime: InitializedStorageRuntime,
  ) => Promise<T>,
): Promise<T> {
  const sourceRuntime = await initializeStorageRuntime({
    providerModule: sourceOptions.providerModule,
    env: buildStorageEnv(sourceOptions.sqliteDatabasePath),
  });

  try {
    const targetRuntime = await initializeStorageRuntime({
      providerModule: targetOptions.providerModule,
      env: buildStorageEnv(targetOptions.sqliteDatabasePath),
    });

    try {
      return await run(sourceRuntime, targetRuntime);
    } finally {
      await targetRuntime.provider.close();
    }
  } finally {
    await sourceRuntime.provider.close();
  }
}

function buildStorageEnv(sqliteDatabasePath?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };

  if (sqliteDatabasePath) {
    env.SQLITE_DATABASE_PATH = sqliteDatabasePath;
  }

  return env;
}

async function migrateStorageStores(
  source: StorageStores,
  target: StorageStores,
): Promise<Record<string, number>> {
  const migratedCounts: Record<string, number> = {};
  const context: StorageMigrationContext = {
    tenantIds: new Map(),
    interactionJobIds: new Map(),
    interactionRunIds: new Map(),
  };

  for (const step of storageMigrationSteps) {
    process.stdout.write(`Migrating ${step.label}...\n`);
    migratedCounts[step.label] = await step.run(source, target, context);
  }

  return migratedCounts;
}

async function migrateEntityStore<TEntity, TFilters, TOrder extends string>(
  source: EntityStore<TEntity, TFilters, TOrder>,
  target: EntityStore<TEntity, TFilters, TOrder>,
  label: string,
  options?: {
    order?: readonly StoreListOrder<TOrder>[];
    mapEntity?: (entity: TEntity) => TEntity;
  },
): Promise<number> {
  return migrateStorePages(
    source,
    label,
    async (entities) => {
      await target.upsertMany(
        options?.mapEntity
          ? entities.map((entity) => options.mapEntity?.(entity) ?? entity)
          : entities,
      );
    },
    options?.order,
  );
}

async function migrateTenants<TEntity extends { id: string }>(
  source: EntityStore<TEntity, unknown, string>,
  target: EntityStore<TEntity, unknown, string>,
  context: StorageMigrationContext,
  options?: {
    order?: readonly StoreListOrder<string>[];
  },
): Promise<number> {
  return migrateStorePages(
    source,
    "tenants",
    async (entities) => {
      await target.upsertMany(entities);

      for (const entity of entities) {
        context.tenantIds.set(entity.id, entity.id);
      }
    },
    options?.order,
  );
}

async function migrateInteractionJobs<
  TEntity extends { id: string; tenantId: string },
>(
  source: EntityStore<TEntity, unknown, string>,
  target: EntityStore<TEntity, unknown, string>,
  context: StorageMigrationContext,
  options?: {
    order?: readonly StoreListOrder<string>[];
  },
): Promise<number> {
  return migrateStorePages(
    source,
    "interactionJobs",
    async (entities) => {
      const migrated = entities.map((entity) => ({
        ...entity,
        tenantId: resolveMappedId(context.tenantIds, entity.tenantId, "tenant"),
      }));

      await target.upsertMany(migrated);

      for (const entity of migrated) {
        context.interactionJobIds.set(entity.id, entity.id);
      }
    },
    options?.order,
  );
}

async function migrateInteractionRuns<
  TEntity extends { id: string; interactionJobId: string; tenantId: string },
>(
  source: EntityStore<TEntity, unknown, string>,
  target: EntityStore<TEntity, unknown, string>,
  context: StorageMigrationContext,
  options?: {
    order?: readonly StoreListOrder<string>[];
  },
): Promise<number> {
  return migrateStorePages(
    source,
    "interactionRuns",
    async (entities) => {
      const migrated = entities.map((entity) => ({
        ...entity,
        interactionJobId: resolveMappedId(
          context.interactionJobIds,
          entity.interactionJobId,
          "interaction job",
        ),
        tenantId: resolveMappedId(context.tenantIds, entity.tenantId, "tenant"),
      }));

      await target.upsertMany(migrated);

      for (const entity of migrated) {
        context.interactionRunIds.set(entity.id, entity.id);
      }
    },
    options?.order,
  );
}

async function migrateStorePages<TEntity, TFilters, TOrder extends string>(
  source: EntityStore<TEntity, TFilters, TOrder>,
  label: string,
  processBatch: (entities: TEntity[]) => Promise<void>,
  order?: readonly StoreListOrder<TOrder>[],
): Promise<number> {
  const totalItems = await countStoreEntities(source, order);
  const totalPages = Math.ceil(totalItems / STORAGE_MIGRATION_PAGE_SIZE);
  let migratedCount = 0;

  if (totalPages === 0) {
    process.stdout.write(`${label} (0/0)\n`);
    return 0;
  }

  for (let page = 1; page <= totalPages; page += 1) {
    process.stdout.write(`${label} (${page}/${totalPages})\n`);
    const batch = await source.list({
      ...(order ? { order } : {}),
      page,
      pageSize: STORAGE_MIGRATION_PAGE_SIZE,
    });

    await processBatch(batch);
    migratedCount += batch.length;
  }

  return migratedCount;
}

async function countStoreEntities<TEntity, TFilters, TOrder extends string>(
  source: EntityStore<TEntity, TFilters, TOrder>,
  order?: readonly StoreListOrder<TOrder>[],
): Promise<number> {
  let totalCount = 0;

  for (let page = 1; ; page += 1) {
    const batch = await source.list({
      ...(order ? { order } : {}),
      page,
      pageSize: STORAGE_MIGRATION_PAGE_SIZE,
    });
    totalCount += batch.length;

    if (batch.length < STORAGE_MIGRATION_PAGE_SIZE) {
      return totalCount;
    }
  }
}

function ascendingOrder<TOrder extends string>(
  field: TOrder,
): readonly StoreListOrder<TOrder>[] {
  return [{ field, direction: "asc" }];
}

function resolveMappedId(
  idMap: ReadonlyMap<string, string>,
  sourceId: string,
  entityType: string,
): string {
  const mappedId = idMap.get(sourceId);
  if (!mappedId) {
    throw new Error(`Missing migrated ${entityType} for source id ${sourceId}`);
  }

  return mappedId;
}

function formatStorageMigrationSummary(
  sourceRuntime: InitializedStorageRuntime,
  targetRuntime: InitializedStorageRuntime,
  migratedCounts: Record<string, number>,
): string {
  const totalMigrated = Object.values(migratedCounts).reduce(
    (sum, count) => sum + count,
    0,
  );

  return (
    [
      "Storage migration completed.",
      `source: ${sourceRuntime.provider.getProviderId()} (${sourceRuntime.moduleSpecifier})`,
      `destination: ${targetRuntime.provider.getProviderId()} (${targetRuntime.moduleSpecifier})`,
      ...storageMigrationSteps.map(
        (step) => `- ${step.label}: ${migratedCounts[step.label] ?? 0}`,
      ),
      `total: ${totalMigrated}`,
    ].join("\n") + "\n"
  );
}

function formatModelProfileSummary(
  header: string,
  profile: {
    name: string;
    providerBaseUrl: string | null;
    providerType: string | null;
    wireApi: string | null;
    reviewModel: string | null;
    textGenerationModel: string | null;
    isDefault: boolean;
    authToken: string | null;
  },
): string {
  return (
    [
      header,
      `name: ${profile.name}`,
      `providerBaseUrl: ${profile.providerBaseUrl ?? "(none)"}`,
      `providerType: ${profile.providerType ?? "(native)"}`,
      `wireApi: ${profile.providerBaseUrl ? (profile.wireApi ?? "responses") : "(native)"}`,
      `reviewModel: ${profile.reviewModel ?? "(default)"}`,
      `textGenerationModel: ${profile.textGenerationModel ?? "(default)"}`,
      `default: ${profile.isDefault ? "yes" : "no"}`,
      `authToken: ${maskSecret(profile.authToken) ?? "(none)"}`,
    ].join("\n") + "\n"
  );
}

function assertNoConflictingModelProfileFieldOptions(
  options: Record<string, string | boolean>,
): void {
  for (const field of clearableModelProfileFields) {
    const clearOption = `clear-${field}`;
    if (!(field in options) || !(clearOption in options)) {
      continue;
    }

    throw new Error(`Cannot use --${field} and --${clearOption} together`);
  }

  if (
    "clear-base-url" in options &&
    ("provider-type" in options || "wire-api" in options)
  ) {
    throw new Error(
      "Cannot combine --clear-base-url with --provider-type or --wire-api",
    );
  }
}

async function collectTenantArtifactSummary(
  summary: TenantDeletionSummary,
  workspaceRoot: string,
  runLogDir: string,
): Promise<TenantArtifactSummary> {
  const workspacePaths = summary.interactionJobIds.map((interactionJobId) =>
    join(workspaceRoot, interactionJobId),
  );
  const runLogPaths = summary.interactionRunIds.map((interactionRunId) =>
    join(runLogDir, interactionRunId),
  );
  const [existingWorkspaceCount, existingRunLogCount] = await Promise.all([
    countExistingPaths(workspacePaths),
    countExistingPaths(runLogPaths),
  ]);

  return {
    workspacePaths,
    runLogPaths,
    existingWorkspaceCount,
    existingRunLogCount,
  };
}

async function countExistingPaths(paths: string[]): Promise<number> {
  const results = await Promise.all(paths.map((path) => pathExists(path)));
  return results.filter(Boolean).length;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function formatTenantRemovalSummary(
  summary: TenantDeletionSummary,
  artifactSummary: TenantArtifactSummary,
  databasePath: string,
  workspaceRoot: string,
  runLogDir: string,
): string {
  return [
    `Preparing to remove tenant ${summary.tenant.key} (${summary.tenant.platform})`,
    `database: ${databasePath}`,
    "This will delete:",
    `- 1 tenant record`,
    `- ${summary.interactionJobCount} ${pluralize("interaction job", summary.interactionJobCount)}`,
    `- ${summary.codeReviewSnapshotCount} ${pluralize("code review snapshot", summary.codeReviewSnapshotCount)}`,
    `- ${summary.interactionRunCount} ${pluralize("interaction run", summary.interactionRunCount)}`,
    `- ${summary.reviewFindingCount} ${pluralize("review finding", summary.reviewFindingCount)}`,
    `- ${summary.interactionRunMetricCount} ${pluralize("interaction run metric", summary.interactionRunMetricCount)}`,
    `- ${summary.discussionMappingCount} ${pluralize("discussion mapping", summary.discussionMappingCount)}`,
    `- ${summary.projectMemoryCount} ${pluralize("project memory record", summary.projectMemoryCount)}`,
    `- ${artifactSummary.existingWorkspaceCount}/${artifactSummary.workspacePaths.length} workspace ${pluralize("directory", artifactSummary.workspacePaths.length)} under ${workspaceRoot}`,
    `- ${artifactSummary.existingRunLogCount}/${artifactSummary.runLogPaths.length} run log ${pluralize("directory", artifactSummary.runLogPaths.length)} under ${runLogDir}`,
    "",
  ].join("\n");
}

function pluralize(noun: string, count: number): string {
  return count === 1 ? noun : `${noun}s`;
}

function writePlatformConnectionNotices(
  notices: readonly string[] | undefined,
): void {
  if (!notices || notices.length === 0) {
    return;
  }
  process.stdout.write(
    [
      "Provider cleanup required:",
      ...notices.map((notice) => `- ${notice}`),
      "",
    ].join("\n"),
  );
}

async function promptForConfirmation(prompt: string): Promise<boolean> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = (await readline.question(prompt)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    readline.close();
  }
}

async function deleteTenantArtifacts(paths: string[]): Promise<void> {
  const uniquePaths = [...new Set(paths)];
  const results = await Promise.allSettled(
    uniquePaths.map((path) =>
      rm(path, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      }),
    ),
  );
  const failures = results
    .map((result, index) => ({ result, path: uniquePaths[index] }))
    .filter(
      (entry): entry is { result: PromiseRejectedResult; path: string } =>
        entry.result.status === "rejected",
    );

  if (failures.length > 0) {
    throw new Error(
      [
        "Failed to remove local tenant artifacts:",
        ...failures.map(
          (failure) => `- ${failure.path}: ${String(failure.result.reason)}`,
        ),
      ].join("\n"),
    );
  }
}

async function deleteTenantArtifactsForSummary(
  summary: TenantDeletionSummary,
  workspaceRoot: string,
  runLogDir: string,
): Promise<void> {
  await deleteTenantArtifacts([
    ...summary.interactionJobIds.map((interactionJobId) =>
      join(workspaceRoot, interactionJobId),
    ),
    ...summary.interactionRunIds.map((interactionRunId) =>
      join(runLogDir, interactionRunId),
    ),
  ]);
}

async function loadRunMetricsRows(runLogDir: string): Promise<RunMetricsRow[]> {
  try {
    const entries = await readdir(runLogDir, { withFileTypes: true });
    const runDirectories = entries
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
    const rows: RunMetricsRow[] = [];

    for (const entry of runDirectories) {
      const metrics = await loadRunMetrics(join(runLogDir, entry.name));
      if (!metrics) {
        continue;
      }

      rows.push({
        run: entry.name,
        premiumRequests: metrics.premiumRequests,
        premiumRequestsByModel: metrics.premiumRequestsByModel,
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        toolCalls: metrics.toolExecutions,
        durationMs: metrics.apiDurationMs,
      });
    }

    return rows;
  } catch {
    return [];
  }
}

async function loadRunMetrics(runDirectory: string) {
  const candidateLogPaths = [
    join(runDirectory, "copilot", "reviewer", "session.json"),
    join(runDirectory, "copilot", "session.json"),
  ];

  for (const candidateLogPath of candidateLogPaths) {
    const metrics = await readHarnessRunMetrics(candidateLogPath);
    if (metrics) {
      return metrics;
    }
  }

  return null;
}

function buildModelPremiumRequestsStatsRows(
  rows: RunMetricsRow[],
): ModelPremiumRequestsStatsRow[] {
  const statsByModel = new Map<string, number[]>();

  for (const row of rows) {
    for (const metric of row.premiumRequestsByModel) {
      const current = statsByModel.get(metric.model) ?? [];
      current.push(metric.premiumRequests);
      statsByModel.set(metric.model, current);
    }
  }

  return [...statsByModel.entries()]
    .sort((left, right) =>
      sum(left[1]) - sum(right[1]) === 0
        ? left[0].localeCompare(right[0])
        : sum(right[1]) - sum(left[1]),
    )
    .map(([model, premiumRequests]) => ({
      model,
      runs: premiumRequests.length,
      premiumRequests: sum(premiumRequests),
      min: minimum(premiumRequests),
      max: maximum(premiumRequests),
      avg: average(premiumRequests),
      p25: percentile(premiumRequests, 25),
      p50: percentile(premiumRequests, 50),
      p75: percentile(premiumRequests, 75),
      p90: percentile(premiumRequests, 90),
    }));
}

function buildSummaryMetricsRows(rows: RunMetricsRow[]): SummaryMetricsRow[] {
  const premiumRequests = rows.map((row) => row.premiumRequests);
  const inputTokens = rows.map((row) => row.inputTokens);
  const outputTokens = rows.map((row) => row.outputTokens);
  const toolCalls = rows.map((row) => row.toolCalls);
  const durationMs = rows.map((row) => row.durationMs);

  return [
    createSummaryMetricsRow(
      "min",
      premiumRequests,
      inputTokens,
      outputTokens,
      toolCalls,
      durationMs,
      minimum,
    ),
    createSummaryMetricsRow(
      "max",
      premiumRequests,
      inputTokens,
      outputTokens,
      toolCalls,
      durationMs,
      maximum,
    ),
    createSummaryMetricsRow(
      "avg",
      premiumRequests,
      inputTokens,
      outputTokens,
      toolCalls,
      durationMs,
      average,
    ),
    createSummaryMetricsRow(
      "p50",
      premiumRequests,
      inputTokens,
      outputTokens,
      toolCalls,
      durationMs,
      (values) => percentile(values, 50),
    ),
    createSummaryMetricsRow(
      "p25",
      premiumRequests,
      inputTokens,
      outputTokens,
      toolCalls,
      durationMs,
      (values) => percentile(values, 25),
    ),
    createSummaryMetricsRow(
      "p75",
      premiumRequests,
      inputTokens,
      outputTokens,
      toolCalls,
      durationMs,
      (values) => percentile(values, 75),
    ),
    createSummaryMetricsRow(
      "p90",
      premiumRequests,
      inputTokens,
      outputTokens,
      toolCalls,
      durationMs,
      (values) => percentile(values, 90),
    ),
  ];
}

function createSummaryMetricsRow(
  stat: string,
  premiumRequests: number[],
  inputTokens: number[],
  outputTokens: number[],
  toolCalls: number[],
  durationMs: number[],
  aggregate: (values: number[]) => number,
): SummaryMetricsRow {
  return {
    stat,
    premiumRequests: aggregate(premiumRequests),
    inputTokens: aggregate(inputTokens),
    outputTokens: aggregate(outputTokens),
    toolCalls: aggregate(toolCalls),
    durationMs: aggregate(durationMs),
  };
}

function formatRunMetricsTable(rows: RunMetricsRow[]): string {
  return formatTable(
    [
      "run",
      "premiumRequests",
      "inputTokens",
      "outputTokens",
      "toolCalls",
      "durationMs",
    ],
    rows.map((row) => [
      row.run,
      row.premiumRequests,
      row.inputTokens,
      row.outputTokens,
      row.toolCalls,
      row.durationMs,
    ]),
  );
}

function formatSummaryMetricsTable(rows: SummaryMetricsRow[]): string {
  return formatTable(
    [
      "stat",
      "premiumRequests",
      "inputTokens",
      "outputTokens",
      "toolCalls",
      "durationMs",
    ],
    rows.map((row) => [
      row.stat,
      row.premiumRequests,
      row.inputTokens,
      row.outputTokens,
      row.toolCalls,
      row.durationMs,
    ]),
  );
}

function formatModelPremiumRequestsStatsTable(
  rows: ModelPremiumRequestsStatsRow[],
): string {
  return formatTable(
    [
      "model",
      "runs",
      "premiumRequests",
      "min",
      "max",
      "avg",
      "p25",
      "p50",
      "p75",
      "p90",
    ],
    rows.map((row) => [
      row.model,
      row.runs,
      row.premiumRequests,
      row.min,
      row.max,
      row.avg,
      row.p25,
      row.p50,
      row.p75,
      row.p90,
    ]),
  );
}

function formatTable(
  headers: string[],
  rows: Array<Array<string | number>>,
): string {
  const widths = headers.map((header, columnIndex) => {
    const values = rows.map((row) => formatCellValue(row[columnIndex] ?? ""));
    return Math.max(header.length, ...values.map((value) => value.length));
  });
  const header = headers
    .map((label, index) => label.padEnd(widths[index] ?? 0))
    .join("  ");
  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  const body = rows.map((row) =>
    row
      .map((rawValue, index) => {
        const value = formatCellValue(rawValue);
        return typeof rawValue === "number"
          ? value.padStart(widths[index] ?? 0)
          : value.padEnd(widths[index] ?? 0);
      })
      .join("  "),
  );

  return [header, separator, ...body].join("\n");
}

function formatCellValue(value: string | number): string {
  if (typeof value === "string") {
    return value;
  }

  if (Number.isInteger(value)) {
    return String(value);
  }

  return value
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/(\.\d*[1-9])0+$/, "$1");
}

function minimum(values: number[]): number {
  return Math.min(...values);
}

function maximum(values: number[]): number {
  return Math.max(...values);
}

function average(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function percentile(values: number[], percentileRank: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = (percentileRank / 100) * (sorted.length - 1);
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  const lowerValue = sorted[lowerIndex];
  const upperValue = sorted[upperIndex];

  if (lowerValue === undefined || upperValue === undefined) {
    return Number.NaN;
  }

  if (lowerIndex === upperIndex) {
    return lowerValue;
  }

  return lowerValue + (upperValue - lowerValue) * (index - lowerIndex);
}

export async function runCliEntry(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  try {
    const exitCode = await runCli(argv);
    if (exitCode !== 0) {
      const { positionals } = parseCliArgs(argv);
      printHelp(positionals, false);
    }
    return exitCode;
  } catch (error: unknown) {
    const { positionals } = parseCliArgs(argv);
    printHelp(positionals, false);
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

async function main(): Promise<void> {
  const exitCode = await runCliEntry();
  process.exitCode = exitCode;
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
