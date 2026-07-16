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

const numberField = (label: string, helpText: string) => ({
  type: "number" as const,
  label,
  required: true,
  helpText,
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
      helpText: "Interaction run measured by this record.",
    },
    harness: {
      type: "string",
      label: "Harness",
      required: identityRequired,
      readonly: true,
      partOfTitle: true,
      helpText: "Harness implementation that produced this session.",
    },
    harnessSessionKey: {
      type: "string",
      label: "Harness Session Key",
      required: identityRequired,
      readonly: true,
      partOfTitle: true,
      helpText: "Stable harness-native session identity.",
    },
    sessionType: {
      type: "string",
      label: "Session Type",
      required: identityRequired,
      readonly: true,
      helpText: "Open session type reported by the harness.",
    },
    triggerKind: {
      type: "string",
      label: "Trigger Kind",
      required: false,
      helpText:
        "Kind of event that initiated the measured run. Editing changes reporting metadata.",
    },
    promptMode: {
      type: "string",
      label: "Prompt Mode",
      required: false,
      helpText:
        "Prompt construction mode used for the run. Editing changes reporting metadata.",
    },
    promptChars: numberField("Prompt Chars", "Prompt size in characters."),
    promptContextChangedFiles: numberField(
      "Prompt Context Changed Files",
      "Number of changed files included in prompt context.",
    ),
    promptContextPriorDiscussions: numberField(
      "Prompt Context Prior Discussions",
      "Number of prior discussions included in prompt context.",
    ),
    promptContextComments: numberField(
      "Prompt Context Comments",
      "Number of comments included in prompt context.",
    ),
    assistantTurns: numberField(
      "Assistant Turns",
      "Number of assistant turns recorded for the run.",
    ),
    assistantCalls: numberField(
      "Assistant Calls",
      "Number of assistant API calls recorded for the run.",
    ),
    toolExecutions: numberField(
      "Tool Executions",
      "Total tool executions recorded for the run.",
    ),
    viewToolCalls: numberField(
      "View Tool Calls",
      "Number of file-view tool calls recorded for the run.",
    ),
    globToolCalls: numberField(
      "Glob Tool Calls",
      "Number of file-glob tool calls recorded for the run.",
    ),
    inputTokens: numberField(
      "Input Tokens",
      "Provider-reported input token count.",
    ),
    outputTokens: numberField(
      "Output Tokens",
      "Provider-reported output token count.",
    ),
    cacheReadTokens: numberField(
      "Cache Read Tokens",
      "Provider-reported cache read token count.",
    ),
    cacheWriteTokens: numberField(
      "Cache Write Tokens",
      "Provider-reported cache write token count.",
    ),
    reasoningTokens: numberField(
      "Reasoning Tokens",
      "Provider-reported reasoning token count.",
    ),
    apiDurationMs: numberField(
      "API Duration Ms",
      "Total provider API duration in milliseconds.",
    ),
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
      helpText: "Amount expressed in usageUnit.",
    },
    usageByModelJson: {
      type: "string",
      label: "Usage By Model JSON",
      required: identityRequired,
      inputType: "textarea",
      helpText: "Per-model usage amounts encoded as JSON.",
    },
    repeatedViewReads: numberField(
      "Repeated View Reads",
      "Number of repeated file reads detected during the run.",
    ),
    repeatedViewPathsJson: {
      type: "string",
      label: "Repeated View Paths JSON",
      required: true,
      inputType: "textarea",
      helpText: "Repeatedly viewed file paths encoded as JSON for diagnostics.",
    },
  };
  if (includeLegacyPremiumRequests) {
    fields.premiumRequests = numberField(
      "Premium Requests",
      "Provider-reported premium request count.",
    );
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
        usageByModelJson: JSON.stringify([
          { model: "unknown", amount: metric.premiumRequests ?? 0 },
        ]),
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
