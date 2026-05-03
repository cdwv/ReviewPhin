import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AssistantMessageEvent, SessionEvent } from "@github/copilot-sdk";

import type { ReviewContext } from "./types.js";

interface CopilotRunLogOptions {
  logDir: string;
  context: ReviewContext;
  prompt: string;
  model?: string | undefined;
}

interface SerializedError {
  message: string;
  name?: string | undefined;
  stack?: string | undefined;
}

export interface CopilotRunLogRecord {
  startedAt: string;
  finishedAt: string | null;
  sessionId: string | null;
  metadata: {
    interactionRunId: string | null;
    interactionJobId: string | null;
    tenantId: string | null;
    mergeRequestIid: number;
    workspacePath: string;
    requestedModel: string | null;
  };
  prompt: string;
  response:
    | {
        messageId: string;
        requestId: string | null;
        content: string;
      }
    | null;
  error: SerializedError | null;
  events: SessionEvent[];
}

export class CopilotRunLog {
  private readonly logDir: string;
  private readonly record: CopilotRunLogRecord;

  public constructor(options: CopilotRunLogOptions) {
    this.logDir = options.logDir;
    this.record = {
      startedAt: new Date().toISOString(),
      finishedAt: null,
      sessionId: null,
      metadata: {
        interactionRunId: options.context.logging?.interactionRunId ?? null,
        interactionJobId: options.context.logging?.interactionJobId ?? null,
        tenantId: options.context.logging?.tenantId ?? null,
        mergeRequestIid: options.context.mergeRequest.iid,
        workspacePath: options.context.workspacePath,
        requestedModel: options.model ?? null
      },
      prompt: options.prompt,
      response: null,
      error: null,
      events: []
    };
  }

  public get path(): string {
    return join(this.logDir, "session.json");
  }

  public setSessionId(sessionId: string): void {
    this.record.sessionId = sessionId;
  }

  public appendEvent(event: SessionEvent): void {
    this.record.events.push(event);
  }

  public setResponse(response: AssistantMessageEvent | undefined): void {
    if (!response) {
      return;
    }

    this.record.response = {
      messageId: response.data.messageId,
      requestId: response.data.requestId ?? null,
      content: response.data.content
    };
  }

  public setError(error: unknown): void {
    this.record.error = serializeError(error);
  }

  public async flush(): Promise<string> {
    this.record.finishedAt = new Date().toISOString();
    await mkdir(this.logDir, { recursive: true });
    await writeFile(this.path, JSON.stringify(this.record, null, 2), "utf8");
    return this.path;
  }
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack
    };
  }

  return {
    message: String(error)
  };
}
