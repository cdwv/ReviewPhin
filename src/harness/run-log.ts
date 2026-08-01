import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AssistantMessageEvent, SessionEvent } from "@github/copilot-sdk";

import type { ModelReasoningEffort } from "../storage/contract/index.js";
import { summarizeHarnessParseError } from "./response-format.js";
import type {
  HarnessRunLoggingContext,
  HarnessRunMetadata,
  HarnessRunParseError,
} from "./types.js";

interface HarnessRunLogOptions {
  logDir: string;
  prompt: string;
  model?: string | undefined;
  reasoningEffort?: ModelReasoningEffort | undefined;
  logging?: HarnessRunLoggingContext | undefined;
  metadata?: HarnessRunMetadata | undefined;
}

interface SerializedError {
  message: string;
  name?: string | undefined;
  stack?: string | undefined;
}

interface SerializedResponse {
  messageId: string;
  requestId: string | null;
  content: string;
}

interface HarnessStructuredOutputAttemptRecord {
  attempt: number;
  correctionAttempt: number;
  durationMs: number;
  response: SerializedResponse | null;
  failure: ReturnType<typeof summarizeHarnessParseError> | null;
  modelUsage: Array<{
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
    durationMs: number | null;
    premiumRequestCost: number | null;
    nanoAiu: number | null;
  }>;
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
    codeReviewId: number | null;
    workspacePath: string | null;
    requestedModel: string | null;
    requestedReasoningEffort: string | null;
    sessionKind: string | null;
  };
  prompt: string;
  response: SerializedResponse | null;
  structuredOutputAttempts: HarnessStructuredOutputAttemptRecord[];
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
        codeReviewId: options.metadata?.codeReviewId ?? null,
        workspacePath: options.metadata?.workspacePath ?? null,
        requestedModel: options.model ?? null,
        requestedReasoningEffort: options.reasoningEffort ?? null,
        sessionKind: options.logging?.sessionKind ?? null,
      },
      prompt: options.prompt,
      response: null,
      structuredOutputAttempts: [],
      error: null,
      events: [],
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
    this.record.response = serializeResponse(response);
  }

  public appendStructuredOutputAttempt(input: {
    attempt: number;
    correctionAttempt: number;
    durationMs: number;
    response: AssistantMessageEvent | undefined;
    parseError: HarnessRunParseError | undefined;
    events: SessionEvent[];
  }): void {
    this.record.structuredOutputAttempts.push({
      attempt: input.attempt,
      correctionAttempt: input.correctionAttempt,
      durationMs: input.durationMs,
      response: serializeResponse(input.response),
      failure: input.parseError
        ? summarizeHarnessParseError(input.parseError)
        : null,
      modelUsage: input.events
        .filter((event) => event.type === "assistant.usage")
        .map((event) => ({
          model: event.data.model,
          inputTokens: event.data.inputTokens ?? null,
          outputTokens: event.data.outputTokens ?? null,
          reasoningTokens: event.data.reasoningTokens ?? null,
          durationMs: event.data.duration ?? null,
          premiumRequestCost: event.data.cost ?? null,
          nanoAiu: event.data.copilotUsage?.totalNanoAiu ?? null,
        })),
    });
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

function serializeResponse(
  response: AssistantMessageEvent | undefined,
): SerializedResponse | null {
  if (!response) {
    return null;
  }

  return {
    messageId: response.data.messageId,
    requestId: response.data.requestId ?? null,
    content: response.data.content,
  };
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return {
    message: String(error),
  };
}
