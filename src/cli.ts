import { access, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { loadConfig, tenantConfigSchema } from "./config.js";
import { loadLocalEnvFile } from "./env.js";
import { readCopilotRunMetrics, type PremiumRequestsByModelMetric } from "./review/copilot-run-metrics.js";
import { SqliteStorage } from "./storage/sqlite-storage.js";
import type { TenantDeletionSummary } from "./storage/types.js";

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
  databasePath: z.string().min(1).optional()
});

const tenantLookupSchema = tenantConfigSchema
  .pick({
    baseUrl: true,
    projectId: true
  })
  .extend({
    databasePath: z.string().min(1).optional()
  });

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  loadLocalEnvFile();

  const { positionals, options } = parseCliArgs(argv);
  const [resource, action] = positionals;

  if (resource === "tenant" && action === "add") {
    const config = loadConfig();
    const tenant = tenantAddSchema.parse({
      baseUrl: options["base-url"],
      projectId: options["project-id"],
      apiToken: options["api-token"],
      webhookSecret: options["webhook-secret"],
      botUserId: options["bot-user-id"],
      botUsername: options["bot-username"],
      databasePath: options["database-path"]
    });

    const storage = new SqliteStorage({
      databasePath: tenant.databasePath ?? config.databasePath
    });
    await storage.initialize();

    const savedTenant = await storage.upsertTenant(tenant);
    process.stdout.write(
      [
        "Tenant saved.",
        `id: ${savedTenant.id}`,
        `key: ${savedTenant.key}`,
        `project: ${savedTenant.baseUrl} :: ${savedTenant.projectId}`
      ].join("\n") + "\n"
    );
    return 0;
  }

  if (resource === "tenant" && action === "list") {
    const config = loadConfig();
    const databasePath = typeof options["database-path"] === "string" ? options["database-path"] : config.databasePath;
    const storage = new SqliteStorage({ databasePath });
    await storage.initialize();

    const tenants = await storage.listTenants();
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
          botUsername: tenant.botUsername
        })),
        null,
        2
      )}\n`
    );
    return 0;
  }

  if (resource === "tenant" && action === "remove") {
    const config = loadConfig();
    const tenant = tenantLookupSchema.parse({
      baseUrl: options["base-url"],
      projectId: options["project-id"],
      databasePath: options["database-path"]
    });
    const databasePath = typeof tenant.databasePath === "string" ? resolve(tenant.databasePath) : config.databasePath;
    const workspaceRoot = typeof options["workspace-root"] === "string" ? resolve(options["workspace-root"]) : config.workspaceRoot;
    const runLogDir = typeof options["run-log-dir"] === "string" ? resolve(options["run-log-dir"]) : config.runLogDir;
    const assumeYes = options.yes === true || options.yes === "true";

    const storage = new SqliteStorage({
      databasePath
    });
    await storage.initialize();

    const deletionSummary = await storage.getTenantDeletionSummary(tenant.baseUrl, tenant.projectId);
    if (!deletionSummary) {
      process.stdout.write(`Tenant not found for ${tenant.baseUrl} :: ${tenant.projectId}\n`);
      return 1;
    }

    const artifactSummary = await collectTenantArtifactSummary(deletionSummary, workspaceRoot, runLogDir);
    process.stdout.write(formatTenantRemovalSummary(deletionSummary, artifactSummary, databasePath, workspaceRoot, runLogDir));

    if (!assumeYes) {
      if (!process.stdin.isTTY) {
        process.stdout.write("Tenant removal requires confirmation. Re-run with --yes in non-interactive mode.\n");
        return 1;
      }

      const confirmed = await promptForConfirmation("Continue and remove all tenant data? [y/N] ");
      if (!confirmed) {
        process.stdout.write("Tenant removal aborted.\n");
        return 1;
      }
    }

    const deletedSummary = await storage.deleteTenantWithSummary(tenant.baseUrl, tenant.projectId);
    if (!deletedSummary) {
      throw new Error(`Tenant ${tenant.baseUrl} :: ${tenant.projectId} disappeared during removal`);
    }

    await deleteTenantArtifactsForSummary(deletedSummary, workspaceRoot, runLogDir);

    process.stdout.write(
      [
        "Tenant removed.",
        `id: ${deletedSummary.tenant.id}`,
        `key: ${deletedSummary.tenant.key}`,
        `project: ${deletedSummary.tenant.baseUrl} :: ${deletedSummary.tenant.projectId}`
      ].join("\n") + "\n"
    );
    return 0;
  }

  if (resource === "metrics" && action === "sessions") {
    const config = loadConfig();
    const runLogDir =
      typeof options["run-log-dir"] === "string" ? resolve(options["run-log-dir"]) : config.runLogDir;
    const runRows = await loadRunMetricsRows(runLogDir);

    if (runRows.length === 0) {
      process.stdout.write(`No readable Copilot session logs found in ${runLogDir}.\n`);
      return 0;
    }

    const modelPremiumRequestsRows = buildModelPremiumRequestsStatsRows(runRows);
    process.stdout.write(
      [
        formatRunMetricsTable(runRows),
        formatSummaryMetricsTable(buildSummaryMetricsRows(runRows)),
        ...(modelPremiumRequestsRows.length > 0 ? [formatModelPremiumRequestsStatsTable(modelPremiumRequestsRows)] : [])
      ].join("\n\n") + "\n"
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

function printHelp(): void {
  process.stdout.write(
      [
        "Usage:",
        "  pnpm cli tenant add --base-url <url> --project-id <id> --api-token <token> --webhook-secret <secret> --bot-username <name> [--bot-user-id <id>] [--database-path <path>]",
        "  pnpm cli tenant list [--database-path <path>]",
        "  pnpm cli tenant remove --base-url <url> --project-id <id> [--database-path <path>] [--workspace-root <path>] [--run-log-dir <path>] [--yes]",
        "  pnpm cli metrics sessions [--run-log-dir <path>]"
      ].join("\n") + "\n"
    );
}

async function collectTenantArtifactSummary(
  summary: TenantDeletionSummary,
  workspaceRoot: string,
  runLogDir: string
): Promise<TenantArtifactSummary> {
  const workspacePaths = summary.reviewJobIds.map((reviewJobId) => join(workspaceRoot, reviewJobId));
  const runLogPaths = summary.reviewRunIds.map((reviewRunId) => join(runLogDir, reviewRunId));
  const [existingWorkspaceCount, existingRunLogCount] = await Promise.all([
    countExistingPaths(workspacePaths),
    countExistingPaths(runLogPaths)
  ]);

  return {
    workspacePaths,
    runLogPaths,
    existingWorkspaceCount,
    existingRunLogCount
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
  runLogDir: string
): string {
  return [
    `Preparing to remove tenant ${summary.tenant.baseUrl} :: ${summary.tenant.projectId}`,
    `database: ${databasePath}`,
    "This will delete:",
    `- 1 tenant record`,
    `- ${summary.reviewJobCount} ${pluralize("review job", summary.reviewJobCount)}`,
    `- ${summary.mergeRequestSnapshotCount} ${pluralize("merge request snapshot", summary.mergeRequestSnapshotCount)}`,
    `- ${summary.reviewRunCount} ${pluralize("review run", summary.reviewRunCount)}`,
    `- ${summary.reviewFindingCount} ${pluralize("review finding", summary.reviewFindingCount)}`,
    `- ${summary.reviewRunMetricCount} ${pluralize("review run metric", summary.reviewRunMetricCount)}`,
    `- ${summary.discussionMappingCount} ${pluralize("discussion mapping", summary.discussionMappingCount)}`,
    `- ${artifactSummary.existingWorkspaceCount}/${artifactSummary.workspacePaths.length} workspace ${pluralize("directory", artifactSummary.workspacePaths.length)} under ${workspaceRoot}`,
    `- ${artifactSummary.existingRunLogCount}/${artifactSummary.runLogPaths.length} run log ${pluralize("directory", artifactSummary.runLogPaths.length)} under ${runLogDir}`,
    ""
  ].join("\n");
}

function pluralize(noun: string, count: number): string {
  return count === 1 ? noun : `${noun}s`;
}

async function promptForConfirmation(prompt: string): Promise<boolean> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout
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
        retryDelay: 200
      })
    )
  );
  const failures = results
    .map((result, index) => ({ result, path: uniquePaths[index] }))
    .filter((entry): entry is { result: PromiseRejectedResult; path: string } => entry.result.status === "rejected");

  if (failures.length > 0) {
    throw new Error(
      [
        "Failed to remove local tenant artifacts:",
        ...failures.map((failure) => `- ${failure.path}: ${String(failure.result.reason)}`)
      ].join("\n")
    );
  }
}

async function deleteTenantArtifactsForSummary(
  summary: TenantDeletionSummary,
  workspaceRoot: string,
  runLogDir: string
): Promise<void> {
  await deleteTenantArtifacts([
    ...summary.reviewJobIds.map((reviewJobId) => join(workspaceRoot, reviewJobId)),
    ...summary.reviewRunIds.map((reviewRunId) => join(runLogDir, reviewRunId))
  ]);
}

async function loadRunMetricsRows(runLogDir: string): Promise<RunMetricsRow[]> {
  try {
    const entries = await readdir(runLogDir, { withFileTypes: true });
    const runDirectories = entries.filter((entry) => entry.isDirectory()).sort((left, right) => left.name.localeCompare(right.name));
    const rows: RunMetricsRow[] = [];

    for (const entry of runDirectories) {
      const metrics = await readCopilotRunMetrics(join(runLogDir, entry.name, "copilot", "session.json"));
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
        durationMs: metrics.apiDurationMs
      });
    }

    return rows;
  } catch {
    return [];
  }
}

function buildModelPremiumRequestsStatsRows(rows: RunMetricsRow[]): ModelPremiumRequestsStatsRow[] {
  const statsByModel = new Map<string, number[]>();

  for (const row of rows) {
    for (const metric of row.premiumRequestsByModel) {
      const current = statsByModel.get(metric.model) ?? [];
      current.push(metric.premiumRequests);
      statsByModel.set(metric.model, current);
    }
  }

  return [...statsByModel.entries()]
    .sort(
      (left, right) =>
        sum(left[1]) - sum(right[1]) === 0 ? left[0].localeCompare(right[0]) : sum(right[1]) - sum(left[1])
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
      p90: percentile(premiumRequests, 90)
    }));
}

function buildSummaryMetricsRows(rows: RunMetricsRow[]): SummaryMetricsRow[] {
  const premiumRequests = rows.map((row) => row.premiumRequests);
  const inputTokens = rows.map((row) => row.inputTokens);
  const outputTokens = rows.map((row) => row.outputTokens);
  const toolCalls = rows.map((row) => row.toolCalls);
  const durationMs = rows.map((row) => row.durationMs);

  return [
    createSummaryMetricsRow("min", premiumRequests, inputTokens, outputTokens, toolCalls, durationMs, minimum),
    createSummaryMetricsRow("max", premiumRequests, inputTokens, outputTokens, toolCalls, durationMs, maximum),
    createSummaryMetricsRow("avg", premiumRequests, inputTokens, outputTokens, toolCalls, durationMs, average),
    createSummaryMetricsRow("p50", premiumRequests, inputTokens, outputTokens, toolCalls, durationMs, (values) => percentile(values, 50)),
    createSummaryMetricsRow("p25", premiumRequests, inputTokens, outputTokens, toolCalls, durationMs, (values) => percentile(values, 25)),
    createSummaryMetricsRow("p75", premiumRequests, inputTokens, outputTokens, toolCalls, durationMs, (values) => percentile(values, 75)),
    createSummaryMetricsRow("p90", premiumRequests, inputTokens, outputTokens, toolCalls, durationMs, (values) => percentile(values, 90))
  ];
}

function createSummaryMetricsRow(
  stat: string,
  premiumRequests: number[],
  inputTokens: number[],
  outputTokens: number[],
  toolCalls: number[],
  durationMs: number[],
  aggregate: (values: number[]) => number
): SummaryMetricsRow {
  return {
    stat,
    premiumRequests: aggregate(premiumRequests),
    inputTokens: aggregate(inputTokens),
    outputTokens: aggregate(outputTokens),
    toolCalls: aggregate(toolCalls),
    durationMs: aggregate(durationMs)
  };
}

function formatRunMetricsTable(rows: RunMetricsRow[]): string {
  return formatTable(["run", "premiumRequests", "inputTokens", "outputTokens", "toolCalls", "durationMs"], rows.map((row) => [
    row.run,
    row.premiumRequests,
    row.inputTokens,
    row.outputTokens,
    row.toolCalls,
    row.durationMs
  ]));
}

function formatSummaryMetricsTable(rows: SummaryMetricsRow[]): string {
  return formatTable(["stat", "premiumRequests", "inputTokens", "outputTokens", "toolCalls", "durationMs"], rows.map((row) => [
    row.stat,
    row.premiumRequests,
    row.inputTokens,
    row.outputTokens,
    row.toolCalls,
    row.durationMs
  ]));
}

function formatModelPremiumRequestsStatsTable(rows: ModelPremiumRequestsStatsRow[]): string {
  return formatTable(["model", "runs", "premiumRequests", "min", "max", "avg", "p25", "p50", "p75", "p90"], rows.map((row) => [
    row.model,
    row.runs,
    row.premiumRequests,
    row.min,
    row.max,
    row.avg,
    row.p25,
    row.p50,
    row.p75,
    row.p90
  ]));
}

function formatTable(headers: string[], rows: Array<Array<string | number>>): string {
  const widths = headers.map((header, columnIndex) => {
    const values = rows.map((row) => formatCellValue(row[columnIndex] ?? ""));
    return Math.max(header.length, ...values.map((value) => value.length));
  });
  const header = headers.map((label, index) => label.padEnd(widths[index] ?? 0)).join("  ");
  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  const body = rows.map((row) =>
    row
      .map((rawValue, index) => {
        const value = formatCellValue(rawValue);
        return typeof rawValue === "number" ? value.padStart(widths[index] ?? 0) : value.padEnd(widths[index] ?? 0);
      })
      .join("  ")
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

  return value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
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

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
