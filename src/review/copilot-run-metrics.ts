import { readFile } from "node:fs/promises";

import type { CopilotRunLogRecord } from "./copilot-run-log.js";

export interface RepeatedViewPathMetric {
  path: string;
  count: number;
}

export interface PremiumRequestsByModelMetric {
  model: string;
  premiumRequests: number;
}

export interface CopilotRunMetricsSummary {
  promptChars: number;
  assistantTurns: number;
  assistantCalls: number;
  toolExecutions: number;
  viewToolCalls: number;
  globToolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  apiDurationMs: number;
  premiumRequests: number;
  premiumRequestsByModel: PremiumRequestsByModelMetric[];
  repeatedViewReads: number;
  repeatedViewPaths: RepeatedViewPathMetric[];
}

export async function readCopilotRunMetrics(logPath: string): Promise<CopilotRunMetricsSummary | null> {
  try {
    const raw = await readFile(logPath, "utf8");
    return summarizeCopilotRunLog(JSON.parse(raw) as CopilotRunLogRecord);
  } catch {
    return null;
  }
}

export function summarizeCopilotRunLog(
  record: Pick<CopilotRunLogRecord, "prompt" | "events" | "metadata">
): CopilotRunMetricsSummary {
  const assistantUsages = record.events.filter((event) => event.type === "assistant.usage");
  const assistantTurns = record.events.filter((event) => event.type === "assistant.turn_start").length;
  const toolExecutions = record.events.filter((event) => event.type === "tool.execution_start");
  const viewCalls = toolExecutions.filter((event) => event.data?.toolName === "view");
  const globCalls = toolExecutions.filter((event) => event.data?.toolName === "glob");
  const viewCounts = new Map<string, number>();

  for (const event of viewCalls) {
    const path = event.data?.arguments?.path;
    if (typeof path !== "string" || path.length === 0) {
      continue;
    }
    viewCounts.set(path, (viewCounts.get(path) ?? 0) + 1);
  }

  const repeatedViewPaths = [...viewCounts.entries()]
    .filter(([, count]) => count > 1)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 10)
    .map(([path, count]) => ({ path, count }));

  return {
    promptChars: record.prompt.length,
    assistantTurns: assistantTurns > 0 ? assistantTurns : assistantUsages.length,
    assistantCalls: assistantUsages.length,
    toolExecutions: toolExecutions.length,
    viewToolCalls: viewCalls.length,
    globToolCalls: globCalls.length,
    inputTokens: sumUsageMetric(assistantUsages, "inputTokens"),
    outputTokens: sumUsageMetric(assistantUsages, "outputTokens"),
    cacheReadTokens: sumUsageMetric(assistantUsages, "cacheReadTokens"),
    cacheWriteTokens: sumUsageMetric(assistantUsages, "cacheWriteTokens"),
    reasoningTokens: sumUsageMetric(assistantUsages, "reasoningTokens"),
    apiDurationMs: sumUsageMetric(assistantUsages, "duration"),
    premiumRequests: sumUsageMetric(assistantUsages, "cost"),
    premiumRequestsByModel: summarizePremiumRequestsByModel(assistantUsages, record.metadata.requestedModel),
    repeatedViewReads: repeatedViewPaths.reduce((total, entry) => total + (entry.count - 1), 0),
    repeatedViewPaths
  };
}

function summarizePremiumRequestsByModel(
  usages: Array<{ data?: { model?: string | null; cost?: number | undefined } }>,
  fallbackModel: string | null
): PremiumRequestsByModelMetric[] {
  const totals = new Map<string, number>();

  for (const usage of usages) {
    const premiumRequests = typeof usage.data?.cost === "number" ? usage.data.cost : 0;
    if (premiumRequests <= 0) {
      continue;
    }

    const model = normalizeModel(usage.data?.model) ?? normalizeModel(fallbackModel) ?? "unknown";
    totals.set(model, (totals.get(model) ?? 0) + premiumRequests);
  }

  return [...totals.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([model, premiumRequests]) => ({ model, premiumRequests }));
}

function normalizeModel(model: string | null | undefined): string | null {
  if (typeof model !== "string") {
    return null;
  }

  const normalizedModel = model.trim();
  return normalizedModel.length > 0 ? normalizedModel : null;
}

function sumUsageMetric(
  usages: Array<{ data?: { [key in MetricKey]?: number | undefined } }>,
  key:
    | "inputTokens"
    | "outputTokens"
    | "cacheReadTokens"
    | "cacheWriteTokens"
    | "reasoningTokens"
    | "duration"
    | "cost"
): number {
  return usages.reduce((total, usage) => {
    const value = usage.data?.[key];
    return total + (typeof value === "number" ? value : 0);
  }, 0);
}

type MetricKey =
  | "inputTokens"
  | "outputTokens"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "reasoningTokens"
  | "duration"
  | "cost";
