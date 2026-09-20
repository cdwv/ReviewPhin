import { expect, it } from "vitest";
import { buildManualReviewPlan } from "../src/review/interaction-plan.js";
import { batchRequest } from "./helpers/batch-request.js";

it("executes an explicit manual review without classifying its instruction", () => {
  expect(
    buildManualReviewPlan({
      kind: "manual-review",
      provider: "fixture",
      source: "cli",
      instruction: "Focus on concurrency",
      metadata: {},
    }),
  ).toMatchObject({
    reviewNeeded: true,
    replyNeeded: false,
    memoryCandidate: false,
  });
});
it("refuses to substitute rules for model routing on a comment", () => {
  expect(() =>
    buildManualReviewPlan(batchRequest(1, "please review").trigger),
  ).toThrow("routing model");
});
