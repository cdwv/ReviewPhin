import { z } from "zod";

export const localReviewTriggerSchema = z.object({
  kind: z.literal("reviewphin-local-review"),
  source: z.literal("cli"),
  requestId: z.string().min(1),
  codeReviewId: z.number().int().positive(),
  instruction: z.string().trim().min(1),
  createdAt: z.string().datetime({ offset: true }),
});

export type LocalReviewTrigger = z.infer<typeof localReviewTriggerSchema>;

export function isLocalReviewTrigger(
  value: unknown,
): value is LocalReviewTrigger {
  return localReviewTriggerSchema.safeParse(value).success;
}

export function parseLocalReviewTrigger(value: unknown): LocalReviewTrigger {
  return localReviewTriggerSchema.parse(value);
}

export function serializeLocalReviewTrigger(
  trigger: LocalReviewTrigger,
): string {
  return JSON.stringify(localReviewTriggerSchema.parse(trigger));
}
