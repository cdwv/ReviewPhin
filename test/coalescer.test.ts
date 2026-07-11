import { describe, expect, it, vi } from "vitest";

import { ProjectMemoryConsolidator } from "../src/memory/consolidator.js";

describe("ProjectMemoryConsolidator", () => {
  it("uses the shared harness path without task-specific tools or subagents", async () => {
    const runSession = vi.fn(async () => ({
      response: {
        data: {
          content: JSON.stringify({
            entries: ["Use explicit return types."],
          }),
        },
      },
      parsed: {
        entries: ["Use explicit return types."],
      },
      events: [],
    }));
    const consolidator = new ProjectMemoryConsolidator({
      runSession: runSession as never,
    });

    const result = await consolidator.coalesce({
      modelConfig: {
        modelProfileName: "default",
        selectionSource: "default",
        reviewModel: "gpt-5.4",
        textGenerationModel: "gpt-5.4-mini",
        reviewReasoningEffort: null,
        textGenerationReasoningEffort: null,
        authToken: null,
        provider: undefined,
        providerBaseUrl: null,
        providerType: null,
      },
      coalesceInput: {
        entries: [{ text: "Use explicit return types." }],
        maxChars: 5_000,
        targetChars: 4_000,
        reason: "prompt-budget",
      },
    });

    expect(result).toEqual([{ text: "Use explicit return types." }]);
    expect(runSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.4-mini",
        tools: [],
        subagents: [],
        responseFormat: expect.objectContaining({
          schema: expect.anything(),
          looksLike: expect.any(Function),
        }),
      }),
    );
    const spec = (runSession.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(
      Object.prototype.hasOwnProperty.call(spec, "reasoningEffort"),
    ).toBe(false);
  });

  it("passes the text-generation reasoning effort into the consolidation session", async () => {
    const runSession = vi.fn(async () => ({
      response: {
        data: {
          content: JSON.stringify({ entries: ["Keep it terse."] }),
        },
      },
      parsed: { entries: ["Keep it terse."] },
      events: [],
    }));
    const consolidator = new ProjectMemoryConsolidator({
      runSession: runSession as never,
    });

    await consolidator.coalesce({
      modelConfig: {
        modelProfileName: "default",
        selectionSource: "default",
        reviewModel: "gpt-5.6",
        textGenerationModel: "gpt-5.6-mini",
        reviewReasoningEffort: "high",
        textGenerationReasoningEffort: "low",
        authToken: null,
        provider: undefined,
        providerBaseUrl: null,
        providerType: null,
      },
      coalesceInput: {
        entries: [{ text: "Keep it terse." }],
        maxChars: 5_000,
        targetChars: 4_000,
        reason: "prompt-budget",
      },
    });

    expect(runSession).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: "low" }),
    );
  });
});
