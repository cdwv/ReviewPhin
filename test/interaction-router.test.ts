import { LeaseLostError } from "../src/storage/storage-helpers.js";
import { describe, expect, it, vi } from "vitest";
import {
  InteractionRouter,
  reduceRoutingDecisions,
  validateReplyCoverage,
  type RoutingInput,
  type RoutingDecision,
} from "../src/review/interaction-router.js";
import type { HarnessModelConfig } from "../src/harness/types.js";
import { batchRequest } from "./helpers/batch-request.js";

const config: HarnessModelConfig = {
  modelProfileName: "test",
  selectionSource: "tenant",
  reviewModel: "reviewer",
  textGenerationModel: "chatter",
  reviewReasoningEffort: null,
  textGenerationReasoningEffort: null,
  routingModel: "cheap-router",
  routingReasoningEffort: "low",
  authToken: null,
  provider: undefined,
  providerBaseUrl: null,
  providerType: null,
};
const requests = [
  batchRequest(1, "Please review, and why is this safe?"),
  batchRequest(2, "Remember that this service requires stable ordering"),
];
const input: RoutingInput = {
  requests,
  previousReviewExists: true,
  priorFindings: [],
  memoryEnabled: true,
};

describe("model-assisted interaction routing", () => {
  it.each([
    [["none", "none"], "none"],
    [["incremental", "none"], "incremental"],
    [["incremental", "full"], "full"],
    [["full", "incremental"], "full"],
    [["none", "incremental"], "incremental"],
  ] as const)("reduces %j to one %s review", (scopes, expected) => {
    const decisions: RoutingDecision[] = requests.map((r, i) => ({
      requestId: r.id,
      review: scopes[i]!,
      memory: false,
      reply: false,
      reason: "Selected by router",
    }));
    const plan = reduceRoutingDecisions(requests, decisions);
    expect(plan.reviewScope).toBe(expected);
    expect(plan.reviewNeeded).toBe(expected !== "none");
  });
  it("propagates claim loss instead of substituting fallback work", async () => {
    const router = new InteractionRouter({
      run: async () => {
        throw new LeaseLostError();
      },
    } as never);
    await expect(router.route(input, config)).rejects.toBeInstanceOf(
      LeaseLostError,
    );
  });
  it("uses the separately selected model, no tools, and one bounded call for the entire batch", async () => {
    const decisions = [
      {
        requestId: "request-1",
        review: "incremental",
        memory: false,
        reply: true,
        reason: "review and question",
      },
      {
        requestId: "request-2",
        review: "none",
        memory: true,
        reply: true,
        reason: "stable guidance",
      },
    ];
    const run = vi.fn(async (_spec: unknown) => ({ parsed: { decisions } }));
    const result = await new InteractionRouter({ run } as never).route(
      input,
      config,
    );
    expect(result.source).toBe("model");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "cheap-router",
        reasoningEffort: "low",
        tools: [],
        subagents: [],
        overallTimeoutMs: 20000,
      }),
    );
    const plan = reduceRoutingDecisions(requests, result.decisions);
    expect(plan).toMatchObject({
      reviewNeeded: true,
      replyNeeded: true,
      memoryCandidate: true,
    });
    expect(plan.responseTargets).toHaveLength(2);
  });

  it.each(["missing", "duplicate", "unknown", "failure"])(
    "asks the chatter model to classify after %s routing output",
    async (failure) => {
      const decision = {
        requestId: "request-1",
        review: "none",
        memory: false,
        reply: false,
        reason: "test",
      };
      let calls = 0;
      const run = vi.fn(async (_spec: unknown) => {
        if (++calls === 2)
          return {
            parsed: {
              decisions: requests.map((r) => ({
                ...decision,
                requestId: r.id,
              })),
            },
          };
        if (failure === "failure") throw new Error("deadline");
        return {
          parsed: {
            decisions:
              failure === "missing"
                ? [decision]
                : [
                    decision,
                    {
                      ...decision,
                      requestId:
                        failure === "unknown" ? "invented" : "request-1",
                    },
                  ],
          },
        };
      });
      const result = await new InteractionRouter({ run } as never).route(
        input,
        config,
      );
      expect(result.source).toBe("chatter");
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[1]?.[0]).toMatchObject({ model: "chatter" });
      expect(result.decisions.map((d) => d.requestId)).toEqual(
        requests.map((r) => r.id),
      );
      expect(
        result.decisions.every(
          (d) => d.review === "none" && !d.memory && !d.reply,
        ),
      ).toBe(true);
    },
  );

  it.each([
    [null, null, "chatter", "medium"],
    ["", null, "chatter", "medium"],
    ["cheap-router", null, "cheap-router", "medium"],
    [null, "low", "chatter", "low"],
  ] as const)(
    "inherits unset model/effort independently: %s / %s",
    async (routingModel, routingReasoningEffort, model, reasoningEffort) => {
      const run = vi.fn(async () => ({
        parsed: {
          decisions: requests.map((r) => ({
            requestId: r.id,
            review: "none",
            memory: false,
            reply: true,
            reason: "model decision",
          })),
        },
      }));
      await new InteractionRouter({ run } as never).route(input, {
        ...config,
        routingModel,
        routingReasoningEffort,
        textGenerationReasoningEffort: "medium",
      });
      expect(run).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ model, reasoningEffort }),
      );
    },
  );

  it("uses the chatter defaults when no model profile is configured", async () => {
    const run = vi.fn(async (_spec: unknown) => ({
      parsed: {
        decisions: requests.map((r) => ({
          requestId: r.id,
          review: "none",
          memory: false,
          reply: true,
          reason: "model decision",
        })),
      },
    }));
    await new InteractionRouter({ run } as never).route(input, {
      ...config,
      routingModel: null,
      routingReasoningEffort: null,
      textGenerationModel: null,
      reviewModel: null,
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ model: undefined }),
    );
    expect(run.mock.calls[0]?.[0]).not.toHaveProperty("reasoningEffort");
  });

  it("fails for retry when both models fail instead of inventing decisions", async () => {
    const run = vi.fn(async () => {
      throw new Error("unavailable");
    });
    await expect(
      new InteractionRouter({ run } as never).route(input, config),
    ).rejects.toThrow("unavailable");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not repeat the same failed model and reasoning settings", async () => {
    const run = vi.fn(async () => {
      throw new Error("unavailable");
    });
    await expect(
      new InteractionRouter({ run } as never).route(input, {
        ...config,
        routingModel: null,
        routingReasoningEffort: null,
      }),
    ).rejects.toThrow("unavailable");
    expect(run).toHaveBeenCalledOnce();
  });

  it("rejects oversized context without substituting rules or dropping requests", async () => {
    const run = vi.fn();
    await expect(
      new InteractionRouter({ run } as never).route(
        { ...input, requests: [batchRequest(3, "x".repeat(50000))] },
        config,
      ),
    ).rejects.toThrow("48000");
    expect(run).not.toHaveBeenCalled();
  });

  it("allows reply-only and no-op decisions and clamps memory to capability", async () => {
    const decisions = requests.map((r, i) => ({
      requestId: r.id,
      review: "none",
      memory: true,
      reply: i === 0,
      reason: "question",
    }));
    const result = await new InteractionRouter({
      run: async () => ({ parsed: { decisions } }),
    } as never).route({ ...input, memoryEnabled: false }, config);
    expect(reduceRoutingDecisions(requests, result.decisions)).toMatchObject({
      reviewNeeded: false,
      memoryCandidate: false,
      replyNeeded: true,
    });
  });
});

describe("batch answer coverage", () => {
  it("requires every independent question to be answered at its own target", () => {
    const replies = requests.map((r) => ({
      target: r.trigger.responseTarget,
      coveredRequestIds: [r.id],
      replyBody: "Answer",
    }));
    expect(() =>
      validateReplyCoverage(requests, { memory: null, replies }),
    ).not.toThrow();
    expect(() =>
      validateReplyCoverage(requests, {
        memory: null,
        replies: replies.slice(0, 1),
      }),
    ).toThrow("every planned request");
    expect(() =>
      validateReplyCoverage(requests, {
        memory: null,
        replies: [
          { ...replies[0]!, coveredRequestIds: requests.map((r) => r.id) },
        ],
      }),
    ).toThrow("unrelated");
    expect(() =>
      validateReplyCoverage(requests, {
        memory: null,
        replies: [...replies, replies[0]!],
      }),
    ).toThrow("duplicate");
  });

  it("permits a combined answer only for explicitly covered requests in the same thread", () => {
    const related = [
      batchRequest(1, "Why?", "thread"),
      batchRequest(2, "And how?", "thread"),
    ];
    const reply = {
      target: related[0]!.trigger.responseTarget,
      coveredRequestIds: related.map((r) => r.id),
      replyBody: "Both answers",
    };
    expect(() =>
      validateReplyCoverage(related, { memory: null, replies: [reply] }),
    ).not.toThrow();
    expect(() =>
      validateReplyCoverage(related, {
        memory: null,
        replies: [{ ...reply, coveredRequestIds: [] }],
      }),
    ).toThrow("coverage");
  });
});
