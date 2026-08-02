import { describe, expect, it } from "vitest";

import { parsePersistedReviewResult } from "../src/review/persisted-review-result.js";
import {
  chatterBatchResultSchema,
  reviewResultSchema,
} from "../src/review/types.js";

describe("current review response schemas", () => {
  it("requires every current review result field", () => {
    const incompleteReview = {
      overview: {
        summary: "One issue found.",
        overallSeverity: "medium",
      },
      findings: [],
    };

    const incompleteResult = reviewResultSchema.safeParse(incompleteReview);
    expect(incompleteResult.success).toBe(false);
    if (incompleteResult.success) {
      throw new Error("Expected the incomplete review result to be rejected");
    }
    expect(incompleteResult.error.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        ["overview", "overallAssessment"],
        ["overview", "mergeReadiness"],
        ["priorDispositions"],
      ]),
    );
    expect(
      reviewResultSchema.safeParse({
        ...incompleteReview,
        overview: {
          ...incompleteReview.overview,
          overallAssessment: "One issue needs attention.",
          mergeReadiness: {
            status: "needs_attention",
            confidence: "medium",
            summary: "Address the issue before merging.",
          },
        },
        priorDispositions: [],
      }).success,
    ).toBe(true);
  });

  it("requires memory and replies in every current chatter result", () => {
    expect(chatterBatchResultSchema.safeParse({ replies: [] }).success).toBe(
      false,
    );
    expect(chatterBatchResultSchema.safeParse({ memory: null }).success).toBe(
      false,
    );
    expect(
      chatterBatchResultSchema.safeParse({ memory: null, replies: [] }).success,
    ).toBe(true);
    expect(
      chatterBatchResultSchema.safeParse({
        memory: { status: "skipped", summary: "" },
        replies: [],
      }).success,
    ).toBe(true);
  });
});

describe("persisted review result compatibility", () => {
  it("normalizes fields omitted by older stored review results", () => {
    const result = parsePersistedReviewResult(
      JSON.stringify({
        overview: {
          summary: "A historical issue needs attention.",
          overallSeverity: "medium",
        },
        findings: [],
      }),
    );

    expect(result.overview).toEqual({
      summary: "A historical issue needs attention.",
      overallSeverity: "medium",
      overallAssessment: "A historical issue needs attention.",
      mergeReadiness: {
        status: "ready",
        confidence: "low",
        summary: "A historical issue needs attention.",
      },
    });
    expect(result.priorDispositions).toEqual([]);
  });

  it("normalizes legacy disposition identifiers and ignores unusable entries", () => {
    const result = parsePersistedReviewResult(
      JSON.stringify({
        overview: {
          summary: "A historical issue needs attention.",
          overallSeverity: "medium",
        },
        findings: [
          {
            title: "Fix validation",
            body: "Validate the input before using it.",
            severity: "medium",
            category: "correctness",
          },
        ],
        priorDispositions: [
          { threadId: "legacy-thread", action: "keep" },
          { action: "resolve", resolution: "dismissed" },
        ],
        replyHandoff: {
          summary: "Reply using the historical handoff.",
        },
      }),
    );

    expect(result.overview.mergeReadiness.status).toBe("needs_attention");
    expect(result.priorDispositions).toEqual([
      { discussionId: "legacy-thread", action: "keep" },
    ]);
    expect(result.replyHandoff).toEqual({
      summary: "Reply using the historical handoff.",
      targets: [],
    });
  });

  it("blocks legacy results that contain critical findings", () => {
    const result = parsePersistedReviewResult(
      JSON.stringify({
        overview: {
          summary: "A critical security issue remains.",
          overallSeverity: "critical",
        },
        findings: [
          {
            title: "Reject unauthenticated access",
            body: "Require authentication before returning tenant data.",
            severity: "critical",
            category: "security",
          },
        ],
      }),
    );

    expect(result.overview.mergeReadiness).toEqual({
      status: "blocked",
      confidence: "low",
      summary: "A critical security issue remains.",
    });
  });
});
