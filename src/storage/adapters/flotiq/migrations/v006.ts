import type {
  BaseBatchResponse,
  Flotiq,
  InteractionRunMetrics,
} from "@flotiq/flotiq-api-sdk";
import type { Logger } from "pino";

import {
  generateCtdFromFieldsDescriptor,
  type CtdDefinition,
  type FieldsDescriptor,
} from "../flotiq-ctd-builder.js";
import {
  createCtd,
  ctdNeedsUpdate,
  fetchExistingCtd,
  updateCtd,
} from "./migration-helpers.js";

const PAGE_SIZE = 100;
const BATCH_SIZE = 100;

const numberField = (label: string) => ({
  type: "number" as const,
  label,
  required: true,
});

function createMetricsCtd(
  identityRequired: boolean,
  includeLegacyPremiumRequests: boolean,
): CtdDefinition {
  const fields: FieldsDescriptor = {
    interactionRunId: {
      type: "datasource",
      label: "Interaction Run ID",
      required: true,
      relationContentType: "interaction_run",
      readonly: true,
    },
    harness: {
      type: "string",
      label: "Harness",
      required: identityRequired,
      readonly: true,
      partOfTitle: true,
    },
    harnessSessionKey: {
      type: "string",
      label: "Harness Session Key",
      required: identityRequired,
      readonly: true,
      partOfTitle: true,
    },
    sessionType: {
      type: "string",
      label: "Session Type",
      required: identityRequired,
      readonly: true,
    },
    triggerKind: {
      type: "string",
      label: "Trigger Kind",
      required: false,
    },
    promptMode: {
      type: "string",
      label: "Prompt Mode",
      required: false,
    },
    promptChars: numberField("Prompt Chars"),
    promptContextChangedFiles: numberField("Prompt Context Changed Files"),
    promptContextPriorDiscussions: numberField(
      "Prompt Context Prior Discussions",
    ),
    promptContextComments: numberField("Prompt Context Comments"),
    assistantTurns: numberField("Assistant Turns"),
    assistantCalls: numberField("Assistant Calls"),
    toolExecutions: numberField("Tool Executions"),
    viewToolCalls: numberField("View Tool Calls"),
    globToolCalls: numberField("Glob Tool Calls"),
    inputTokens: numberField("Input Tokens"),
    outputTokens: numberField("Output Tokens"),
    cacheReadTokens: numberField("Cache Read Tokens"),
    cacheWriteTokens: numberField("Cache Write Tokens"),
    reasoningTokens: numberField("Reasoning Tokens"),
    apiDurationMs: numberField("API Duration Ms"),
    usageUnit: {
      type: "string",
      label: "Usage Unit",
      required: false,
      helpText: "Open namespaced unit key reported by the harness.",
    },
    usageAmount: {
      type: "number",
      label: "Usage Amount",
      required: false,
    },
    usageByModelJson: {
      type: "string",
      label: "Usage By Model JSON",
      required: identityRequired,
      inputType: "textarea",
    },
    repeatedViewReads: numberField("Repeated View Reads"),
    repeatedViewPathsJson: {
      type: "string",
      label: "Repeated View Paths JSON",
      required: true,
      inputType: "textarea",
    },
  };
  if (includeLegacyPremiumRequests) {
    fields.premiumRequests = numberField("Premium Requests");
  }
  return generateCtdFromFieldsDescriptor(
    "interaction_run_metrics",
    "Run History/Interaction Run Metrics",
    fields,
  );
}

export default async function ensureV006CtdsExist(
  apiKey: string,
  flotiqClient: Flotiq,
  logger?: Logger,
): Promise<void> {
  if (!apiKey) {
    throw new Error("FLOTIQ_API_KEY is required for the v006 migration");
  }

  await applyCtd(createMetricsCtd(false, true), apiKey, logger);
  await backfillMetrics(flotiqClient, logger);
  await applyCtd(createMetricsCtd(true, false), apiKey, logger);
}

async function applyCtd(
  ctd: CtdDefinition,
  apiKey: string,
  logger?: Logger,
): Promise<void> {
  const existing = await fetchExistingCtd(ctd.name, apiKey, logger);
  if (!existing) {
    await createCtd(ctd, apiKey, logger);
  } else if (ctdNeedsUpdate(existing, ctd)) {
    await updateCtd(ctd.name, ctd, apiKey, logger);
  }
}

type LegacyMetrics = InteractionRunMetrics & {
  premiumRequests?: number;
  harness?: string;
  harnessSessionKey?: string;
  sessionType?: string;
  usageUnit?: string;
  usageAmount?: number;
  usageByModelJson?: string;
};

async function backfillMetrics(
  flotiqClient: Flotiq,
  logger?: Logger,
): Promise<void> {
  const pending: LegacyMetrics[] = [];
  for (let page = 1; ; page += 1) {
    const response = await flotiqClient.content.interaction_run_metrics.list({
      page,
      limit: PAGE_SIZE,
    });
    pending.push(
      ...(response.data as LegacyMetrics[]).filter(
        (metric) => !metric.harnessSessionKey,
      ),
    );
    if (page >= response.total_pages) {
      break;
    }
  }

  for (let offset = 0; offset < pending.length; offset += BATCH_SIZE) {
    const batch = pending.slice(offset, offset + BATCH_SIZE).map((metric) => {
      const { internal: _internal, ...value } = metric;
      return {
        ...value,
        harness: "github.copilot-sdk",
        harnessSessionKey: `legacy:${metric.id}`,
        sessionType: "unknown",
        usageUnit: "github.copilot.premium-request",
        usageAmount: metric.premiumRequests ?? 0,
        usageByModelJson: "[]",
      };
    });
    const result =
      await flotiqClient.content.interaction_run_metrics.batchUpdate(batch);
    assertSuccessfulBatch(result, "interaction run metrics v006 backfill");
  }

  logger?.info(
    { migratedMetricsCount: pending.length },
    "Flotiq v006 session metrics backfill completed",
  );
}

function assertSuccessfulBatch(
  result: BaseBatchResponse<InteractionRunMetrics>,
  operation: string,
): void {
  if (result.batch_error_count > 0) {
    throw new Error(
      `Flotiq ${operation} failed for ${result.batch_error_count} record(s)`,
    );
  }
}
