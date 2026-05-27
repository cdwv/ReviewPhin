import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { HarnessRunLog } from "../src/harness/run-log.js";

describe("HarnessRunLog", () => {
  it("writes prompt, events, response, and error details to disk", async () => {
    const logDir = await mkdtemp(
      join(tmpdir(), "gitlab-agentic-webhooks-logs-"),
    );

    const runLog = new HarnessRunLog({
      logDir,
      prompt: "Return JSON only.",
      model: "gpt-5.4",
      logging: {
        interactionRunId: "run_123",
        interactionJobId: "job_123",
        tenantId: "tenant_123",
        sessionKind: "review",
      },
      metadata: {
        codeReviewId: 7,
        workspacePath: join("workspace", "review"),
      },
    });

    runLog.setSessionId("session_123");
    runLog.appendEvent({
      id: "event_1",
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "assistant.message_delta",
      ephemeral: true,
      data: {
        messageId: "message_1",
        deltaContent: '{"overview":',
      },
    });
    runLog.setResponse({
      id: "event_2",
      parentId: "event_1",
      timestamp: new Date().toISOString(),
      type: "assistant.message",
      data: {
        content:
          '{"overview":{"summary":"ok","overallSeverity":"low"},"findings":[],"priorDispositions":[]}',
        messageId: "message_1",
        requestId: "req_123",
      },
    } as never);
    runLog.setError(
      new Error("Timeout after 60000ms waiting for session.idle"),
    );

    const logPath = await runLog.flush();
    const written = JSON.parse(await readFile(logPath, "utf8"));

    expect(logPath).toBe(join(logDir, "session.json"));
    expect(written.sessionId).toBe("session_123");
    expect(written.metadata.interactionRunId).toBe("run_123");
    expect(written.prompt).toBe("Return JSON only.");
    expect(written.events).toHaveLength(1);
    expect(written.response.content).toContain('"overview"');
    expect(written.error.message).toContain("Timeout after 60000ms");
  });
});
