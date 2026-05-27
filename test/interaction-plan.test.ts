import { describe, expect, it } from "vitest";

import { buildInteractionPlan } from "../src/review/interaction-plan.js";
import type { ReviewTriggerContext } from "../src/review/types.js";

describe("buildInteractionPlan", () => {
  it("routes follow-up finding-thread comments to reviewer-only flow", () => {
    const plan = buildInteractionPlan({
      trigger: createTrigger(
        "follow-up-comment",
        "Please reword this.",
        "Please reword this.",
        "disc_1",
      ),
      previousReviewExists: true,
      priorFindings: [],
    });

    expect(plan.reviewNeeded).toBe(true);
    expect(plan.replyNeeded).toBe(false);
    expect(plan.responseTargets).toEqual([]);
  });

  it("routes direct questions to chatter without review", () => {
    const plan = buildInteractionPlan({
      trigger: createTrigger(
        "direct-mention",
        "@review-bot what changed here?",
        "what changed here?",
      ),
      previousReviewExists: false,
      priorFindings: [],
    });

    expect(plan.reviewNeeded).toBe(false);
    expect(plan.replyNeeded).toBe(true);
    expect(plan.replyStyle).toBe("direct-answer");
    expect(plan.responseTargets).toHaveLength(1);
  });

  it("keeps pure review commands review-only", () => {
    const plan = buildInteractionPlan({
      trigger: createTrigger(
        "direct-mention",
        "@review-bot please review again",
        "please review again",
      ),
      previousReviewExists: true,
      priorFindings: [],
    });

    expect(plan.reviewNeeded).toBe(true);
    expect(plan.replyNeeded).toBe(false);
    expect(plan.rerunReason).toBe("explicit-review-request");
  });

  it("keeps question-shaped review requests review-only", () => {
    const plan = buildInteractionPlan({
      trigger: createTrigger(
        "direct-mention",
        "@review-bot can you review this?",
        "can you review this?",
      ),
      previousReviewExists: false,
      priorFindings: [],
    });

    expect(plan.reviewNeeded).toBe(true);
    expect(plan.replyNeeded).toBe(false);
    expect(plan.replyStyle).toBe("none");
    expect(plan.responseTargets).toEqual([]);
    expect(plan.rerunReason).toBe("explicit-review-request");
  });

  it("lets memory-style summary follow-ups trigger batch-capable memory and review flow", () => {
    const plan = buildInteractionPlan({
      trigger: createTrigger(
        "summary-follow-up",
        "For future reference, please remember our tone should stay concise.",
        "For future reference, please remember our tone should stay concise.",
        "disc_summary",
      ),
      previousReviewExists: true,
      priorFindings: [{ status: "open" }],
    });

    expect(plan.memoryCandidate).toBe(true);
    expect(plan.reviewNeeded).toBe(true);
    expect(plan.replyNeeded).toBe(true);
    expect(plan.replyStyle).toBe("summary-follow-up");
    expect(plan.responseTargets).toHaveLength(1);
    expect(plan.plannedResponses[0]?.target.kind).toBe(
      "summary-discussion-reply",
    );
  });

  it("routes wording refinements to chatter without forcing review", () => {
    const plan = buildInteractionPlan({
      trigger: createTrigger(
        "direct-mention",
        "@review-bot please rewrite the explanation in a friendlier tone",
        "please rewrite the explanation in a friendlier tone",
      ),
      previousReviewExists: true,
      priorFindings: [],
    });

    expect(plan.reviewNeeded).toBe(false);
    expect(plan.replyNeeded).toBe(true);
    expect(plan.replyStyle).toBe("direct-answer");
  });

  it("ignores mention-only noise for chatter replies", () => {
    const plan = buildInteractionPlan({
      trigger: createTrigger("direct-mention", "@review-bot", ""),
      previousReviewExists: false,
      priorFindings: [],
    });

    expect(plan.reviewNeeded).toBe(false);
    expect(plan.replyNeeded).toBe(false);
    expect(plan.responseTargets).toEqual([]);
  });

  it("triggers re-review when memory guidance arrives and open prior findings exist", () => {
    const plan = buildInteractionPlan({
      trigger: createTrigger(
        "direct-mention",
        "@review-bot for future reference, always validate webhook inputs",
        "for future reference, always validate webhook inputs",
      ),
      previousReviewExists: false,
      priorFindings: [{ status: "open" }],
    });

    expect(plan.memoryCandidate).toBe(true);
    expect(plan.reviewNeeded).toBe(true);
    expect(plan.replyNeeded).toBe(true);
    expect(plan.rerunReason).toBe("memory-update");
  });
});

function createTrigger(
  kind: ReviewTriggerContext["kind"],
  body: string,
  instruction: string,
  discussionId?: string,
): ReviewTriggerContext {
  return {
    kind,
    noteId: 55,
    authorUsername: "developer",
    body,
    instruction,
    targetThreadId: kind === "follow-up-comment" ? "thread_1" : null,
    targetDiscussionId: discussionId ?? null,
    targetThreadTitle: kind === "follow-up-comment" ? "Existing finding" : null,
    responseTarget: {
      kind:
        kind === "summary-follow-up"
          ? "summary-discussion-reply"
          : kind === "follow-up-comment"
            ? "finding-thread-reply"
            : discussionId
              ? "discussion-reply"
              : "code-review-note",
      locationType:
        kind === "summary-follow-up"
          ? "summary-discussion"
          : kind === "follow-up-comment"
            ? "finding-thread"
            : discussionId
              ? "discussion-note"
              : "code-review-note",
      triggerKind: kind,
      noteId: 55,
      discussionId,
      authorUsername: "developer",
      body,
      instruction,
    },
  };
}
