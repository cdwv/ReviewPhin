import { z } from "zod";

import { sha256 } from "../utils/hash.js";

export const reviewPublicationModeSchema = z.enum(["publish", "no-publish"]);

export type ReviewPublicationMode = z.infer<typeof reviewPublicationModeSchema>;

const DEFAULT_REVIEW_PUBLICATION_MODE: ReviewPublicationMode = "publish";

export function getReviewPublicationMode(
  triggerJson: string | null | undefined,
): ReviewPublicationMode {
  if (!triggerJson) {
    return DEFAULT_REVIEW_PUBLICATION_MODE;
  }
  const trigger = parseTriggerObject(triggerJson);
  return reviewPublicationModeSchema
    .optional()
    .default(DEFAULT_REVIEW_PUBLICATION_MODE)
    .parse(trigger.publicationMode);
}

export function setReviewPublicationMode(
  triggerJson: string,
  publicationMode: ReviewPublicationMode,
): string {
  const trigger = parseTriggerObject(triggerJson);
  return JSON.stringify({ ...trigger, publicationMode });
}

export function scopeReviewDedupeKeyToPublicationMode(
  dedupeKey: string,
  publicationMode: ReviewPublicationMode,
): string {
  return publicationMode === DEFAULT_REVIEW_PUBLICATION_MODE
    ? dedupeKey
    : sha256(`${dedupeKey}::publication-mode:${publicationMode}`);
}

function parseTriggerObject(triggerJson: string): Record<string, unknown> {
  const trigger = JSON.parse(triggerJson) as unknown;
  if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) {
    throw new Error("Review trigger JSON must contain an object.");
  }
  return trigger as Record<string, unknown>;
}
