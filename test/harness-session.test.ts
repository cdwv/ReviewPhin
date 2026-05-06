import { beforeEach, describe, expect, it, vi } from "vitest";

const { createSessionMock, stopMock } = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  stopMock: vi.fn(),
}));

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: vi.fn().mockImplementation(() => ({
    createSession: createSessionMock,
    stop: stopMock,
  })),
  defineTool: (name: string, definition: object) => ({
    name,
    ...definition,
  }),
}));

import { CopilotClient } from "@github/copilot-sdk";
import { HarnessSessionRuntime } from "../src/harness/session.js";
import type {
  HarnessModelConfig,
  HarnessTenantContext,
} from "../src/harness/types.js";
import { tmpPath } from "./test-paths.js";

describe("HarnessSessionRuntime", () => {
  beforeEach(() => {
    createSessionMock.mockReset();
    stopMock.mockReset();
    vi.mocked(CopilotClient).mockClear();
  });

  it("registers typed tools and subagents through the session allowlist", async () => {
    const load = vi.fn(async () => ({
      enabled: true,
      page: null,
      entries: [],
    }));
    const saveEntries = vi.fn(async () => ({
      enabled: true,
      page: null,
      entries: [{ text: "Remember this." }],
    }));
    createSessionMock.mockResolvedValue(createSession());
    stopMock.mockResolvedValue(undefined);

    const runtime = new HarnessSessionRuntime({
      logger: createLogger(),
      projectMemoryBackendFactory: {
        createForHarnessRun: vi.fn(() => ({
          load,
          saveEntries,
        })),
        createForGitLabClient: vi.fn(),
      },
      runLogDir: tmpPath(),
      timeoutMs: 1_000,
      maxPromptMemoryChars: 5_000,
    });

    await runtime.run({
      prompt: "Review this.",
      modelConfig: createModelConfig(),
      model: "gpt-5.4",
      workingDirectory: tmpPath("workspace"),
      tenant: createTenant(),
      tools: ["glob", "rg", "view", "add_memory_entry"],
      subagents: ["context-analyst", "review-author"],
      agent: "review-author",
    });

    const sessionOptions = createSessionMock.mock.calls[0]?.[0];
    expect(sessionOptions.availableTools).toEqual([
      "glob",
      "rg",
      "view",
      "add_memory_entry",
    ]);
    expect(sessionOptions.customAgents[0].tools).toEqual([
      "glob",
      "rg",
      "view",
    ]);
    expect(sessionOptions.customAgents[1].tools).toEqual([
      "glob",
      "rg",
      "view",
    ]);

    await sessionOptions.tools[0].handler({
      memory: "Remember this.",
      rationale: "Durable policy",
      supersedes: [],
    });

    expect(load).toHaveBeenCalledOnce();
    expect(saveEntries).toHaveBeenCalledWith([{ text: "Remember this." }], {
      baseEntries: [],
    });
  });

  it("passes explicit provider config into session creation when configured", async () => {
    createSessionMock.mockResolvedValue(createSession());
    stopMock.mockResolvedValue(undefined);

    const runtime = new HarnessSessionRuntime({
      logger: createLogger(),
      projectMemoryBackendFactory: {
        createForHarnessRun: vi.fn(),
        createForGitLabClient: vi.fn(),
      },
      runLogDir: tmpPath(),
      timeoutMs: 1_000,
      maxPromptMemoryChars: 5_000,
    });

    await runtime.run({
      prompt: "Review this.",
      modelConfig: {
        ...createModelConfig(),
        provider: {
          baseUrl: "http://llm.internal/v1",
          type: "openai",
        },
      },
      model: "custom-review",
      tools: ["glob", "rg", "view"],
      subagents: [],
    });

    const sessionOptions = createSessionMock.mock.calls[0]?.[0];
    expect(sessionOptions.provider).toEqual({
      baseUrl: "http://llm.internal/v1",
      type: "openai",
    });
    expect(sessionOptions.enableConfigDiscovery).toBe(false);
  });

  it("passes a native auth token only when no custom provider is configured", async () => {
    createSessionMock.mockResolvedValue(createSession());
    stopMock.mockResolvedValue(undefined);

    const runtime = new HarnessSessionRuntime({
      logger: createLogger(),
      projectMemoryBackendFactory: {
        createForHarnessRun: vi.fn(),
        createForGitLabClient: vi.fn(),
      },
      runLogDir: tmpPath(),
      timeoutMs: 1_000,
      maxPromptMemoryChars: 5_000,
    });

    await runtime.run({
      prompt: "Review this.",
      modelConfig: {
        ...createModelConfig(),
        authToken: "github-token",
      },
      model: "gpt-5.4",
      tools: ["glob", "rg", "view"],
      subagents: [],
    });

    expect(CopilotClient).toHaveBeenCalledWith({
      gitHubToken: "github-token",
    });
  });
});

function createSession() {
  return {
    sessionId: "session_1",
    on: vi.fn(() => () => {}),
    sendAndWait: vi.fn(async () => ({
      data: {
        content: JSON.stringify({
          overview: {
            summary: "Looks good",
            overallSeverity: "low",
          },
          findings: [],
          priorDispositions: [],
        }),
      },
    })),
    disconnect: vi.fn(async () => {}),
  };
}

function createLogger() {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => createLogger()),
  } as never;
}

function createModelConfig(): HarnessModelConfig {
  return {
    modelProfileName: "default",
    selectionSource: "default",
    reviewModel: "gpt-5.4",
    textGenerationModel: "gpt-5.4-mini",
    authToken: null,
    provider: undefined,
    providerBaseUrl: null,
    providerType: null,
  };
}

function createTenant(): HarnessTenantContext {
  return {
    id: "tenant_1",
    baseUrl: "https://gitlab.example.com",
    projectId: 1085,
    apiToken: "token",
    memoryEnabled: true,
  };
}
