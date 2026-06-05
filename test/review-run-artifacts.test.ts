import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { InteractionRunArtifacts } from "../src/review/run-artifacts.js";

describe("InteractionRunArtifacts", () => {
  it("writes app and platform HTTP logs into the review run directory", async () => {
    const rootDir = await mkdtemp(
      join(tmpdir(), "gitlab-agentic-webhooks-run-logs-"),
    );
    const artifacts = new InteractionRunArtifacts(rootDir, "run_123");

    await artifacts.initialize();
    await artifacts.appendAppLog({
      timestamp: new Date().toISOString(),
      level: "info",
      message: "started",
      data: {
        jobId: "job_123",
      },
    });
    await artifacts.appendPlatformHttpLog({
      timestamp: new Date().toISOString(),
      requestId: "req_1",
      phase: "response",
      method: "POST",
      path: "/projects/1/merge_requests/2/discussions",
      requestUrl:
        "https://gitlab.example.com/api/v4/projects/1/merge_requests/2/discussions",
      status: 400,
      response: {
        body: '{"message":"position is invalid"}',
      },
    });

    expect(
      JSON.parse((await readFile(artifacts.appLogPath, "utf8")).trim()),
    ).toMatchObject({
      message: "started",
      data: {
        jobId: "job_123",
      },
    });
    expect(
      JSON.parse(
        (await readFile(artifacts.platformHttpLogPath, "utf8")).trim(),
      ),
    ).toMatchObject({
      requestId: "req_1",
      status: 400,
    });
    expect(artifacts.copilotDirectory).toBe(
      join(rootDir, "run_123", "copilot"),
    );
  });

  it("writes JSON artifacts into nested directories using platform-safe paths", async () => {
    const rootDir = await mkdtemp(
      join(tmpdir(), "gitlab-agentic-webhooks-run-logs-"),
    );
    const artifacts = new InteractionRunArtifacts(rootDir, "run_123");

    await artifacts.writeJsonArtifact(
      join("orchestration", "reply-result.json"),
      {
        status: "ok",
      },
    );

    expect(
      JSON.parse(
        await readFile(
          join(rootDir, "run_123", "orchestration", "reply-result.json"),
          "utf8",
        ),
      ),
    ).toEqual({
      status: "ok",
    });
  });
});
