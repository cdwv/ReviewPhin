import { describe, expect, it } from "vitest";

import { summarizeHarnessRunLog } from "../src/harness/run-metrics.js";
import { repoPath } from "./test-paths.js";

describe("Copilot run metrics", () => {
  it("summarizes assistant usage and repeated view reads", () => {
    const workspacePath = repoPath();
    const alphaPath = repoPath("src", "alpha.ts");
    const betaPath = repoPath("src", "beta.ts");
    const metrics = summarizeHarnessRunLog({
      metadata: {
        interactionRunId: "run_1",
        interactionJobId: "job_1",
        parentInteractionRunId: null,
        tenantId: "tenant_1",
        codeReviewId: 7,
        workspacePath,
        requestedModel: "gpt-5.4",
        requestedReasoningEffort: null,
        sessionKind: "review",
      },
      prompt: "Review this merge request.",
      events: [
        {
          id: "turn_1",
          parentId: null,
          timestamp: new Date().toISOString(),
          type: "assistant.turn_start",
          ephemeral: false,
          data: {},
        },
        {
          id: "usage_1",
          parentId: "turn_1",
          timestamp: new Date().toISOString(),
          type: "assistant.usage",
          ephemeral: false,
          data: {
            model: "gpt-5.4",
            inputTokens: 100,
            outputTokens: 10,
            cacheReadTokens: 50,
            cacheWriteTokens: 0,
            reasoningTokens: 7,
            cost: 1,
            duration: 1_500,
          },
        },
        {
          id: "turn_2",
          parentId: null,
          timestamp: new Date().toISOString(),
          type: "assistant.turn_start",
          ephemeral: false,
          data: {},
        },
        {
          id: "usage_2",
          parentId: "turn_2",
          timestamp: new Date().toISOString(),
          type: "assistant.usage",
          ephemeral: false,
          data: {
            model: "claude-sonnet-4",
            inputTokens: 120,
            outputTokens: 14,
            cacheReadTokens: 60,
            cacheWriteTokens: 5,
            reasoningTokens: 3,
            cost: 1,
            duration: 2_500,
          },
        },
        {
          id: "tool_1",
          parentId: "turn_1",
          timestamp: new Date().toISOString(),
          type: "tool.execution_start",
          ephemeral: false,
          data: {
            toolName: "view",
            arguments: {
              path: alphaPath,
            },
          },
        },
        {
          id: "tool_2",
          parentId: "turn_1",
          timestamp: new Date().toISOString(),
          type: "tool.execution_start",
          ephemeral: false,
          data: {
            toolName: "view",
            arguments: {
              path: alphaPath,
            },
          },
        },
        {
          id: "tool_3",
          parentId: "turn_2",
          timestamp: new Date().toISOString(),
          type: "tool.execution_start",
          ephemeral: false,
          data: {
            toolName: "view",
            arguments: {
              path: betaPath,
            },
          },
        },
        {
          id: "tool_4",
          parentId: "turn_2",
          timestamp: new Date().toISOString(),
          type: "tool.execution_start",
          ephemeral: false,
          data: {
            toolName: "glob",
            arguments: {
              pattern: "src/**/*.ts",
            },
          },
        },
      ] as never,
    });

    expect(metrics.promptChars).toBe(26);
    expect(metrics.assistantTurns).toBe(2);
    expect(metrics.assistantCalls).toBe(2);
    expect(metrics.toolExecutions).toBe(4);
    expect(metrics.viewToolCalls).toBe(3);
    expect(metrics.globToolCalls).toBe(1);
    expect(metrics.inputTokens).toBe(220);
    expect(metrics.outputTokens).toBe(24);
    expect(metrics.cacheReadTokens).toBe(110);
    expect(metrics.cacheWriteTokens).toBe(5);
    expect(metrics.reasoningTokens).toBe(10);
    expect(metrics.apiDurationMs).toBe(4_000);
    expect(metrics.usageUnit).toBe("github.copilot.premium-request");
    expect(metrics.usageAmount).toBe(2);
    expect(metrics.usageByModel).toEqual([
      {
        model: "claude-sonnet-4",
        amount: 1,
      },
      {
        model: "gpt-5.4",
        amount: 1,
      },
    ]);
    expect(metrics.repeatedViewReads).toBe(1);
    expect(metrics.repeatedViewPaths).toEqual([
      {
        path: alphaPath,
        count: 2,
      },
    ]);
  });

  it("prefers exact nano-AI-unit usage when the current field is present", () => {
    const metrics = summarizeHarnessRunLog({
      prompt: "Review",
      events: [
        {
          type: "assistant.usage",
          data: {
            model: "gpt-5.4",
            cost: 2,
            copilotUsage: { totalNanoAiu: 1_250_000_000 },
          },
        },
      ] as never,
    });

    expect(metrics.usageUnit).toBe("github.copilot.nano-ai-unit");
    expect(metrics.usageAmount).toBe(1_250_000_000);
    expect(metrics.usageByModel).toEqual([
      { model: "gpt-5.4", amount: 1_250_000_000 },
    ]);
  });

  it("distinguishes missing billable usage from reported zero", () => {
    expect(
      summarizeHarnessRunLog({ prompt: "Review", events: [] }).usageAmount,
    ).toBeNull();
    expect(
      summarizeHarnessRunLog({
        prompt: "Review",
        events: [
          {
            type: "assistant.usage",
            data: { model: "gpt-5.4", cost: 0 },
          },
        ] as never,
      }),
    ).toMatchObject({
      usageUnit: "github.copilot.premium-request",
      usageAmount: 0,
    });
  });
});
