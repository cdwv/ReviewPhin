import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";

describe("metrics CLI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints per-run metrics and summary percentiles for existing session logs", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-metrics-"));
    const runLogDir = join(workspace, "run-logs");

    await writeSessionLog(runLogDir, "run_001", {
      model: "gpt-5.4",
      premiumRequests: 1,
      inputTokens: 100,
      outputTokens: 10,
      toolCalls: 4,
      durationMs: 1000
    });
    await writeSessionLog(runLogDir, "run_002", {
      model: "claude-sonnet-4",
      premiumRequests: 2,
      inputTokens: 200,
      outputTokens: 20,
      toolCalls: 6,
      durationMs: 2000
    });
    await writeSessionLog(runLogDir, "run_003", {
      model: "gpt-5.4",
      premiumRequests: 3,
      inputTokens: 300,
      outputTokens: 30,
      toolCalls: 8,
      durationMs: 3000
    });

    let stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    });

    const exitCode = await runCli(["metrics", "sessions", "--run-log-dir", runLogDir]);

    expect(exitCode).toBe(0);

    const lines = stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim().replaceAll(/\s+/g, " "));

    expect(lines).toContain("run premiumRequests inputTokens outputTokens toolCalls durationMs");
    expect(lines).toContain("run_001 1 100 10 4 1000");
    expect(lines).toContain("run_002 2 200 20 6 2000");
    expect(lines).toContain("run_003 3 300 30 8 3000");
    expect(lines).toContain("stat premiumRequests inputTokens outputTokens toolCalls durationMs");
    expect(lines).toContain("min 1 100 10 4 1000");
    expect(lines).toContain("max 3 300 30 8 3000");
    expect(lines).toContain("avg 2 200 20 6 2000");
    expect(lines).toContain("p50 2 200 20 6 2000");
    expect(lines).toContain("p25 1.5 150 15 5 1500");
    expect(lines).toContain("p75 2.5 250 25 7 2500");
    expect(lines).toContain("p90 2.8 280 28 7.6 2800");
    expect(lines).toContain("model runs premiumRequests min max avg p25 p50 p75 p90");
    expect(lines).toContain("gpt-5.4 2 4 1 3 2 1.5 2 2.5 2.8");
    expect(lines).toContain("claude-sonnet-4 1 2 2 2 2 2 2 2 2");
  });
});

async function writeSessionLog(
  runLogDir: string,
  runName: string,
  metrics: {
    model: string;
    premiumRequests: number;
    inputTokens: number;
    outputTokens: number;
    toolCalls: number;
    durationMs: number;
  }
): Promise<void> {
  const copilotDir = join(runLogDir, runName, "copilot");
  await mkdir(copilotDir, { recursive: true });

  const events = [
    {
      id: `${runName}_turn_1`,
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "assistant.turn_start",
      ephemeral: false,
      data: {}
    },
    {
      id: `${runName}_usage_1`,
      parentId: `${runName}_turn_1`,
      timestamp: new Date().toISOString(),
      type: "assistant.usage",
      ephemeral: false,
      data: {
        model: metrics.model,
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        cost: metrics.premiumRequests,
        duration: metrics.durationMs
      }
    },
    ...Array.from({ length: metrics.toolCalls }, (_, index) => ({
      id: `${runName}_tool_${index + 1}`,
      parentId: `${runName}_turn_1`,
      timestamp: new Date().toISOString(),
      type: "tool.execution_start",
      ephemeral: false,
      data: {
        toolName: "view",
        arguments: {
          path: String.raw`H:\repo\src\file-${index + 1}.ts`
        }
      }
    }))
  ];

  await writeFile(
    join(copilotDir, "session.json"),
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        sessionId: runName,
        metadata: {
          reviewRunId: null,
          jobId: null,
          tenantId: null,
          mergeRequestIid: 1,
          workspacePath: String.raw`H:\repo`,
          requestedModel: metrics.model
        },
        prompt: `Prompt for ${runName}`,
        response: null,
        error: null,
        events
      },
      null,
      2
    ),
    "utf8"
  );
}