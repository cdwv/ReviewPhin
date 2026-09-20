import { describe, expect, it } from "vitest";
import { batchCheckpointSchema } from "../src/review/batch-checkpoint.js";
import { routingResultSchema } from "../src/review/interaction-router.js";

const checkpoint = {
  version: 1,
  headSha: "reviewed-head",
  requestIds: ["first", "second"],
  routing: {
    source: "model",
    model: "router",
    reasoningEffort: "low",
    decisions: [true, false].map((review, i) => ({
      requestId: i === 0 ? "first" : "second",
      review,
      memory: true,
      reply: true,
      reason: "Saved decision",
    })),
  },
  memoryDone: true,
  reviewResult: {
    overview: {
      summary: "Already reviewed",
      overallSeverity: "low",
      overallAssessment: "No issues",
      mergeReadiness: { status: "ready", confidence: "high", summary: "Ready" },
    },
    findings: [],
    priorDispositions: [],
  },
  reviewPublished: true,
  replyResult: { memory: null, replies: [] },
  publishedReplyKeys: ["already-published"],
};

describe("batch checkpoint compatibility", () => {
  it("upgrades old boolean routing without losing completed work", () => {
    const restored = batchCheckpointSchema.parse(checkpoint);
    expect(restored.version).toBe(2);
    expect(restored.routing.decisions.map((d) => d.review)).toEqual([
      "full",
      "none",
    ]);
    const { version: _version, routing: _routing, ...progress } = checkpoint;
    expect(restored).toMatchObject(progress);
    expect(batchCheckpointSchema.parse(restored)).toEqual(restored);
  });

  it("does not accept legacy booleans from the model or new checkpoints", () => {
    expect(
      routingResultSchema.safeParse({ decisions: checkpoint.routing.decisions })
        .success,
    ).toBe(false);
    expect(
      batchCheckpointSchema.safeParse({ ...checkpoint, version: 2 }).success,
    ).toBe(false);
  });
});
