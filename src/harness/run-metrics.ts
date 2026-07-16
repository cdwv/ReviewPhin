import type { HarnessRunLogRecord } from "./run-log.js";
import type {
  HarnessRunMetricsSummary,
  HarnessSessionMetricsEnvelope,
  HarnessUsageByModelMetric,
} from "./types.js";

export const COPILOT_HARNESS = "github.copilot-sdk";
export const COPILOT_NANO_AI_UNIT = "github.copilot.nano-ai-unit";
export const COPILOT_PREMIUM_REQUEST_UNIT = "github.copilot.premium-request";

export function summarizeHarnessSession(
  record: HarnessRunLogRecord,
  options?: SummarizeHarnessMetricsOptions,
): HarnessSessionMetricsEnvelope | null {
  if (!record.sessionId) {
    return null;
  }
  return {
    harness: COPILOT_HARNESS,
    harnessSessionKey: record.sessionId,
    sessionType: record.metadata.sessionKind?.trim() || "unknown",
    metrics: summarizeHarnessRunLog(record, options),
  };
}

export interface SummarizeHarnessMetricsOptions {
  readonly includeLegacyPremiumRequestCost?: boolean;
}

export function summarizeHarnessRunLog(
  record: Pick<HarnessRunLogRecord, "prompt" | "events"> & {
    metadata?: Partial<HarnessRunLogRecord["metadata"]> | undefined;
  },
  options?: SummarizeHarnessMetricsOptions,
): HarnessRunMetricsSummary {
  const assistantUsages = record.events.filter(
    (event) => event.type === "assistant.usage",
  );
  const assistantTurns = record.events.filter(
    (event) => event.type === "assistant.turn_start",
  ).length;
  const toolExecutions = record.events.filter(
    (event) => event.type === "tool.execution_start",
  );
  const viewCalls = toolExecutions.filter(
    (event) => event.data?.toolName === "view",
  );
  const globCalls = toolExecutions.filter(
    (event) => event.data?.toolName === "glob",
  );
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
    .sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )
    .slice(0, 10)
    .map(([path, count]) => ({ path, count }));

  const usage = summarizeUsage(
    assistantUsages,
    record.metadata?.requestedModel,
    options?.includeLegacyPremiumRequestCost ?? true,
  );
  return {
    promptChars: record.prompt.length,
    assistantTurns:
      assistantTurns > 0 ? assistantTurns : assistantUsages.length,
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
    ...usage,
    repeatedViewReads: repeatedViewPaths.reduce(
      (total, entry) => total + (entry.count - 1),
      0,
    ),
    repeatedViewPaths,
  };
}

function summarizeUsage(
  usages: Array<{
    data?: {
      model?: string | null;
      cost?: number | undefined;
      copilotUsage?: { totalNanoAiu: number } | undefined;
    };
  }>,
  fallbackModel: string | null | undefined,
  includeLegacyPremiumRequestCost: boolean,
): Pick<
  HarnessRunMetricsSummary,
  "usageUnit" | "usageAmount" | "usageByModel"
> {
  const hasNanoAiu = usages.some(
    (usage) => typeof usage.data?.copilotUsage?.totalNanoAiu === "number",
  );
  if (hasNanoAiu) {
    return summarizeUsageUnit(
      usages,
      COPILOT_NANO_AI_UNIT,
      (usage) => usage.data?.copilotUsage?.totalNanoAiu,
      fallbackModel,
    );
  }
  const hasPremiumRequests =
    includeLegacyPremiumRequestCost &&
    usages.some((usage) => typeof usage.data?.cost === "number");
  if (hasPremiumRequests) {
    return summarizeUsageUnit(
      usages,
      COPILOT_PREMIUM_REQUEST_UNIT,
      (usage) => usage.data?.cost,
      fallbackModel,
    );
  }
  return { usageUnit: null, usageAmount: null, usageByModel: [] };
}

function summarizeUsageUnit<
  TUsage extends { data?: { model?: string | null } },
>(
  usages: TUsage[],
  usageUnit: string,
  getAmount: (usage: TUsage) => number | undefined,
  fallbackModel: string | null | undefined,
): Pick<
  HarnessRunMetricsSummary,
  "usageUnit" | "usageAmount" | "usageByModel"
> {
  const totals = new Map<string, number>();
  let usageAmount = 0;

  for (const usage of usages) {
    const amount = getAmount(usage);
    if (typeof amount !== "number") {
      continue;
    }
    usageAmount += amount;
    const model =
      normalizeModel(usage.data?.model) ??
      normalizeModel(fallbackModel) ??
      "unknown";
    totals.set(model, (totals.get(model) ?? 0) + amount);
  }

  const usageByModel: HarnessUsageByModelMetric[] = [...totals.entries()]
    .sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )
    .map(([model, amount]) => ({ model, amount }));
  return { usageUnit, usageAmount, usageByModel };
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
    | "cost",
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
