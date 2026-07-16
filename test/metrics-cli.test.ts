import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";
import type {
  MetricsCollectResult,
  MetricsSessionsResult,
} from "../src/metrics.js";
import {
  createGitLabConnectionRecord,
  createGitLabTenantInput,
} from "./helpers/gitlab-tenant.js";
import { openSqliteTestStorage } from "./helpers/storage.js";

describe("metrics CLI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("reports stored sessions by open usage unit and distinct review", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "reviewphin-metrics-"));
    const databasePath = join(workspace, "metrics.sqlite");
    const storage = await openSqliteTestStorage(databasePath);
    const run = await createRun(storage, "2026-06-15T12:00:00.000Z");
    await storage.stores.platformConnections.upsert(
      createGitLabConnectionRecord({ platformConnectionId: "connection-2" }),
    );
    const secondConnectionRun = await createRun(
      storage,
      "2026-06-20T12:00:00.000Z",
      { platformConnectionId: "connection-2", projectId: 456 },
    );
    const before = await createRun(storage, "2026-05-31T23:59:59.999Z");
    const after = await createRun(storage, "2026-07-01T00:00:00.000Z");
    await addMetrics(
      storage,
      run.id,
      "review-session",
      "review",
      1_000_000_000,
    );
    await addMetrics(storage, run.id, "reply-session", "reply", 500_000_000);
    await addMetrics(
      storage,
      secondConnectionRun.id,
      "second-connection-session",
      "review",
      250_000_000,
    );
    await addMetrics(storage, before.id, "before-session", "review", 10);
    await addMetrics(storage, after.id, "after-session", "review", 10);
    await storage.close();

    const stdout = captureStdout();
    expect(
      await runCli([
        "metrics",
        "sessions",
        "--sqlite-database-path",
        databasePath,
        "--connection",
        "test-connection-1",
        "--from",
        "2026-06-01",
        "--to",
        "2026-06-30",
        "--output",
        "json",
      ]),
    ).toBe(0);

    const result = JSON.parse(stdout.value()) as MetricsSessionsResult;
    expect(result.units).toHaveLength(1);
    expect(result.units[0]?.unit).toBe("github.copilot.nano-ai-unit");
    expect(result.units[0]?.runs[0]).toMatchObject({
      interactionRunId: run.id,
      sessions: 2,
      usageAmount: 1_500_000_000,
    });
    expect(result.units[0]?.models).toEqual([
      {
        model: "gpt-5.4",
        reviews: 1,
        usageAmount: 1_500_000_000,
        averageCostPerReview: 1_500_000_000,
      },
    ]);
    expect(result.units[0]?.sessionTypes.map((row) => row.sessionType)).toEqual(
      ["reply", "review"],
    );
    expect(result.units[0]?.tenants).toEqual([
      expect.objectContaining({
        tenantKey: "https://gitlab.example.com::123",
        reviews: 1,
        sessions: 2,
        usageAmount: 1_500_000_000,
      }),
    ]);
    expect(result.units[0]?.connections).toEqual([
      expect.objectContaining({
        connectionName: "test-connection-1",
        reviews: 1,
        sessions: 2,
        usageAmount: 1_500_000_000,
      }),
    ]);

    vi.restoreAllMocks();
    const chart = captureStdout();
    await runCli(
      [
        "metrics",
        "sessions",
        "--sqlite-database-path",
        databasePath,
        "--from",
        "2026-06-01",
        "--to",
        "2026-06-30",
      ],
      {
        stdoutIsTTY: true,
        columns: 100,
        color: false,
        unicode: true,
      },
    );
    expect(chart.value()).toContain("monthly by model");
    expect(chart.value()).toContain("█ gpt-5.4");
    expect(chart.value()).toContain("usage by tenant");
    expect(chart.value()).toContain("usage by connection");
    expect(chart.value()).toContain("https://gitlab.example.com::456");
    expect(chart.value()).toContain("test-connection-2");
    expect(chart.value()).not.toContain(run.id);

    vi.restoreAllMocks();
    const narrow = captureStdout();
    await runCli(
      [
        "metrics",
        "sessions",
        "--sqlite-database-path",
        databasePath,
        "--from",
        "2026-06-01",
        "--to",
        "2026-06-30",
      ],
      {
        stdoutIsTTY: true,
        columns: 60,
        color: false,
        unicode: true,
      },
    );
    expect(narrow.value()).not.toContain("monthly by model");
    expect(narrow.value()).not.toContain("usage by tenant");
    expect(narrow.value()).not.toContain("usage by connection");
    expect(narrow.value()).toContain("by session type");
    expect(narrow.value()).toContain("by tenant");
    expect(narrow.value()).toContain("by connection");
    expect(narrow.value()).not.toContain(run.id);

    vi.restoreAllMocks();
    const detailed = captureStdout();
    await runCli([
      "metrics",
      "sessions",
      "--sqlite-database-path",
      databasePath,
      "--from",
      "2026-06-01",
      "--to",
      "2026-06-30",
      "--all-sessions",
      "--output",
      "plain",
    ]);
    expect(detailed.value()).toContain("sessions");
    expect(detailed.value()).toContain(run.id);
  });

  it("collects, updates, and leaves source session files in place", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "reviewphin-collect-"));
    const databasePath = join(workspace, "metrics.sqlite");
    const runLogDir = join(workspace, "run-logs");
    const storage = await openSqliteTestStorage(databasePath);
    const run = await createRun(storage, "2026-06-15T12:00:00.000Z");
    await storage.close();
    const sessionPath = await writeSessionLog(runLogDir, run.id, 1_250_000_000);

    const preview = captureStdout();
    await runCli([
      "metrics",
      "collect",
      "--sqlite-database-path",
      databasePath,
      "--run-log-dir",
      runLogDir,
      "--dry-run",
      "--output",
      "json",
    ]);
    expect(JSON.parse(preview.value()) as MetricsCollectResult).toMatchObject({
      dryRun: true,
      imported: 1,
    });

    vi.restoreAllMocks();
    const first = captureStdout();
    expect(
      await runCli([
        "metrics",
        "collect",
        "--sqlite-database-path",
        databasePath,
        "--run-log-dir",
        runLogDir,
        "--output",
        "json",
      ]),
    ).toBe(0);
    expect(JSON.parse(first.value()) as MetricsCollectResult).toMatchObject({
      imported: 1,
      updated: 0,
      unchanged: 0,
    });

    vi.restoreAllMocks();
    const second = captureStdout();
    await runCli([
      "metrics",
      "collect",
      "--sqlite-database-path",
      databasePath,
      "--run-log-dir",
      runLogDir,
      "--output",
      "json",
    ]);
    expect(JSON.parse(second.value()) as MetricsCollectResult).toMatchObject({
      imported: 0,
      updated: 0,
      unchanged: 1,
    });

    await writeSessionLog(runLogDir, run.id, 2_000_000_000);
    vi.restoreAllMocks();
    const third = captureStdout();
    await runCli([
      "metrics",
      "collect",
      "--sqlite-database-path",
      databasePath,
      "--run-log-dir",
      runLogDir,
      "--output",
      "json",
    ]);
    expect(JSON.parse(third.value()) as MetricsCollectResult).toMatchObject({
      imported: 0,
      updated: 1,
      unchanged: 0,
    });
    const verified = await openSqliteTestStorage(databasePath);
    expect(
      await verified.stores.interactionRunMetrics.find({
        harnessSessionKey: { eq: "collected-session" },
      }),
    ).toMatchObject({
      sessionType: "review",
      usageAmount: 2_000_000_000,
    });
    await verified.close();
    await expect(access(sessionPath)).resolves.toBeUndefined();
  });

  it("collects BYOK zero cost as unavailable usage", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "reviewphin-byok-metrics-"));
    const databasePath = join(workspace, "metrics.sqlite");
    const runLogDir = join(workspace, "run-logs");
    const storage = await openSqliteTestStorage(databasePath);
    const run = await createRun(storage, "2026-06-15T12:00:00.000Z", {
      providerBaseUrl: "https://llm.example.com/v1",
      providerType: "openai",
    });
    await storage.close();
    await writeCostSessionLog(runLogDir, run.id, 0);

    captureStdout();
    await runCli([
      "metrics",
      "collect",
      "--sqlite-database-path",
      databasePath,
      "--run-log-dir",
      runLogDir,
      "--output",
      "json",
    ]);

    const verified = await openSqliteTestStorage(databasePath);
    expect(
      await verified.stores.interactionRunMetrics.find({
        harnessSessionKey: { eq: "collected-byok-session" },
      }),
    ).toMatchObject({
      usageUnit: null,
      usageAmount: null,
      usageByModelJson: "[]",
    });
    await verified.close();
  });

  it("attributes legacy usage without a model breakdown to unknown", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "reviewphin-legacy-metrics-"),
    );
    const databasePath = join(workspace, "metrics.sqlite");
    const storage = await openSqliteTestStorage(databasePath);
    const run = await createRun(storage, "2026-06-15T12:00:00.000Z");
    await addMetrics(storage, run.id, "legacy-session", "unknown", 5);
    const metric = await storage.stores.interactionRunMetrics.find({
      harnessSessionKey: { eq: "legacy-session" },
    });
    await storage.stores.interactionRunMetrics.patch({
      id: metric!.id,
      value: { usageByModelJson: "[]" },
    });
    await storage.close();

    const stdout = captureStdout();
    await runCli([
      "metrics",
      "sessions",
      "--sqlite-database-path",
      databasePath,
      "--output",
      "json",
    ]);

    const result = JSON.parse(stdout.value()) as MetricsSessionsResult;
    expect(result.units[0]?.models).toEqual([
      {
        model: "unknown",
        reviews: 1,
        usageAmount: 5,
        averageCostPerReview: 5,
      },
    ]);
    expect(result.units[0]?.monthly).toEqual([
      {
        month: "2026-06",
        total: 5,
        models: [{ model: "unknown", amount: 5 }],
      },
    ]);
  });

  it("keeps custom and unreported usage in separate unit groups", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "reviewphin-mixed-metrics-"),
    );
    const databasePath = join(workspace, "metrics.sqlite");
    const storage = await openSqliteTestStorage(databasePath);
    const run = await createRun(storage, "2026-06-15T12:00:00.000Z");
    await addMetrics(storage, run.id, "nano-session", "review", 1_000_000_000);
    await addMetrics(
      storage,
      run.id,
      "custom-session",
      "custom",
      7,
      "example.custom-harness.credit",
    );
    await addMetrics(
      storage,
      run.id,
      "unreported-session",
      "custom",
      null,
      null,
    );
    await storage.close();

    const stdout = captureStdout();
    await runCli([
      "metrics",
      "sessions",
      "--sqlite-database-path",
      databasePath,
      "--output",
      "json",
    ]);

    const result = JSON.parse(stdout.value()) as MetricsSessionsResult;
    expect(result.units.map((group) => group.unit)).toEqual([
      "example.custom-harness.credit",
      "github.copilot.nano-ai-unit",
      null,
    ]);
    expect(result.units.map((group) => group.runs[0]?.usageAmount)).toEqual([
      7,
      1_000_000_000,
      null,
    ]);
  });

  it("does not load platform modules for metrics-only commands", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "reviewphin-metrics-platform-"),
    );
    const databasePath = join(workspace, "metrics.sqlite");
    const storage = await openSqliteTestStorage(databasePath);
    await storage.close();
    vi.stubEnv("PLATFORM_MODULES", "./missing-platform-module.js");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(
      runCli(["metrics", "sessions", "--sqlite-database-path", databasePath]),
    ).resolves.toBe(0);
  });
});

async function createRun(
  storage: Awaited<ReturnType<typeof openSqliteTestStorage>>,
  startedAt: string,
  options: {
    platformConnectionId?: string;
    projectId?: number;
    providerBaseUrl?: string;
    providerType?: "openai" | "azure" | "anthropic";
  } = {},
) {
  const tenant = await storage.upsertTenant(createGitLabTenantInput(options));
  const { job } = await storage.createOrGetInteractionJob({
    tenantId: tenant.id,
    dedupeKey: `metrics-${tenant.key}-${startedAt}`,
    codeReviewId: options.projectId ?? 7,
    commentId: 1,
    triggerJson: JSON.stringify({ kind: "comment", commentId: 1 }),
    headSha: "abc123",
    payloadJson: "{}",
  });
  const run = await storage.createInteractionRun({
    interactionJobId: job.id,
    tenantId: tenant.id,
    provider: "copilot-sdk",
    model: "gpt-5.4",
    modelProfileName: null,
    providerBaseUrl: options.providerBaseUrl ?? null,
    providerType: options.providerType ?? null,
    textGenerationModel: null,
  });
  await storage.stores.interactionRuns.patch({
    id: run.id,
    value: { startedAt },
  });
  return { ...run, startedAt };
}

async function addMetrics(
  storage: Awaited<ReturnType<typeof openSqliteTestStorage>>,
  interactionRunId: string,
  harnessSessionKey: string,
  sessionType: string,
  usageAmount: number | null,
  usageUnit: string | null = "github.copilot.nano-ai-unit",
): Promise<void> {
  await storage.upsertInteractionRunMetrics({
    interactionRunId,
    harness: "github.copilot-sdk",
    harnessSessionKey,
    sessionType,
    triggerKind: "manual-review",
    promptMode: sessionType,
    promptChars: 10,
    promptContextChangedFiles: 1,
    promptContextPriorDiscussions: 0,
    promptContextComments: 1,
    assistantTurns: 1,
    assistantCalls: 1,
    toolExecutions: 1,
    viewToolCalls: 1,
    globToolCalls: 0,
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    apiDurationMs: 1_000,
    usageUnit,
    usageAmount,
    usageByModelJson: JSON.stringify(
      usageAmount === null ? [] : [{ model: "gpt-5.4", amount: usageAmount }],
    ),
    repeatedViewReads: 0,
    repeatedViewPathsJson: "[]",
  });
}

async function writeSessionLog(
  runLogDir: string,
  interactionRunId: string,
  totalNanoAiu: number,
): Promise<string> {
  const directory = join(runLogDir, interactionRunId, "copilot", "reviewer");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "session.json");
  await writeFile(
    path,
    JSON.stringify({
      startedAt: "2026-06-15T12:00:00.000Z",
      finishedAt: "2026-06-15T12:01:00.000Z",
      sessionId: "collected-session",
      metadata: {
        interactionRunId,
        interactionJobId: "job",
        parentInteractionRunId: null,
        tenantId: "tenant",
        codeReviewId: 7,
        workspacePath: null,
        requestedModel: "gpt-5.4",
        requestedReasoningEffort: null,
        sessionKind: null,
      },
      prompt: "Review",
      response: null,
      error: null,
      events: [
        {
          type: "assistant.usage",
          data: {
            model: "gpt-5.4",
            inputTokens: 100,
            outputTokens: 10,
            duration: 1_000,
            copilotUsage: { totalNanoAiu },
          },
        },
      ],
    }),
    "utf8",
  );
  return path;
}

async function writeCostSessionLog(
  runLogDir: string,
  interactionRunId: string,
  cost: number,
): Promise<void> {
  const directory = join(runLogDir, interactionRunId, "copilot", "reviewer");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "session.json"),
    JSON.stringify({
      sessionId: "collected-byok-session",
      metadata: {
        interactionRunId,
        requestedModel: "custom-model",
        sessionKind: "review",
      },
      prompt: "Review",
      events: [
        {
          type: "assistant.usage",
          data: { model: "custom-model", cost },
        },
      ],
    }),
    "utf8",
  );
}

function captureStdout(): { value: () => string } {
  let stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation(
    (chunk: string | Uint8Array) => {
      stdout +=
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
  );
  return { value: () => stdout.trim() };
}
