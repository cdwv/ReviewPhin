import type {
  Flotiq,
  InteractionJob,
  BaseBatchResponse,
} from "@flotiq/flotiq-api-sdk";
import type { Logger } from "pino";

import { generateCtdFromFieldsDescriptor } from "../flotiq-ctd-builder.js";

const PAGE_SIZE = 100;
const BATCH_SIZE = 100;

const createInteractionJobCtd = (triggerJsonRequired: boolean) =>
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
        required: triggerJsonRequired,
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
    },
  );

export const V003_CTDS = [createInteractionJobCtd(true)] as const;

const V003_MIGRATION_CTDS = [createInteractionJobCtd(false)] as const;

export default async function ensureV003CtdsExist(
  apiKey: string,
  flotiqClient: Flotiq,
  logger?: Logger,
): Promise<void> {
  if (!apiKey) {
    throw new Error(
      "FLOTIQ_API_KEY is not set. Cannot ensure CTDs exist without API key.",
    );
  }

  await updateCtds(apiKey, V003_MIGRATION_CTDS, logger);
  await migrateInteractionJobTriggers(flotiqClient, logger);
  await updateCtds(apiKey, V003_CTDS, logger);
}

type LegacyInteractionJob = Omit<InteractionJob, "triggerJson"> & {
  triggerJson?: string;
};

async function migrateInteractionJobTriggers(
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
        requiresTriggerMigration,
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
    assertSuccessfulBatch(result, "interaction_job trigger backfill");
  }

  logger?.info(
    { migratedInteractionJobCount: dataToMigrate.length },
    "Flotiq v003 interaction job trigger migration completed.",
  );
}

function requiresTriggerMigration(entity: LegacyInteractionJob): boolean {
  return (
    typeof entity.triggerJson !== "string" ||
    entity.triggerJson.trim().length === 0
  );
}

function toMigratedInteractionJob(
  entity: LegacyInteractionJob,
): Record<string, unknown> {
  if (
    typeof entity.commentId !== "number" ||
    !Number.isInteger(entity.commentId) ||
    entity.commentId <= 0
  ) {
    throw new Error(
      `Cannot migrate Flotiq interaction job ${entity.id}: missing valid commentId`,
    );
  }

  const { internal: _internal, ...persistedFields } = entity;
  return {
    ...persistedFields,
    triggerJson: JSON.stringify({
      kind: "comment",
      commentId: entity.commentId,
    }),
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

async function updateCtds(
  apiKey: string,
  ctds: ReadonlyArray<ReturnType<typeof createInteractionJobCtd>>,
  logger?: Logger,
): Promise<void> {
  for (const ctd of ctds) {
    const response = await fetch(
      `https://api.flotiq.com/api/v1/internal/contenttype/${ctd.name}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-AUTH-TOKEN": apiKey,
        },
        body: JSON.stringify(ctd),
      },
    );
    if (!response.ok) {
      const responseBody = await response.text();
      logger?.error(
        { ctdName: ctd.name, status: response.status, responseBody },
        "Flotiq v003 CTD update failed.",
      );
      throw new Error(
        `Failed to update CTD for ${ctd.name}. HTTP ${response.status}: ${responseBody}`,
      );
    }
    logger?.info({ ctdName: ctd.name }, "Flotiq v003 CTD updated.");
  }
}
