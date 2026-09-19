import type {
  Flotiq,
  InteractionJob,
  InteractionRequest,
} from "@flotiq/flotiq-api-sdk";
import type { Logger } from "pino";
import { interactionRequestId } from "../../../interaction-batches.js";
import {
  generateCtdFromFieldsDescriptor,
  type FieldsDescriptor,
} from "../flotiq-ctd-builder.js";
import {
  createCtd,
  ctdNeedsUpdate,
  fetchExistingCtd,
  updateCtd,
} from "./migration-helpers.js";

const textField = (label: string, required = false) => ({
  type: "string" as const,
  label,
  required,
});

/** Additive, restartable migration. Original objects are never rewritten. */
export default async function ensureV007CtdsExist(
  apiKey: string,
  client: Flotiq,
  logger?: Logger,
): Promise<void> {
  for (const [name, fields] of Object.entries({
    model_profile: {
      routingModel: textField("Routing model"),
      routingReasoningEffort: textField("Routing reasoning effort"),
    },
    interaction_job: { batchKind: textField("Batch kind") },
    interaction_run: {
      repliesJson: {
        ...textField("Saved replies and publication outcomes"),
        inputType: "textarea" as const,
      },
    },
  })) {
    const existing = await fetchExistingCtd(name, apiKey, logger);
    if (!existing) throw new Error(`Cannot migrate missing ${name} definition`);
    const addition = generateCtdFromFieldsDescriptor(
      name,
      existing.label,
      fields,
    );
    const next = structuredClone(existing);
    const properties = next.schemaDefinition.allOf.find(
      (part) => part.properties,
    )?.properties;
    if (!properties) throw new Error(`Missing properties in ${name}`);
    Object.assign(
      properties,
      addition.schemaDefinition.allOf.find((part) => part.properties)!
        .properties,
    );
    Object.assign(
      next.metaDefinition.propertiesConfig,
      addition.metaDefinition.propertiesConfig,
    );
    next.metaDefinition.order = [
      ...new Set([
        ...next.metaDefinition.order,
        ...addition.metaDefinition.order,
      ]),
    ];
    if (ctdNeedsUpdate(existing, next))
      await updateCtd(name, next, apiKey, logger);
  }
  const fields: FieldsDescriptor = {
    tenantId: textField("Tenant ID", true),
    codeReviewId: { type: "number", label: "Code review ID", required: true },
    dedupeKey: textField("Provider event identity", true),
    interactionJobId: textField("Interaction job ID"),
    commentId: { type: "number", label: "Comment ID", required: false },
    triggerJson: textField("Original trigger", true),
    payloadJson: textField("Original provider payload", true),
    headSha: textField("Original revision", true),
    receivedAt: textField("Received at", true),
    admittedAt: textField("Admission completed at"),
    debounceMs: {
      type: "number",
      label: "Collection quiet period",
      required: true,
    },
  };
  const ctd = generateCtdFromFieldsDescriptor(
    "interaction_request",
    "Run History/Interaction Requests",
    fields,
  );
  const existing = await fetchExistingCtd(ctd.name, apiKey, logger);
  if (!existing) await createCtd(ctd, apiKey, logger);
  else if (ctdNeedsUpdate(existing, ctd))
    await updateCtd(ctd.name, ctd, apiKey, logger);

  for (let page = 1; ; page++) {
    const result = await client.content.interaction_job.list({
      page,
      limit: 100,
      order_by: "id",
      order_direction: "asc",
    });
    for (const job of result.data) {
      const request = requestFromLegacyJob(job);
      const prior = await client.content.interaction_request.list({
        filters: { id: { type: "equals", filter: request.id } },
        limit: 1,
      });
      if (!prior.data.length)
        await client.content.interaction_request.create(request);
      const saved = await client.content.interaction_request.list({
        filters: { id: { type: "equals", filter: request.id } },
        limit: 1,
      });
      const record = saved.data[0];
      if (
        !record ||
        Object.entries(request).some(([key, value]) => {
          const actual = record[key as keyof InteractionRequest];
          // Flotiq can omit optional fields whose stored value is null.
          return (key === "commentId" ? (actual ?? null) : actual) !== value;
        })
      ) {
        throw new Error(
          `Interaction request migration verification failed for ${job.id}`,
        );
      }
    }
    if (page >= result.total_pages || !result.data.length) break;
  }
}

function requestFromLegacyJob(
  job: InteractionJob,
): Omit<InteractionRequest, "internal"> {
  const tenant = job.tenantId[0];
  const tenantId =
    tenant && "id" in tenant
      ? String(tenant.id)
      : tenant && "dataUrl" in tenant
        ? String(tenant.dataUrl).split("/").at(-1)
        : undefined;
  if (!tenantId || !job.triggerJson || !job.enqueuedAt)
    throw new Error(`Incomplete legacy job ${job.id}`);
  return {
    id: interactionRequestId(tenantId, job.dedupeKey),
    tenantId,
    codeReviewId: job.codeReviewId,
    dedupeKey: job.dedupeKey,
    interactionJobId: job.id,
    commentId: job.commentId ?? null,
    triggerJson: job.triggerJson,
    payloadJson: job.payloadJson,
    headSha: job.headSha,
    receivedAt: job.enqueuedAt,
    admittedAt: job.enqueuedAt,
    debounceMs: 0,
  };
}
