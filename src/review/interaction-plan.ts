import type { InteractionPlan, ReviewTriggerContext } from "./types.js";

// Explicit review commands already specify the action; comments use the router.
export function buildManualReviewPlan(
  trigger: ReviewTriggerContext,
): InteractionPlan {
  if (trigger.kind !== "manual-review")
    throw new Error("Comment requests must be classified by the routing model");
  return {
    initiatingTrigger: trigger,
    responseTargets: [],
    plannedResponses: [],
    memoryCandidate: false,
    reviewNeeded: true,
    reviewScope: "incremental",
    replyNeeded: false,
    replyStyle: "none",
    rerunReason: "manual-review",
  };
}
