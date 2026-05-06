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
import { initializeStorageRuntime } from "./storage/runtime.js";
import { listAll, type StorageHelpers } from "./storage/storage-helpers.js";
import type { TenantDeletionSummary } from "./storage/contract/index.js";

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
  databasePath: z.string().min(1).optional(),
});

const tenantLookupSchema = tenantConfigSchema
  .pick({
    baseUrl: true,
    projectId: true,
  })
  .extend({
    databasePath: z.string().min(1).optional(),
  });

const tenantProfileSchema = tenantLookupSchema.extend({
  modelProfileName: modelProfileNameSchema,
});

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

export async function runCli(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  loadLocalEnvFile();
  const config = loadConfig();

  const { positionals, options } = parseCliArgs(argv);
  const [resource, action] = positionals;

  if (resource === "tenant" && action === "add") {
    const tenant = tenantAddSchema.parse({
      baseUrl: options["base-url"],
      projectId: options["project-id"],
      apiToken: options["api-token"],
      webhookSecret: options["webhook-secret"],
      botUserId: options["bot-user-id"],
      botUsername: options["bot-username"],
      modelProfileName: options["model-profile"],
      databasePath: options["sqlite-database-path"],
    });
    return withStorage(options, config, async (storage) => {
      const savedTenant = await storage.upsertTenant(tenant);
      process.stdout.write(
        [
          "Tenant saved.",
          `id: ${savedTenant.id}`,
          `key: ${savedTenant.key}`,
          `project: ${savedTenant.baseUrl} :: ${savedTenant.projectId}`,
          `modelProfile: ${savedTenant.modelProfileName ?? "(none)"}`,
        ].join("\n") + "\n",
      );
      return 0;
    });
  }

  if (resource === "tenant" && action === "list") {
    return withStorage(options, config, async (storage) => {
      const tenants = await listAll(storage.stores.tenants, {
        order: [
          { field: "baseUrl", direction: "asc" },
          { field: "projectId", direction: "asc" },
        ],
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
            baseUrl: tenant.baseUrl,
            projectId: tenant.projectId,
            botUserId: tenant.botUserId,
            botUsername: tenant.botUsername,
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
      baseUrl: options["base-url"],
      projectId: options["project-id"],
      modelProfileName: options["model-profile"],
      databasePath: options["sqlite-database-path"],
    });
    return withStorage(options, config, async (storage) => {
      const updatedTenant = await storage.setTenantModelProfile(
        tenant.baseUrl,
        tenant.projectId,
        tenant.modelProfileName,
      );
      process.stdout.write(
        [
          "Tenant profile updated.",
          `id: ${updatedTenant.id}`,
          `key: ${updatedTenant.key}`,
          `project: ${updatedTenant.baseUrl} :: ${updatedTenant.projectId}`,
          `modelProfile: ${updatedTenant.modelProfileName ?? "(none)"}`,
        ].join("\n") + "\n",
      );
      return 0;
    });
  }

  if (resource === "tenant" && action === "clear-profile") {
    const tenant = tenantLookupSchema.parse({
      baseUrl: options["base-url"],
      projectId: options["project-id"],
      databasePath: options["sqlite-database-path"],
    });
    return withStorage(options, config, async (storage) => {
      const updatedTenant = await storage.setTenantModelProfile(
        tenant.baseUrl,
        tenant.projectId,
        null,
      );
      process.stdout.write(
        [
          "Tenant profile cleared.",
          `id: ${updatedTenant.id}`,
          `key: ${updatedTenant.key}`,
          `project: ${updatedTenant.baseUrl} :: ${updatedTenant.projectId}`,
        ].join("\n") + "\n",
      );
      return 0;
    });
  }

  if (resource === "tenant" && action === "remove") {
    const tenant = tenantLookupSchema.parse({
      baseUrl: options["base-url"],
      projectId: options["project-id"],
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
      const deletionSummary = await storage.getTenantDeletionSummary(
        tenant.baseUrl,
        tenant.projectId,
      );
      if (!deletionSummary) {
        process.stdout.write(
          `Tenant not found for ${tenant.baseUrl} :: ${tenant.projectId}\n`,
        );
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
        tenant.baseUrl,
        tenant.projectId,
      );
      if (!deletedSummary) {
        throw new Error(
          `Tenant ${tenant.baseUrl} :: ${tenant.projectId} disappeared during removal`,
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
          `project: ${deletedSummary.tenant.baseUrl} :: ${deletedSummary.tenant.projectId}`,
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

  printHelp();
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

function printHelp(): void {
  process.stdout.write(
    [
      "Usage:",
      "  pnpm cli tenant add --base-url <url> --project-id <id> --api-token <token> --webhook-secret <secret> --bot-username <name> [--bot-user-id <id>] [--model-profile <name>] [--sqlite-database-path <path>] [--storage-provider-module <module>]",
      "  pnpm cli tenant list [--sqlite-database-path <path>] [--storage-provider-module <module>]",
      "  pnpm cli tenant set-profile --base-url <url> --project-id <id> --model-profile <name> [--sqlite-database-path <path>] [--storage-provider-module <module>]",
      "  pnpm cli tenant clear-profile --base-url <url> --project-id <id> [--sqlite-database-path <path>] [--storage-provider-module <module>]",
      "  pnpm cli tenant remove --base-url <url> --project-id <id> [--sqlite-database-path <path>] [--storage-provider-module <module>] [--workspace-root <path>] [--run-log-dir <path>] [--yes]",
      "  pnpm cli model-profile add --name <name> [--base-url <url>] [--clear-base-url] [--provider-type <type>] [--clear-provider-type] [--wire-api <mode>] [--clear-wire-api] [--auth-token <token>] [--clear-auth-token] [--review-model <name>] [--clear-review-model] [--text-generation-model <name>] [--clear-text-generation-model] [--default] [--sqlite-database-path <path>] [--storage-provider-module <module>]",
      "  pnpm cli model-profile list [--sqlite-database-path <path>] [--storage-provider-module <module>]",
      "  pnpm cli model-profile remove --name <name> [--sqlite-database-path <path>] [--storage-provider-module <module>]",
      "  pnpm cli model-profile set-default --name <name> [--sqlite-database-path <path>] [--storage-provider-module <module>]",
      "  pnpm cli model-profile clear-default [--sqlite-database-path <path>] [--storage-provider-module <module>]",
      "  pnpm cli metrics sessions [--run-log-dir <path>]",
    ].join("\n") + "\n",
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
    `Preparing to remove tenant ${summary.tenant.baseUrl} :: ${summary.tenant.projectId}`,
    `database: ${databasePath}`,
    "This will delete:",
    `- 1 tenant record`,
    `- ${summary.interactionJobCount} ${pluralize("interaction job", summary.interactionJobCount)}`,
    `- ${summary.mergeRequestSnapshotCount} ${pluralize("merge request snapshot", summary.mergeRequestSnapshotCount)}`,
    `- ${summary.interactionRunCount} ${pluralize("interaction run", summary.interactionRunCount)}`,
    `- ${summary.reviewFindingCount} ${pluralize("review finding", summary.reviewFindingCount)}`,
    `- ${summary.interactionRunMetricCount} ${pluralize("interaction run metric", summary.interactionRunMetricCount)}`,
    `- ${summary.discussionMappingCount} ${pluralize("discussion mapping", summary.discussionMappingCount)}`,
    `- ${artifactSummary.existingWorkspaceCount}/${artifactSummary.workspacePaths.length} workspace ${pluralize("directory", artifactSummary.workspacePaths.length)} under ${workspaceRoot}`,
    `- ${artifactSummary.existingRunLogCount}/${artifactSummary.runLogPaths.length} run log ${pluralize("directory", artifactSummary.runLogPaths.length)} under ${runLogDir}`,
    "",
  ].join("\n");
}

function pluralize(noun: string, count: number): string {
  return count === 1 ? noun : `${noun}s`;
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

async function main(): Promise<void> {
  const exitCode = await runCli();
  process.exitCode = exitCode;
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
