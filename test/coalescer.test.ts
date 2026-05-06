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
      }),
    );
  });
});
