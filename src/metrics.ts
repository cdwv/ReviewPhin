import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { glob } from "glob";

import {
  COPILOT_NANO_AI_UNIT,
  summarizeHarnessSession,
} from "./harness/run-metrics.js";
import type { HarnessRunLogRecord } from "./harness/run-log.js";
import type {
  InteractionRunMetricsRecord,
  InteractionRunRecord,
  UsageByModelMetric,
} from "./storage/contract/index.js";
import { listAll, type StorageHelpers } from "./storage/storage-helpers.js";

export interface MetricsDateRange {
  from: string | null;
  toExclusive: string | null;
}

export interface MetricsSessionsFilters extends MetricsDateRange {
  connection: string | null;
}

export interface MetricsRunRow {
  interactionRunId: string;
  startedAt: string;
  sessions: number;
  usageAmount: number | null;
  promptChars: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  durationMs: number;
}

export interface MetricsSummaryRow {
  stat: string;
  usageAmount: number | null;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  durationMs: number;
}

export interface MetricsModelRow {
  model: string;
  reviews: number;
  usageAmount: number;
  averageCostPerReview: number;
}

export interface MetricsMonthlyModelRow {
  month: string;
  total: number;
  models: UsageByModelMetric[];
}

export interface MetricsSessionTypeRow {
  sessionType: string;
  sessions: number;
  usageAmount: number | null;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface MetricsUnitGroup {
  unit: string | null;
  runs: MetricsRunRow[];
  summary: MetricsSummaryRow[];
  models: MetricsModelRow[];
  monthly: MetricsMonthlyModelRow[];
  sessionTypes: MetricsSessionTypeRow[];
}

export interface MetricsSessionsResult {
  filters: MetricsSessionsFilters;
  units: MetricsUnitGroup[];
}

export interface MetricsCollectResult {
  runLogDirectory: string;
  dryRun: boolean;
  files: number;
  imported: number;
  updated: number;
  unchanged: number;
  skipped: number;
  invalid: number;
}

export function parseMetricsDateRange(input: {
  from?: string | boolean | undefined;
  to?: string | boolean | undefined;
}): MetricsDateRange {
  const from = parseCalendarDate(input.from, "--from");
  const to = parseCalendarDate(input.to, "--to");
  const toExclusive = to ? addUtcDays(to, 1) : null;
  if (from && toExclusive && from >= toExclusive) {
    throw new Error("--from must not be after --to");
  }
  return { from, toExclusive };
}

export async function loadMetricsSessions(
  storage: StorageHelpers,
  filters: MetricsSessionsFilters,
): Promise<MetricsSessionsResult> {
  let tenantIds: string[] | null = null;
  if (filters.connection) {
    const connection = await storage.stores.platformConnections.find({
      name: { eq: filters.connection },
    });
    if (!connection) {
      throw new Error(`Unknown platform connection ${filters.connection}`);
    }
    const tenants = await listAll(storage.stores.tenants, {
      filters: { platformConnectionId: { eq: connection.id } },
    });
    tenantIds = tenants.map((tenant) => tenant.id);
    if (tenantIds.length === 0) {
      return { filters, units: [] };
    }
  }

  const startedAt = {
    ...(filters.from ? { gte: filters.from } : {}),
    ...(filters.toExclusive ? { lt: filters.toExclusive } : {}),
  };
  const runs = await listAll(storage.stores.interactionRuns, {
    filters: {
      ...(tenantIds ? { tenantId: { in: tenantIds } } : {}),
      ...(Object.keys(startedAt).length > 0 ? { startedAt } : {}),
    },
    order: [
      { field: "startedAt", direction: "asc" },
      { field: "id", direction: "asc" },
    ],
  });
  if (runs.length === 0) {
    return { filters, units: [] };
  }

  const metrics: InteractionRunMetricsRecord[] = [];
  for (let offset = 0; offset < runs.length; offset += 100) {
    metrics.push(
      ...(await listAll(storage.stores.interactionRunMetrics, {
        filters: {
          interactionRunId: {
            in: runs.slice(offset, offset + 100).map((run) => run.id),
          },
        },
        order: [
          { field: "interactionRunId", direction: "asc" },
          { field: "id", direction: "asc" },
        ],
      })),
    );
  }

  return { filters, units: buildUnitGroups(runs, metrics) };
}

export async function collectMetrics(
  storage: StorageHelpers,
  input: { runLogDirectory: string; dryRun: boolean },
): Promise<MetricsCollectResult> {
  const runLogDirectory = resolve(input.runLogDirectory);
  const paths = (
    await glob("**/session.json", {
      cwd: runLogDirectory,
      absolute: true,
      nodir: true,
    })
  ).sort((left, right) => left.localeCompare(right));
  const result: MetricsCollectResult = {
    runLogDirectory,
    dryRun: input.dryRun,
    files: paths.length,
    imported: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    invalid: 0,
  };

  for (const path of paths) {
    let record: HarnessRunLogRecord;
    try {
      record = JSON.parse(await readFile(path, "utf8")) as HarnessRunLogRecord;
    } catch {
      result.invalid += 1;
      continue;
    }
    let envelope;
    let interactionRunId: string | null | undefined;
    try {
      envelope = summarizeHarnessSession(record);
      interactionRunId = record.metadata?.interactionRunId;
    } catch {
      result.invalid += 1;
      continue;
    }
    if (!envelope || !interactionRunId) {
      result.skipped += 1;
      continue;
    }
    if (!(await storage.stores.interactionRuns.get(interactionRunId))) {
      result.skipped += 1;
      continue;
    }

    const existing = await storage.stores.interactionRunMetrics.find({
      interactionRunId: { eq: interactionRunId },
      harness: { eq: envelope.harness },
      harnessSessionKey: { eq: envelope.harnessSessionKey },
    });
    const sessionType =
      envelope.sessionType === "unknown"
        ? inferLegacySessionType(relative(runLogDirectory, path))
        : envelope.sessionType;
    const metrics = envelope.metrics;
    const value = {
      interactionRunId,
      harness: envelope.harness,
      harnessSessionKey: envelope.harnessSessionKey,
      sessionType,
      triggerKind: existing?.triggerKind ?? null,
      promptMode: existing?.promptMode ?? sessionType,
      promptChars: metrics.promptChars,
      promptContextChangedFiles: existing?.promptContextChangedFiles ?? 0,
      promptContextPriorDiscussions:
        existing?.promptContextPriorDiscussions ?? 0,
      promptContextComments: existing?.promptContextComments ?? 0,
      assistantTurns: metrics.assistantTurns,
      assistantCalls: metrics.assistantCalls,
      toolExecutions: metrics.toolExecutions,
      viewToolCalls: metrics.viewToolCalls,
      globToolCalls: metrics.globToolCalls,
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      cacheReadTokens: metrics.cacheReadTokens,
      cacheWriteTokens: metrics.cacheWriteTokens,
      reasoningTokens: metrics.reasoningTokens,
      apiDurationMs: metrics.apiDurationMs,
      usageUnit: metrics.usageUnit,
      usageAmount: metrics.usageAmount,
      usageByModelJson: JSON.stringify(metrics.usageByModel),
      repeatedViewReads: metrics.repeatedViewReads,
      repeatedViewPathsJson: JSON.stringify(metrics.repeatedViewPaths),
    };
    if (existing && metricsRecordEquals(existing, value)) {
      result.unchanged += 1;
      continue;
    }
    if (!input.dryRun) {
      await storage.upsertInteractionRunMetrics(value);
    }
    if (existing) {
      result.updated += 1;
    } else {
      result.imported += 1;
    }
  }

  return result;
}

function inferLegacySessionType(path: string): string {
  const segments = path
    .replaceAll("\\", "/")
    .toLowerCase()
    .split("/")
    .filter(Boolean);
  if (segments.includes("memory-consolidation")) {
    return "memory-consolidation";
  }
  if (segments.includes("reviewer")) {
    return "review";
  }
  if (segments.includes("memory")) {
    return "memory";
  }
  if (segments.includes("reply")) {
    return "reply";
  }
  return "unknown";
}

export function formatUsageAmount(
  unit: string | null,
  amount: number | null,
): string {
  if (amount === null) {
    return "~";
  }
  const display =
    unit === COPILOT_NANO_AI_UNIT ? amount / 1_000_000_000 : amount;
  return Number.isInteger(display)
    ? String(display)
    : display.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

export function displayUsageUnit(unit: string | null): string {
  return unit === COPILOT_NANO_AI_UNIT
    ? "github.copilot.ai-credit"
    : (unit ?? "usage not reported");
}

function buildUnitGroups(
  runs: InteractionRunRecord[],
  metrics: InteractionRunMetricsRecord[],
): MetricsUnitGroup[] {
  const runById = new Map(runs.map((run) => [run.id, run]));
  const byUnit = new Map<string | null, InteractionRunMetricsRecord[]>();
  for (const metric of metrics) {
    const values = byUnit.get(metric.usageUnit) ?? [];
    values.push(metric);
    byUnit.set(metric.usageUnit, values);
  }
  return [...byUnit.entries()]
    .sort(([left], [right]) =>
      left === null ? 1 : right === null ? -1 : left.localeCompare(right),
    )
    .map(([unit, unitMetrics]) => buildUnitGroup(unit, unitMetrics, runById));
}

function buildUnitGroup(
  unit: string | null,
  metrics: InteractionRunMetricsRecord[],
  runById: Map<string, InteractionRunRecord>,
): MetricsUnitGroup {
  const groupedRuns = new Map<string, InteractionRunMetricsRecord[]>();
  for (const metric of metrics) {
    const values = groupedRuns.get(metric.interactionRunId) ?? [];
    values.push(metric);
    groupedRuns.set(metric.interactionRunId, values);
  }
  const runs = [...groupedRuns.entries()]
    .map(([interactionRunId, sessions]): MetricsRunRow | null => {
      const run = runById.get(interactionRunId);
      if (!run) return null;
      return {
        interactionRunId,
        startedAt: run.startedAt,
        sessions: sessions.length,
        usageAmount:
          unit === null
            ? null
            : sum(sessions.map((row) => row.usageAmount ?? 0)),
        promptChars: sum(sessions.map((row) => row.promptChars)),
        inputTokens: sum(sessions.map((row) => row.inputTokens)),
        outputTokens: sum(sessions.map((row) => row.outputTokens)),
        toolCalls: sum(sessions.map((row) => row.toolExecutions)),
        durationMs: sum(sessions.map((row) => row.apiDurationMs)),
      };
    })
    .filter((row): row is MetricsRunRow => row !== null)
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));

  return {
    unit,
    runs,
    summary: buildSummary(runs),
    models: buildModels(metrics),
    monthly: buildMonthly(metrics, runById),
    sessionTypes: buildSessionTypes(metrics),
  };
}

function buildSummary(rows: MetricsRunRow[]): MetricsSummaryRow[] {
  const stats: Array<[string, (values: number[]) => number]> = [
    ["min", minimum],
    ["max", maximum],
    ["avg", average],
    ["p25", (values) => percentile(values, 25)],
    ["p50", (values) => percentile(values, 50)],
    ["p75", (values) => percentile(values, 75)],
    ["p90", (values) => percentile(values, 90)],
  ];
  return stats.map(([stat, aggregate]) => ({
    stat,
    usageAmount: rows.some((row) => row.usageAmount !== null)
      ? aggregate(rows.map((row) => row.usageAmount ?? 0))
      : null,
    inputTokens: aggregate(rows.map((row) => row.inputTokens)),
    outputTokens: aggregate(rows.map((row) => row.outputTokens)),
    toolCalls: aggregate(rows.map((row) => row.toolCalls)),
    durationMs: aggregate(rows.map((row) => row.durationMs)),
  }));
}

function buildModels(
  metrics: InteractionRunMetricsRecord[],
): MetricsModelRow[] {
  const amounts = new Map<string, Map<string, number>>();
  for (const metric of metrics) {
    for (const model of parseModelUsage(metric.usageByModelJson)) {
      const byRun = amounts.get(model.model) ?? new Map<string, number>();
      byRun.set(
        metric.interactionRunId,
        (byRun.get(metric.interactionRunId) ?? 0) + model.amount,
      );
      amounts.set(model.model, byRun);
    }
  }
  return [...amounts.entries()]
    .map(([model, byRun]) => {
      const usageAmount = sum([...byRun.values()]);
      return {
        model,
        reviews: byRun.size,
        usageAmount,
        averageCostPerReview: byRun.size === 0 ? 0 : usageAmount / byRun.size,
      };
    })
    .sort(
      (left, right) =>
        right.usageAmount - left.usageAmount ||
        left.model.localeCompare(right.model),
    );
}

function buildMonthly(
  metrics: InteractionRunMetricsRecord[],
  runById: Map<string, InteractionRunRecord>,
): MetricsMonthlyModelRow[] {
  const months = new Map<string, Map<string, number>>();
  for (const metric of metrics) {
    const month = runById.get(metric.interactionRunId)?.startedAt.slice(0, 7);
    if (!month) continue;
    const values = months.get(month) ?? new Map<string, number>();
    for (const model of parseModelUsage(metric.usageByModelJson)) {
      values.set(model.model, (values.get(model.model) ?? 0) + model.amount);
    }
    months.set(month, values);
  }
  return [...months.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([month, values]) => ({
      month,
      total: sum([...values.values()]),
      models: [...values.entries()]
        .map(([model, amount]) => ({ model, amount }))
        .sort(
          (left, right) =>
            right.amount - left.amount || left.model.localeCompare(right.model),
        ),
    }));
}

function buildSessionTypes(
  metrics: InteractionRunMetricsRecord[],
): MetricsSessionTypeRow[] {
  const groups = new Map<string, InteractionRunMetricsRecord[]>();
  for (const metric of metrics) {
    const values = groups.get(metric.sessionType) ?? [];
    values.push(metric);
    groups.set(metric.sessionType, values);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sessionType, values]) => ({
      sessionType,
      sessions: values.length,
      usageAmount: values.some((value) => value.usageAmount !== null)
        ? sum(values.map((value) => value.usageAmount ?? 0))
        : null,
      inputTokens: sum(values.map((value) => value.inputTokens)),
      outputTokens: sum(values.map((value) => value.outputTokens)),
      durationMs: sum(values.map((value) => value.apiDurationMs)),
    }));
}

function parseModelUsage(value: string): UsageByModelMetric[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is UsageByModelMetric =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as UsageByModelMetric).model === "string" &&
        typeof (entry as UsageByModelMetric).amount === "number",
    );
  } catch {
    return [];
  }
}

function metricsRecordEquals(
  existing: InteractionRunMetricsRecord,
  value: Omit<InteractionRunMetricsRecord, "id" | "createdAt" | "updatedAt">,
): boolean {
  return Object.entries(value).every(
    ([key, entry]) =>
      existing[key as keyof InteractionRunMetricsRecord] === entry,
  );
}

function parseCalendarDate(
  value: string | boolean | undefined,
  option: string,
): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${option} requires YYYY-MM-DD`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(date.valueOf()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${option} is not a valid calendar date`);
  }
  return date.toISOString();
}

function addUtcDays(value: string, days: number): string {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function minimum(values: number[]): number {
  return values.length === 0 ? 0 : Math.min(...values);
}

function maximum(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function percentile(values: number[], requested: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (requested / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower] ?? 0;
  const weight = index - lower;
  return (sorted[lower] ?? 0) * (1 - weight) + (sorted[upper] ?? 0) * weight;
}
