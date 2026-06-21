import type {
  PriorReviewFindingContext,
  ReplyStyle,
  ReviewTriggerContext,
  InteractionPlan,
} from "./types.js";

interface BuildInteractionPlanInput {
  trigger: ReviewTriggerContext;
  previousReviewExists: boolean;
  priorFindings: ReadonlyArray<Pick<PriorReviewFindingContext, "status">>;
}

const REVIEW_REQUEST_PATTERN =
  /\b(review|re-review|rereview|rerun|re-run|rescan|check again|look again|take another look|reassess)\b/i;
const QUESTION_PATTERN =
  /[?]|^\s*(why|how|what|when|where|can|could|would|should|is|are|do|does)\b/i;
const MEMORY_PATTERN =
  /\b(for future reference|remember\b|please remember|going forward|in the future|team policy|stable preference|always prefer|please prefer)\b/i;
const WORDING_PATTERN =
  /\b(reword|rewrite|wording|tone|summar(?:y|ize)|clarify|explain|human|friendlier|friendlier|shorter|longer)\b/i;

export function buildInteractionPlan(
  input: BuildInteractionPlanInput,
): InteractionPlan {
  if (input.trigger.kind === "manual-review") {
    return {
      initiatingTrigger: input.trigger,
      responseTargets: [],
      plannedResponses: [],
      memoryCandidate: false,
      reviewNeeded: true,
      replyNeeded: false,
      replyStyle: "none",
      rerunReason: "manual-review",
    };
  }

  const normalizedInstruction = normalizeInstruction(
    input.trigger.instruction ?? input.trigger.body,
  );
  const hasOpenPriorFindings = input.priorFindings.some(
    (finding) => finding.status === "open",
  );
  const reviewRequested = REVIEW_REQUEST_PATTERN.test(normalizedInstruction);
  const questionLike = QUESTION_PATTERN.test(normalizedInstruction);
  const memoryCandidate = MEMORY_PATTERN.test(normalizedInstruction);
  const wordingRequest = WORDING_PATTERN.test(normalizedInstruction);
  const mentionOnlyNoise =
    input.trigger.kind === "direct-mention" &&
    normalizedInstruction.length === 0;
  const shouldRefineExistingReview =
    memoryCandidate && (input.previousReviewExists || hasOpenPriorFindings);

  const reviewNeeded =
    input.trigger.kind === "follow-up-comment" ||
    reviewRequested ||
    shouldRefineExistingReview;
  const nonReviewReplyRequested =
    wordingRequest ||
    memoryCandidate ||
    input.trigger.kind === "summary-follow-up";
  const replyNeeded =
    input.trigger.kind !== "follow-up-comment" &&
    !mentionOnlyNoise &&
    (!reviewRequested || nonReviewReplyRequested);
  const replyStyle = resolveReplyStyle({
    trigger: input.trigger,
    replyNeeded,
    questionLike,
    wordingRequest,
    memoryCandidate,
  });
  const responseTargets = replyNeeded ? [input.trigger.responseTarget] : [];

  return {
    initiatingTrigger: input.trigger,
    responseTargets,
    plannedResponses: responseTargets.map((target) => ({
      target,
      replyStyle,
      reviewNeeded,
      memoryCandidate,
    })),
    memoryCandidate,
    reviewNeeded,
    replyNeeded,
    replyStyle,
    rerunReason: shouldRefineExistingReview
      ? "memory-update"
      : reviewRequested
        ? "explicit-review-request"
        : null,
  };
}

function resolveReplyStyle(input: {
  trigger: ReviewTriggerContext;
  replyNeeded: boolean;
  questionLike: boolean;
  wordingRequest: boolean;
  memoryCandidate: boolean;
}): ReplyStyle {
  if (!input.replyNeeded) {
    return "none";
  }

  if (input.trigger.kind === "summary-follow-up") {
    return "summary-follow-up";
  }

  if (input.questionLike || input.wordingRequest) {
    return "direct-answer";
  }

  if (input.memoryCandidate) {
    return "acknowledgement";
  }

  return "direct-answer";
}

function normalizeInstruction(value: string): string {
  return value
    .replace(/@[A-Za-z0-9_.-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
