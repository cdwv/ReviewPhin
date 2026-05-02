import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createSessionMock,
  stopMock
} = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  stopMock: vi.fn()
}));

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: vi.fn().mockImplementation(() => ({
    createSession: createSessionMock,
    stop: stopMock
  }))
}));

import { CopilotClient } from "@github/copilot-sdk";
import { ProjectMemoryTextCoalescer } from "../src/memory/coalescer.js";

describe("ProjectMemoryTextCoalescer", () => {
  beforeEach(() => {
    createSessionMock.mockReset();
    stopMock.mockReset();
    vi.mocked(CopilotClient).mockClear();
  });

  it("keeps config discovery enabled when only a model is configured", async () => {
    createSessionMock.mockResolvedValue({
      sendAndWait: vi.fn(async () => ({
        data: {
          content: JSON.stringify({
            entries: ["Use explicit return types."]
          })
        }
      })),
      disconnect: vi.fn(async () => {})
    });
    stopMock.mockResolvedValue(undefined);

    const coalescer = new ProjectMemoryTextCoalescer({
      logger: {
        warn: vi.fn()
      } as never,
      model: "gpt-5.4",
      timeoutMs: 1_000
    });

    await coalescer.coalesce({
      entries: [{ text: "Use explicit return types." }],
      maxChars: 5_000,
      targetChars: 4_000,
      reason: "prompt-budget"
    });

    const sessionOptions = createSessionMock.mock.calls[0]?.[0];
    expect(sessionOptions.model).toBe("gpt-5.4");
    expect(sessionOptions.enableConfigDiscovery).toBeUndefined();
  });

  it("disables config discovery when a custom provider is configured", async () => {
    createSessionMock.mockResolvedValue({
      sendAndWait: vi.fn(async () => ({
        data: {
          content: JSON.stringify({
            entries: ["Use explicit return types."]
          })
        }
      })),
      disconnect: vi.fn(async () => {})
    });
    stopMock.mockResolvedValue(undefined);

    const coalescer = new ProjectMemoryTextCoalescer({
      logger: {
        warn: vi.fn()
      } as never,
      model: "custom-review",
      provider: {
        baseUrl: "https://llm.example.com/v1",
        type: "openai"
      },
      timeoutMs: 1_000
    });

    await coalescer.coalesce({
      entries: [{ text: "Use explicit return types." }],
      maxChars: 5_000,
      targetChars: 4_000,
      reason: "prompt-budget"
    });

    const sessionOptions = createSessionMock.mock.calls[0]?.[0];
    expect(sessionOptions.enableConfigDiscovery).toBe(false);
  });
});
