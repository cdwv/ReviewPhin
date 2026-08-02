import type { CopilotClientOptions, ModelInfo } from "@github/copilot-sdk";
import { describe, expect, it, vi } from "vitest";

import { discoverAvailableModels } from "../src/review/model-catalog.js";

function model(id: string, overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    name: id,
    capabilities: {
      supports: { vision: false, reasoningEffort: false },
      limits: { max_context_window_tokens: 64_000 },
    },
    ...overrides,
  };
}

describe("Copilot model catalog", () => {
  it("starts, maps, sorts, and stops the Copilot client", async () => {
    const start = vi.fn(async () => undefined);
    const listModels = vi.fn(async () => [
      model("z-model"),
      model("a-model", {
        name: "A Model",
        capabilities: {
          supports: { vision: true, reasoningEffort: true },
          limits: { max_context_window_tokens: 128_000 },
        },
        supportedReasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "high",
      }),
    ]);
    const stop = vi.fn(async () => []);
    const createClient = vi.fn((_options: CopilotClientOptions) => ({
      start,
      listModels,
      stop,
    }));

    await expect(
      discoverAvailableModels(
        { authToken: "github-token", logLevel: "warning" },
        createClient,
      ),
    ).resolves.toEqual([
      {
        id: "a-model",
        name: "A Model",
        supportedReasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "high",
        supportsVision: true,
      },
      {
        id: "z-model",
        name: "z-model",
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        supportsVision: false,
      },
    ]);
    expect(createClient).toHaveBeenCalledWith({
      gitHubToken: "github-token",
      logLevel: "warning",
    });
    expect(start).toHaveBeenCalledOnce();
    expect(listModels).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("still stops the client when authentication or catalog loading fails", async () => {
    const failure = new Error("secret-token was rejected");
    const stop = vi.fn(async () => []);

    await expect(
      discoverAvailableModels({}, () => ({
        start: vi.fn(async () => {
          throw failure;
        }),
        listModels: vi.fn(async () => []),
        stop,
      })),
    ).rejects.toBe(failure);
    expect(stop).toHaveBeenCalledOnce();
  });
});
