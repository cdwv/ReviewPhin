import type {
  Flotiq,
  InteractionJob,
  BaseBatchResponse,
} from "@flotiq/flotiq-api-sdk";
import type { Logger } from "pino";

import {
  generateCtdFromFieldsDescriptor,
  type CtdDefinition,
} from "../flotiq-ctd-builder.js";
import {
  createCtd,
  ctdNeedsUpdate,
  fetchExistingCtd,
  updateCtd,
} from "./migration-helpers.js";

const PAGE_SIZE = 100;
const BATCH_SIZE = 100;

const REASONING_EFFORT_VALUES = ["low", "medium", "high", "xhigh"];

const createModelProfileCtd = () =>
  generateCtdFromFieldsDescriptor("model_profile", "Config/Model Profile", {
    name: {
      type: "string",
      label: "Name",
      required: true,
      partOfTitle: true,
      readonly: true,
      helpText: "Stable profile name used by tenants.",
    },
    providerBaseUrl: {
      type: "string",
      label: "Provider Base URL",
      required: false,
      helpText:
        "Absolute provider API URL. Leave empty for native Copilot access.",
    },
    providerType: {
      type: "string",
      label: "Provider Type",
      required: false,
      allowedValues: ["openai", "azure", "anthropic"],
      default: "openai",
      helpText: "API compatibility mode: openai, azure, or anthropic.",
    },
    authToken: {
      type: "string",
      label: "Auth Token",
      required: false,
      isPassword: true,
      helpText:
        "Provider credential or GitHub auth token that can access copilot.",
    },
    reviewModel: {
      type: "string",
      label: "Review Model",
      required: false,
      helpText: "Model used for reviews",
    },
    textGenerationModel: {
      type: "string",
      label: "Text Generation Model",
      required: false,
      helpText:
        "Optional model for responding to comments or generating memory entries.",
    },
    reviewReasoningEffort: {
      type: "string",
      label: "Review Reasoning Effort",
      required: false,
      allowedValues: REASONING_EFFORT_VALUES,
      helpText:
        "Optional reasoning effort for review sessions. Leave empty to use the harness default.",
    },
    textGenerationReasoningEffort: {
      type: "string",
      label: "Text Generation Reasoning Effort",
      required: false,
      allowedValues: REASONING_EFFORT_VALUES,
      helpText:
        "Optional reasoning effort for text-generation sessions. Leave empty to use the harness default.",
    },
    wireApi: {
      type: "string",
      label: "Wire API",
      required: false,
      allowedValues: ["completions", "responses"],
      default: "responses",
      helpText: "OpenAI-compatible request format: completions or responses.",
    },
    isDefault: {
      type: "boolean",
      label: "Is Default",
      required: true,
      helpText: "Used when a tenant has no explicit model profile.",
    },
  });

const createInteractionRunCtd = () =>
  generateCtdFromFieldsDescriptor(
    "interaction_run",
    "Run History/Interaction Run",
    {
      interactionJobId: {
        type: "datasource",
        label: "Interaction Job ID",
        required: true,
        relationContentType: "interaction_job",
        readonly: true,
      },
      tenantId: {
        type: "datasource",
        label: "Tenant ID",
        required: true,
        relationContentType: "tenant",
        readonly: true,
      },
      provider: {
        type: "string",
        label: "Provider",
        required: true,
        partOfTitle: true,
        readonly: true,
        helpText:
          "Resolved model provider recorded for this run. Editing changes historical metadata.",
      },
      model: {
        type: "string",
        label: "Model",
        required: false,
        partOfTitle: true,
        readonly: true,
        helpText:
          "Resolved review model recorded for this run. Editing changes historical metadata.",
      },
      modelProfileName: {
        type: "datasource",
        label: "Model Profile",
        required: false,
        relationContentType: "model_profile",
        readonly: true,
      },
      providerBaseUrl: {
        type: "string",
        label: "Provider Base URL",
        required: false,
        readonly: true,
        helpText: "Provider URL recorded for this run.",
      },
      providerType: {
        type: "string",
        label: "Provider Type",
        required: false,
        readonly: true,
        helpText: "Provider API type recorded for this run.",
      },
      textGenerationModel: {
        type: "string",
        label: "Text Generation Model",
        required: false,
        readonly: true,
        helpText: "Resolved text generation model for this run.",
      },
      status: {
        type: "string",
        label: "Status",
        required: true,
        allowedValues: ["in_progress", "completed", "failed", "cancelled"],
        helpText:
          "Run lifecycle state. Manual changes may affect history queries and recovery.",
      },
      resultJson: {
        type: "string",
        label: "Result JSON",
        required: false,
        inputType: "textarea",
        helpText:
          "Structured run result JSON. Invalid data can break history and review output.",
      },
      error: {
        type: "string",
        label: "Error",
        required: false,
        readonly: true,
      },
      startedAt: {
        type: "string",
        label: "Started At",
        required: true,
        readonly: true,
        helpText: "ISO 8601 timestamp recorded when model execution started.",
      },
      finishedAt: {
        type: "string",
        label: "Finished At",
        required: false,
        readonly: true,
      },
      interactionJobClaimToken: {
        type: "string",
        label: "Interaction Job Claim Token",
        required: false,
        readonly: true,
        helpText:
          "Claim token that owned the job attempt that created this run. Used for lease recovery.",
      },
      reviewReasoningEffort: {
        type: "string",
        label: "Review Reasoning Effort",
        required: false,
        allowedValues: REASONING_EFFORT_VALUES,
        readonly: true,
        helpText: "Resolved review reasoning effort recorded for this run.",
      },
      textGenerationReasoningEffort: {
        type: "string",
        label: "Text Generation Reasoning Effort",
        required: false,
        allowedValues: REASONING_EFFORT_VALUES,
        readonly: true,
        helpText:
          "Resolved text generation reasoning effort recorded for this run.",
      },
    },
  );

const createCodeReviewSnapshotCtd = () =>
  generateCtdFromFieldsDescriptor("code_review_snapshot", "Code Review/Snapshot", {
    interactionJobId: {
      type: "datasource",
      label: "Interaction Job ID",
      required: true,
      relationContentType: "interaction_job",
      readonly: true,
    },
    tenantId: {
      type: "datasource",
      label: "Tenant ID",
      required: true,
      relationContentType: "tenant",
      readonly: true,
    },
    codeReviewId: {
      type: "number",
      label: "Code Review ID",
      required: true,
      partOfTitle: true,
      readonly: true,
      helpText:
        "Platform-local merge request or pull request number represented by this snapshot.",
    },
    headSha: {
      type: "string",
      label: "Head SHA",
      required: true,
      partOfTitle: true,
      readonly: true,
      helpText:
        "Full commit SHA represented by this snapshot. Keep it consistent with snapshot JSON.",
    },
    codeReviewJson: {
      type: "string",
      label: "Code Review JSON",
      required: true,
      inputType: "textarea",
      helpText:
        "Normalized code review JSON. Changes alter the historical review context.",
    },
    versionsJson: {
      type: "string",
      label: "Versions JSON",
      required: true,
      inputType: "textarea",
      helpText:
        "Provider review versions JSON. Keep values consistent with the code review metadata.",
    },
    changesJson: {
      type: "string",
      label: "Changes JSON",
      required: true,
      inputType: "textarea",
      helpText:
        "Changed files and patches JSON used as review context. Invalid data can break replay.",
    },
    commentsJson: {
      type: "string",
      label: "Comments JSON",
      required: true,
      inputType: "textarea",
      helpText:
        "Review comments JSON used as historical context. Invalid data can break replay.",
    },
    discussionsJson: {
      type: "string",
      label: "Discussions JSON",
      required: true,
      inputType: "textarea",
      helpText:
        "Review discussions JSON used as historical context. Invalid data can break replay.",
    },
    instructionsJson: {
      type: "string",
      label: "Instructions JSON",
      required: true,
      inputType: "textarea",
      helpText:
        "Resolved review instructions JSON. Changes alter the historical prompt context.",
    },
    projectMemoryJson: {
      type: "string",
      label: "Project Memory JSON",
      required: false,
      inputType: "textarea",
      helpText:
        "Project memory JSON supplied to the review. Changes alter the historical prompt context.",
    },
    workspaceStrategy: {
      type: "string",
      label: "Workspace Strategy",
      required: true,
      helpText:
        "Workspace strategy recorded for this snapshot. Editing changes historical metadata.",
    },
    interactionRunId: {
      type: "string",
      label: "Interaction Run ID",
      required: false,
      readonly: true,
      helpText:
        "Logical interaction-run id this snapshot belongs to. Empty for snapshots migrated before v005.",
    },
  });

const createInteractionJobCtd = (availableAtRequired: boolean) =>
  generateCtdFromFieldsDescriptor(
    "interaction_job",
    "Run History/Interaction Job",
    {
      tenantId: {
        type: "datasource",
        label: "Tenant ID",
        required: true,
        relationContentType: "tenant",
        readonly: true,
        helpText: "Tenant that received the interaction.",
      },
      dedupeKey: {
        type: "string",
        label: "Dedupe Key",
        required: true,
        readonly: true,
        helpText: "Internal idempotency key used to prevent duplicate jobs.",
      },
      codeReviewId: {
        type: "number",
        label: "Code Review ID",
        required: true,
        readonly: true,
        helpText:
          "Platform-local merge request or pull request number. Changing it alters job association.",
      },
      commentId: {
        type: "number",
        label: "Comment ID",
        required: false,
        readonly: true,
        helpText: "Optional platform-local triggering comment number.",
      },
      triggerJson: {
        type: "string",
        label: "Trigger JSON",
        required: true,
        readonly: true,
        inputType: "textarea",
        helpText: "Provider-owned trigger identity encoded as JSON.",
      },
      headSha: {
        type: "string",
        label: "Head SHA",
        required: true,
        readonly: true,
        helpText:
          "Full commit SHA reviewed by this job. Changing it may make history inconsistent.",
      },
      status: {
        type: "string",
        label: "Status",
        required: true,
        allowedValues: [
          "queued",
          "in_progress",
          "completed",
          "failed",
          "cancelled",
          "expired",
        ],
        helpText: "System-managed job lifecycle state.",
      },
      payloadJson: {
        type: "string",
        label: "Payload JSON",
        required: true,
        inputType: "textarea",
        helpText:
          "Normalized event payload JSON. Invalid structure can prevent job processing.",
      },
      retryCount: {
        type: "number",
        label: "Retry Count",
        required: true,
        readonly: true,
        helpText:
          "Retry attempts already made. Changing this affects retry behavior.",
      },
      lastError: {
        type: "string",
        label: "Last Error",
        required: false,
        readonly: true,
      },
      enqueuedAt: {
        type: "string",
        label: "Enqueued At",
        required: true,
        readonly: true,
        helpText: "ISO 8601 timestamp recorded when the job entered the queue.",
      },
      availableAt: {
        type: "string",
        label: "Available At",
        required: availableAtRequired,
        readonly: true,
        helpText:
          "ISO 8601 timestamp when the job becomes eligible to claim. Retries push it forward.",
      },
      startedAt: {
        type: "string",
        label: "Started At",
        required: false,
        readonly: true,
        helpText:
          "ISO 8601 timestamp recorded when the job started processing.",
      },
      finishedAt: {
        type: "string",
        label: "Finished At",
        required: false,
        readonly: true,
        helpText:
          "ISO 8601 timestamp recorded when the job finished processing.",
      },
      claimToken: {
        type: "string",
        label: "Claim Token",
        required: false,
        readonly: true,
        helpText:
          "Token of the current claim attempt. Ownership checks fence stale attempts by this value.",
      },
      claimedBy: {
        type: "string",
        label: "Claimed By",
        required: false,
        readonly: true,
        helpText: "Runner worker id that holds the current claim, for diagnostics.",
      },
      claimExpiresAt: {
        type: "string",
        label: "Claim Expires At",
        required: false,
        readonly: true,
        helpText:
          "ISO 8601 lease expiry for the current claim. A passed deadline allows reclaim.",
      },
      latestInteractionRunId: {
        type: "string",
        label: "Latest Interaction Run ID",
        required: false,
        readonly: true,
        helpText:
          "Logical id of the latest interaction run created for this job. Not a datasource relation.",
      },
    },
  );

export const V005_CTDS = [
  createModelProfileCtd(),
  createInteractionRunCtd(),
  createCodeReviewSnapshotCtd(),
  createInteractionJobCtd(true),
] as const;

export default async function ensureV005CtdsExist(
  apiKey: string,
  flotiqClient: Flotiq,
  logger?: Logger,
): Promise<void> {
  if (!apiKey) {
    throw new Error(
      "FLOTIQ_API_KEY is not set. Cannot ensure CTDs exist without API key.",
    );
  }

  await applyCtd(createModelProfileCtd(), apiKey, logger);
  await applyCtd(createInteractionRunCtd(), apiKey, logger);
  await applyCtd(createCodeReviewSnapshotCtd(), apiKey, logger);

  await applyCtd(createInteractionJobCtd(false), apiKey, logger);
  await backfillInteractionJobAvailableAt(flotiqClient, logger);
  await applyCtd(createInteractionJobCtd(true), apiKey, logger);
}

async function applyCtd(
  ctd: CtdDefinition,
  apiKey: string,
  logger?: Logger,
): Promise<void> {
  const existingCtd = await fetchExistingCtd(ctd.name, apiKey, logger);
  if (!existingCtd) {
    await createCtd(ctd, apiKey, logger);
    return;
  }

  if (!ctdNeedsUpdate(existingCtd, ctd)) {
    logger?.info({ ctdName: ctd.name }, "Flotiq v005 CTD already current.");
    return;
  }

  await updateCtd(ctd.name, ctd, apiKey, logger);
  logger?.info({ ctdName: ctd.name }, "Flotiq v005 CTD updated.");
}

type LegacyInteractionJob = Omit<InteractionJob, "availableAt"> & {
  availableAt?: string;
};

async function backfillInteractionJobAvailableAt(
  flotiqClient: Flotiq,
  logger?: Logger,
): Promise<void> {
  const dataToMigrate: LegacyInteractionJob[] = [];
  let page = 1;

  while (true) {
    const response = await flotiqClient.content.interaction_job.list({
      page,
      limit: PAGE_SIZE,
    });
    dataToMigrate.push(
      ...(response.data as LegacyInteractionJob[]).filter(
        requiresAvailableAtMigration,
      ),
    );
    if (page >= response.total_pages) {
      break;
    }
    page += 1;
  }

  for (let offset = 0; offset < dataToMigrate.length; offset += BATCH_SIZE) {
    const batch = dataToMigrate
      .slice(offset, offset + BATCH_SIZE)
      .map(toMigratedInteractionJob);
    const result = await flotiqClient.content.interaction_job.batchUpdate(
      batch as never,
    );
    assertSuccessfulBatch(result, "interaction_job availableAt backfill");
  }

  logger?.info(
    { migratedInteractionJobCount: dataToMigrate.length },
    "Flotiq v005 interaction job availableAt migration completed.",
  );
}

function requiresAvailableAtMigration(entity: LegacyInteractionJob): boolean {
  return (
    typeof entity.availableAt !== "string" ||
    entity.availableAt.trim().length === 0
  );
}

function toMigratedInteractionJob(
  entity: LegacyInteractionJob,
): Record<string, unknown> {
  if (
    typeof entity.enqueuedAt !== "string" ||
    entity.enqueuedAt.trim().length === 0
  ) {
    throw new Error(
      `Cannot migrate Flotiq interaction job ${entity.id}: missing enqueuedAt`,
    );
  }

  const { internal: _internal, ...persistedFields } = entity;
  return {
    ...persistedFields,
    availableAt: entity.enqueuedAt,
  };
}

function assertSuccessfulBatch(
  result: BaseBatchResponse<InteractionJob>,
  operation: string,
): void {
  if (result.batch_error_count === 0) {
    return;
  }

  throw new Error(
    `Flotiq ${operation} failed for ${result.batch_error_count} record(s)`,
  );
}
