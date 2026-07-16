import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { createSessionMock, listModelsMock, startMock, stopMock } = vi.hoisted(
  () => ({
    createSessionMock: vi.fn(),
    listModelsMock: vi.fn(),
    startMock: vi.fn(),
    stopMock: vi.fn(),
  }),
);

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: vi.fn(function CopilotClientMock() {
    return {
      createSession: createSessionMock,
      listModels: listModelsMock,
      start: startMock,
      stop: stopMock,
    };
  }),
  defineTool: (name: string, definition: object) => ({
    name,
    ...definition,
  }),
}));

import { CopilotClient } from "@github/copilot-sdk";
import type { SessionEvent } from "@github/copilot-sdk";
import { HarnessSessionRuntime } from "../src/harness/session.js";
import type {
  HarnessModelConfig,
  HarnessTenantContext,
} from "../src/harness/types.js";
import { tmpPath } from "./test-paths.js";

describe("HarnessSessionRuntime", () => {
  beforeEach(() => {
    createSessionMock.mockReset();
    listModelsMock.mockReset();
    startMock.mockReset();
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
    startMock.mockResolvedValue(undefined);
    stopMock.mockResolvedValue(undefined);

    const runtime = new HarnessSessionRuntime({
      logger: createLogger(),
      runLogDir: tmpPath(),
      timeoutMs: 1_000,
      maxPromptMemoryChars: 5_000,
    });

    await runtime.run({
      prompt: "Review this.",
      modelConfig: createModelConfig(),
      model: "gpt-5.4",
      workingDirectory: tmpPath("workspace"),
      tenant: createTenant({
        projectMemoryBackend: {
          getCapability: vi.fn(async () => ({
            implemented: true as const,
            available: true as const,
          })),
          load,
          saveEntries,
        },
      }),
      tools: ["glob", "rg", "view", "add_memory_entry"],
      subagents: ["context-analyst", "review-author"],
      agent: "review-author",
    });

    const sessionOptions = createSessionMock.mock.calls[0]?.[0];
    expect(sessionOptions.workingDirectory).toBe(tmpPath("workspace"));
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
    startMock.mockResolvedValue(undefined);
    stopMock.mockResolvedValue(undefined);

    const runtime = new HarnessSessionRuntime({
      logger: createLogger(),
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
    expect(sessionOptions).not.toHaveProperty("workingDirectory");
  });

  it("omits reasoningEffort from createSession when no effort is requested", async () => {
    createSessionMock.mockResolvedValue(createSession());
    startMock.mockResolvedValue(undefined);
    stopMock.mockResolvedValue(undefined);

    const runtime = new HarnessSessionRuntime({
      logger: createLogger(),
      runLogDir: tmpPath(),
      timeoutMs: 1_000,
      maxPromptMemoryChars: 5_000,
    });

    await runtime.run({
      prompt: "Review this.",
      modelConfig: createModelConfig(),
      model: "gpt-5.6",
      tools: ["glob", "rg", "view"],
      subagents: [],
    });

    const sessionOptions = createSessionMock.mock.calls[0]?.[0];
    expect(
      Object.prototype.hasOwnProperty.call(sessionOptions, "reasoningEffort"),
    ).toBe(false);
  });

  it("passes an explicit reasoningEffort through to createSession unchanged", async () => {
    createSessionMock.mockResolvedValue(createSession());
    startMock.mockResolvedValue(undefined);
    stopMock.mockResolvedValue(undefined);

    const runtime = new HarnessSessionRuntime({
      logger: createLogger(),
      runLogDir: tmpPath(),
      timeoutMs: 1_000,
      maxPromptMemoryChars: 5_000,
    });

    await runtime.run({
      prompt: "Review this.",
      modelConfig: createModelConfig(),
      model: "gpt-5.6",
      reasoningEffort: "xhigh",
      tools: ["glob", "rg", "view"],
      subagents: [],
    });

    const sessionOptions = createSessionMock.mock.calls[0]?.[0];
    expect(sessionOptions.reasoningEffort).toBe("xhigh");
  });

  it("does not swallow SDK errors surfaced by createSession", async () => {
    const sdkError = new Error(
      'model "gpt-5.6" does not support reasoning effort "xhigh"',
    );
    createSessionMock.mockRejectedValue(sdkError);
    startMock.mockResolvedValue(undefined);
    stopMock.mockResolvedValue(undefined);

    const runtime = new HarnessSessionRuntime({
      logger: createLogger(),
      runLogDir: tmpPath(),
      timeoutMs: 1_000,
      maxPromptMemoryChars: 5_000,
    });

    await expect(
      runtime.run({
        prompt: "Review this.",
        modelConfig: createModelConfig(),
        model: "gpt-5.6",
        reasoningEffort: "xhigh",
        tools: ["glob", "rg", "view"],
        subagents: [],
      }),
    ).rejects.toThrow('does not support reasoning effort "xhigh"');
  });

  it("emits best-effort in-memory metrics on success and session failure", async () => {
    const onSuccess = vi.fn(async () => {});
    createSessionMock.mockResolvedValueOnce(
      createSession({
        events: [
          {
            type: "assistant.usage",
            data: { cost: 1 },
          } as SessionEvent,
        ],
      }),
    );
    startMock.mockResolvedValue(undefined);
    stopMock.mockResolvedValue(undefined);
    const runtime = new HarnessSessionRuntime({
      logger: createLogger(),
      runLogDir: tmpPath(),
      timeoutMs: 1_000,
      maxPromptMemoryChars: 5_000,
    });

    await runtime.run({
      prompt: "Review this.",
      modelConfig: createModelConfig(),
      model: "gpt-5.4",
      tools: [],
      subagents: [],
      logging: {
        interactionRunId: "run_1",
        interactionJobId: "job_1",
        tenantId: "tenant_1",
        sessionKind: "review",
        onMetrics: onSuccess,
      },
    });
    expect(onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        harness: "github.copilot-sdk",
        harnessSessionKey: "session_1",
        sessionType: "review",
        metrics: expect.objectContaining({
          usageByModel: [{ model: "gpt-5.4", amount: 1 }],
        }),
      }),
    );

    const onFailure = vi.fn(async () => {});
    const failedSession = createSession();
    failedSession.sendAndWait.mockRejectedValueOnce(
      new Error("session failed"),
    );
    createSessionMock.mockResolvedValueOnce(failedSession);
    await expect(
      runtime.run({
        prompt: "Review this.",
        modelConfig: createModelConfig(),
        tools: [],
        subagents: [],
        logging: {
          interactionRunId: "run_1",
          interactionJobId: "job_1",
          tenantId: "tenant_1",
          sessionKind: "reply",
          onMetrics: onFailure,
        },
      }),
    ).rejects.toThrow("session failed");
    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        harnessSessionKey: "session_1",
        sessionType: "reply",
      }),
    );
  });

  it("passes a native auth token only when no custom provider is configured", async () => {
    createSessionMock.mockResolvedValue(createSession());
    startMock.mockResolvedValue(undefined);
    stopMock.mockResolvedValue(undefined);

    const runtime = new HarnessSessionRuntime({
      logger: createLogger(),
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

  it("returns the bottom-most matching parsed payload when a response format is provided", async () => {
    createSessionMock.mockResolvedValue(
      createSession({
        responseContent: [
          "Here is the first draft.",
          JSON.stringify({
            items: ["stale"],
          }),
          JSON.stringify({
            items: ["fresh"],
          }),
        ].join("\n\n"),
      }),
    );
    startMock.mockResolvedValue(undefined);
    stopMock.mockResolvedValue(undefined);

    const runtime = new HarnessSessionRuntime({
      logger: createLogger(),
      runLogDir: tmpPath(),
      timeoutMs: 1_000,
      maxPromptMemoryChars: 5_000,
    });

    const result = await runtime.run({
      prompt: "Return a structured list.",
      modelConfig: createModelConfig(),
      tools: ["glob", "rg", "view"],
      subagents: [],
      responseFormat: {
        schema: z.object({
          items: z.array(z.string()),
        }),
      },
    });

    expect(result.parsed).toEqual({
      items: ["fresh"],
    });
    expect(result.parseError).toBeUndefined();
  });

  it("captures schema parse errors when no JSON object matches the response format", async () => {
    createSessionMock.mockResolvedValue(
      createSession({
        responseContent: JSON.stringify({
          note: "not the expected payload",
        }),
      }),
    );
    startMock.mockResolvedValue(undefined);
    stopMock.mockResolvedValue(undefined);

    const runtime = new HarnessSessionRuntime({
      logger: createLogger(),
      runLogDir: tmpPath(),
      timeoutMs: 1_000,
      maxPromptMemoryChars: 5_000,
    });

    const result = await runtime.run({
      prompt: "Return a structured list.",
      modelConfig: createModelConfig(),
      tools: ["glob", "rg", "view"],
      subagents: [],
      responseFormat: {
        schema: z.object({
          items: z.array(z.string()),
        }),
        looksLike: (value) => "items" in value,
      },
    });

    expect(result.parsed).toBeUndefined();
    expect(result.parseError).toEqual(
      expect.objectContaining({
        reason: "schema-mismatch",
        message:
          "Harness response contained JSON objects, but none matched the expected schema",
      }),
    );
    expect(result.parseError?.zodIssues).toBeDefined();
  });

  it("passes blob attachments through to the Copilot session", async () => {
    const session = createSession();
    createSessionMock.mockResolvedValue(session);
    listModelsMock.mockResolvedValue([
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        capabilities: {
          supports: {
            vision: true,
            reasoningEffort: true,
          },
          limits: {
            max_context_window_tokens: 1_000_000,
            vision: {
              supported_media_types: ["image/png"],
              max_prompt_images: 10,
              max_prompt_image_size: 10_000_000,
            },
          },
        },
      },
    ]);
    startMock.mockResolvedValue(undefined);
    stopMock.mockResolvedValue(undefined);

    const runtime = new HarnessSessionRuntime({
      logger: createLogger(),
      runLogDir: tmpPath(),
      timeoutMs: 1_000,
      maxPromptMemoryChars: 5_000,
    });

    await runtime.run({
      prompt: "Review this screenshot.",
      attachments: [
        {
          type: "blob",
          data: "AQID",
          mimeType: "image/png",
          displayName: "trigger-comment-55-diagram.png",
        },
      ],
      modelConfig: createModelConfig(),
      model: "gpt-5.4",
      tools: ["glob", "rg", "view"],
      subagents: [],
    });

    expect(session.sendAndWait).toHaveBeenCalledWith(
      {
        prompt: "Review this screenshot.",
        attachments: [
          {
            type: "blob",
            data: "AQID",
            mimeType: "image/png",
            displayName: "trigger-comment-55-diagram.png",
          },
        ],
      },
      1_000,
    );
  });

  it("skips image attachments when the selected model does not support vision", async () => {
    const session = createSession();
    createSessionMock.mockResolvedValue(session);
    listModelsMock.mockResolvedValue([
      {
        id: "gpt-5.4-mini",
        name: "GPT-5.4 mini",
        capabilities: {
          supports: {
            vision: false,
            reasoningEffort: false,
          },
          limits: {
            max_context_window_tokens: 128_000,
          },
        },
      },
    ]);
    startMock.mockResolvedValue(undefined);
    stopMock.mockResolvedValue(undefined);

    const logger = createLogger();
    const runtime = new HarnessSessionRuntime({
      logger,
      runLogDir: tmpPath(),
      timeoutMs: 1_000,
      maxPromptMemoryChars: 5_000,
    });

    await runtime.run({
      prompt: "Review this screenshot.",
      attachments: [
        {
          type: "blob",
          data: "AQID",
          mimeType: "image/png",
          displayName: "trigger-comment-55-diagram.png",
        },
      ],
      modelConfig: createModelConfig(),
      model: "gpt-5.4-mini",
      tools: ["glob", "rg", "view"],
      subagents: [],
      logging: {
        interactionRunId: "run_vision",
        interactionJobId: "job_vision",
        tenantId: "tenant_1",
        sessionKind: "reply",
      },
    });

    expect(session.sendAndWait).toHaveBeenCalledWith(
      {
        prompt: [
          "Review this screenshot.",
          "",
          "Runtime note:",
          'The selected model "gpt-5.4-mini" does not support vision in Copilot SDK. These image attachments were not sent to you: trigger-comment-55-diagram.png. Do not claim to have inspected the images. If the user is asking about them, explain that image input is unavailable for this model and answer from the available text context only.',
        ].join("\n"),
      },
      1_000,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        interactionRunId: "run_vision",
        interactionJobId: "job_vision",
        tenantId: "tenant_1",
        sessionKind: "reply",
        model: "gpt-5.4-mini",
      }),
      "selected model does not support vision in Copilot SDK; continuing without image attachments",
    );
  });

  it("reports image blobs that cannot be processed within model limits", async () => {
    const session = createSession();
    createSessionMock.mockResolvedValue(session);
    listModelsMock.mockResolvedValue([
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        capabilities: {
          supports: {
            vision: true,
            reasoningEffort: true,
          },
          limits: {
            max_context_window_tokens: 1_000_000,
            vision: {
              supported_media_types: ["image/png"],
              max_prompt_images: 10,
              max_prompt_image_size: 8,
            },
          },
        },
      },
    ]);
    startMock.mockResolvedValue(undefined);
    stopMock.mockResolvedValue(undefined);

    const logger = createLogger();
    const runtime = new HarnessSessionRuntime({
      logger,
      runLogDir: tmpPath(),
      timeoutMs: 1_000,
      maxPromptMemoryChars: 5_000,
    });

    await runtime.run({
      prompt: "Review this screenshot.",
      attachments: [
        {
          type: "blob",
          data: Buffer.alloc(32, 1).toString("base64"),
          mimeType: "image/png",
          displayName: "broken.png",
        },
      ],
      modelConfig: createModelConfig(),
      model: "gpt-5.4",
      tools: ["glob", "rg", "view"],
      subagents: [],
      logging: {
        interactionRunId: "run_image_limit",
        interactionJobId: "job_image_limit",
        tenantId: "tenant_1",
        sessionKind: "reply",
      },
    });

    expect(session.sendAndWait).toHaveBeenCalledWith(
      {
        prompt: [
          "Review this screenshot.",
          "",
          "Runtime note:",
          'The selected model "gpt-5.4" could not receive these images within its advertised vision limits. These image attachments were not sent to you: broken.png. Do not claim to have inspected the images. If the user is asking about them, explain that image input is unavailable for this model and answer from the available text context only.',
        ].join("\n"),
      },
      1_000,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.4",
        attachmentCount: 1,
      }),
      "image attachments could not be prepared for Copilot model limits; continuing with partial image context",
    );
  });

  it("skips image attachments for fallback sessions when the resolved model does not support vision", async () => {
    const session = createSession({ currentModelId: "gpt-5.4-mini" });
    createSessionMock.mockResolvedValue(session);
    listModelsMock.mockResolvedValue([
      {
        id: "gpt-5.4-mini",
        name: "GPT-5.4 mini",
        capabilities: {
          supports: {
            vision: false,
            reasoningEffort: false,
          },
          limits: {
            max_context_window_tokens: 128_000,
          },
        },
      },
    ]);
    startMock.mockResolvedValue(undefined);
    stopMock.mockResolvedValue(undefined);

    const logger = createLogger();
    const runtime = new HarnessSessionRuntime({
      logger,
      runLogDir: tmpPath(),
      timeoutMs: 1_000,
      maxPromptMemoryChars: 5_000,
    });

    await runtime.run({
      prompt: "Review this screenshot.",
      attachments: [
        {
          type: "blob",
          data: "AQID",
          mimeType: "image/png",
          displayName: "trigger-comment-55-diagram.png",
        },
      ],
      modelConfig: createFallbackModelConfig(),
      tools: ["glob", "rg", "view"],
      subagents: [],
      logging: {
        interactionRunId: "run_fallback_vision",
        interactionJobId: "job_fallback_vision",
        tenantId: "tenant_1",
        sessionKind: "reply",
      },
    });

    expect(session.rpc.model.getCurrent).toHaveBeenCalledOnce();
    expect(session.sendAndWait).toHaveBeenCalledWith(
      {
        prompt: [
          "Review this screenshot.",
          "",
          "Runtime note:",
          'The selected model "gpt-5.4-mini" does not support vision in Copilot SDK. These image attachments were not sent to you: trigger-comment-55-diagram.png. Do not claim to have inspected the images. If the user is asking about them, explain that image input is unavailable for this model and answer from the available text context only.',
        ].join("\n"),
      },
      1_000,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        interactionRunId: "run_fallback_vision",
        interactionJobId: "job_fallback_vision",
        tenantId: "tenant_1",
        sessionKind: "reply",
        model: "gpt-5.4-mini",
        modelProfileName: null,
      }),
      "selected model does not support vision in Copilot SDK; continuing without image attachments",
    );
  });

  it("keeps image attachments for fallback sessions when the resolved model cannot be verified", async () => {
    const session = createSession();
    createSessionMock.mockResolvedValue(session);
    listModelsMock.mockRejectedValue(new Error("models unavailable"));
    startMock.mockResolvedValue(undefined);
    stopMock.mockResolvedValue(undefined);

    const logger = createLogger();
    const runtime = new HarnessSessionRuntime({
      logger,
      runLogDir: tmpPath(),
      timeoutMs: 1_000,
      maxPromptMemoryChars: 5_000,
    });

    await runtime.run({
      prompt: "Review this screenshot.",
      attachments: [
        {
          type: "blob",
          data: "AQID",
          mimeType: "image/png",
          displayName: "trigger-comment-55-diagram.png",
        },
      ],
      modelConfig: createFallbackModelConfig(),
      tools: ["glob", "rg", "view"],
      subagents: [],
      logging: {
        interactionRunId: "run_fallback_unverified",
        interactionJobId: "job_fallback_unverified",
        tenantId: "tenant_1",
        sessionKind: "reply",
      },
    });

    expect(session.rpc.model.getCurrent).toHaveBeenCalledOnce();
    expect(session.sendAndWait).toHaveBeenCalledWith(
      {
        prompt: "Review this screenshot.",
        attachments: [
          {
            type: "blob",
            data: "AQID",
            mimeType: "image/png",
            displayName: "trigger-comment-55-diagram.png",
          },
        ],
      },
      1_000,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

function createSession(input?: {
  currentModelId?: string;
  responseContent?: string;
  events?: SessionEvent[];
}) {
  let eventHandler: ((event: SessionEvent) => void) | undefined;
  return {
    sessionId: "session_1",
    rpc: {
      model: {
        getCurrent: vi.fn(async () => ({
          modelId: input?.currentModelId,
        })),
      },
    },
    on: vi.fn((handler: (event: SessionEvent) => void) => {
      eventHandler = handler;
      return () => {};
    }),
    sendAndWait: vi.fn(async () => {
      for (const event of input?.events ?? []) {
        eventHandler?.(event);
      }
      return {
        data: {
          content:
            input?.responseContent ??
            JSON.stringify({
              overview: {
                summary: "Looks good",
                overallSeverity: "low",
              },
              findings: [],
              priorDispositions: [],
            }),
        },
      };
    }),
    disconnect: vi.fn(async () => {}),
  };
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => createLogger()),
  } as any;
}

function createModelConfig(): HarnessModelConfig {
  return {
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
  };
}

function createFallbackModelConfig(): HarnessModelConfig {
  return {
    modelProfileName: null,
    selectionSource: "fallback",
    reviewModel: null,
    textGenerationModel: null,
    reviewReasoningEffort: null,
    textGenerationReasoningEffort: null,
    authToken: null,
    provider: undefined,
    providerBaseUrl: null,
    providerType: null,
  };
}

function createTenant(
  overrides: Partial<HarnessTenantContext> = {},
): HarnessTenantContext {
  return {
    id: "tenant_1",
    memoryEnabled: true,
    projectMemoryBackend: {
      getCapability: vi.fn(async () => ({
        implemented: true as const,
        available: true as const,
      })),
      load: vi.fn(async () => ({
        enabled: true,
        page: null,
        entries: [],
      })),
      saveEntries: vi.fn(async (entries) => ({
        enabled: true,
        page: null,
        entries,
      })),
    },
    ...overrides,
  };
}
