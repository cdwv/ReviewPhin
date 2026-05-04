import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AssistantMessageEvent, SessionEvent } from "@github/copilot-sdk";

import type { HarnessRunLoggingContext, HarnessRunMetadata } from "./types.js";

interface HarnessRunLogOptions {
  logDir: string;
  prompt: string;
  model?: string | undefined;
  logging?: HarnessRunLoggingContext | undefined;
  metadata?: HarnessRunMetadata | undefined;
}

interface SerializedError {
  message: string;
  name?: string | undefined;
  stack?: string | undefined;
}

export interface HarnessRunLogRecord {
  startedAt: string;
  finishedAt: string | null;
  sessionId: string | null;
  metadata: {
    interactionRunId: string | null;
    interactionJobId: string | null;
    parentInteractionRunId: string | null;
    tenantId: string | null;
    mergeRequestIid: number | null;
    workspacePath: string | null;
    requestedModel: string | null;
    sessionKind: string | null;
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

export class HarnessRunLog {
  private readonly logDir: string;
  private readonly record: HarnessRunLogRecord;

  public constructor(options: HarnessRunLogOptions) {
    this.logDir = options.logDir;
    this.record = {
      startedAt: new Date().toISOString(),
      finishedAt: null,
      sessionId: null,
      metadata: {
        interactionRunId: options.logging?.interactionRunId ?? null,
        interactionJobId: options.logging?.interactionJobId ?? null,
        parentInteractionRunId: options.logging?.parentInteractionRunId ?? null,
        tenantId: options.logging?.tenantId ?? null,
        mergeRequestIid: options.metadata?.mergeRequestIid ?? null,
        workspacePath: options.metadata?.workspacePath ?? null,
        requestedModel: options.model ?? null,
        sessionKind: options.logging?.sessionKind ?? null
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
