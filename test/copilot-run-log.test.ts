import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CopilotRunLog } from "../src/review/copilot-run-log.js";
import type { ReviewContext } from "../src/review/types.js";

describe("CopilotRunLog", () => {
  it("writes prompt, events, response, and error details to disk", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-logs-"));
    const context = {
      workspacePath: join("workspace", "review"),
      mergeRequest: {
        iid: 7
      },
      changes: [],
      notes: [],
      discussions: [],
      instructionFiles: [],
      priorThreads: [],
      logging: {
        reviewRunId: "run_123",
        jobId: "job_123",
        tenantId: "tenant_123"
      }
    } as unknown as ReviewContext;

    const runLog = new CopilotRunLog({
      logDir,
      context,
      prompt: "Return JSON only.",
      model: "gpt-5.4"
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
        deltaContent: "{\"overview\":"
      }
    });
    runLog.setResponse({
      id: "event_2",
      parentId: "event_1",
      timestamp: new Date().toISOString(),
      type: "assistant.message",
      data: {
        content: "{\"overview\":{\"summary\":\"ok\",\"overallSeverity\":\"low\"},\"findings\":[],\"priorDispositions\":[]}",
        messageId: "message_1",
        requestId: "req_123"
      }
    } as never);
    runLog.setError(new Error("Timeout after 60000ms waiting for session.idle"));

    const logPath = await runLog.flush();
    const written = JSON.parse(await readFile(logPath, "utf8"));

    expect(written.sessionId).toBe("session_123");
    expect(written.metadata.reviewRunId).toBe("run_123");
    expect(written.prompt).toBe("Return JSON only.");
    expect(written.events).toHaveLength(1);
    expect(written.response.content).toContain("\"overview\"");
    expect(written.error.message).toContain("Timeout after 60000ms");
  });
});
