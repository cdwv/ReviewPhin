import { createHash } from "node:crypto";
import { z } from "zod";
import { chatterBatchResultSchema, reviewResultSchema } from "./types.js";
import { routingResultSchema } from "./interaction-router.js";

// The checkpoint belongs to a job attempt. A replacement claim copies it to
// its own run before resuming, so historical attempts remain inspectable.
const currentBatchCheckpointSchema = z.object({
  version: z.literal(2),
  headSha: z.string(),
  requestIds: z.array(z.string()),
  routing: routingResultSchema.extend({
    source: z.enum(["model", "chatter"]),
    model: z.string().nullable().optional(),
    reasoningEffort: z
      .enum(["low", "medium", "high", "xhigh"])
      .nullable()
      .optional(),
    fallbackReason: z.string().optional(),
  }),
  memoryDone: z.boolean(),
  reviewResult: reviewResultSchema.nullable(),
  reviewPublished: z.boolean(),
  replyResult: chatterBatchResultSchema.nullable(),
  publishedReplyKeys: z.array(z.string()),
});
// Older jobs stored only whether to review. Resume conservatively with a full
// scope because their original full/incremental intent was not recorded.
// Cached results and publication progress remain intact.
const legacyBatchCheckpointSchema = currentBatchCheckpointSchema
  .extend({
    version: z.literal(1),
    routing: currentBatchCheckpointSchema.shape.routing.extend({
      decisions: z
        .array(
          routingResultSchema.shape.decisions.element.extend({
            review: z.boolean(),
          }),
        )
        .min(1)
        .max(32),
    }),
  })
  .transform((checkpoint) => ({
    ...checkpoint,
    version: 2 as const,
    routing: {
      ...checkpoint.routing,
      decisions: checkpoint.routing.decisions.map((decision) => ({
        ...decision,
        review: decision.review ? ("full" as const) : ("none" as const),
      })),
    },
  }));
export const batchCheckpointSchema = z.union([
  currentBatchCheckpointSchema,
  legacyBatchCheckpointSchema,
]);
export type BatchCheckpoint = z.infer<typeof batchCheckpointSchema>;

export function replyPublicationMarker(
  jobId: string,
  requestIds: string[],
): string {
  return `<!-- reviewphin:batch-reply:${createHash("sha256")
    .update(JSON.stringify([jobId, [...requestIds].sort()]))
    .digest("hex")} -->`;
}

export function findReplyPublicationMarker(body: string): string | null {
  return (
    body.match(/<!-- reviewphin:batch-reply:[a-f0-9]{64} -->/)?.[0] ?? null
  );
}
