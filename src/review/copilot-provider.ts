import { join } from "node:path";

import {
  CopilotClient,
  type AssistantMessageEvent,
  type SessionEvent,
  type PermissionHandler
} from "@github/copilot-sdk";
import type { Logger } from "pino";

import { CopilotRunLog } from "./copilot-run-log.js";
import { loadReviewPromptFile } from "./prompt-files.js";
import { buildReviewPrompt } from "./prompt.js";
import type { ReviewProvider } from "./provider.js";
import type { ReviewContext, ReviewResult } from "./types.js";
import { reviewResultSchema } from "./types.js";

interface CopilotReviewProviderOptions {
  logger: Logger;
  model?: string | undefined;
  cliPath?: string | undefined;
  runLogDir: string;
  timeoutMs: number;
}

export class CopilotReviewProvider implements ReviewProvider {
  public readonly name = "copilot-sdk";

  private readonly logger: Logger;
  private readonly model: string | undefined;
  private readonly cliPath: string | undefined;
  private readonly runLogDir: string;
  private readonly timeoutMs: number;

  public constructor(options: CopilotReviewProviderOptions) {
    this.logger = options.logger;
    this.model = options.model;
    this.cliPath = options.cliPath;
    this.runLogDir = options.runLogDir;
    this.timeoutMs = options.timeoutMs;
  }

  public async review(context: ReviewContext): Promise<ReviewResult> {
    const prompt = buildReviewPrompt(context);
    const runLog = new CopilotRunLog({
      logDir: join(context.logging?.runDirectory ?? this.runLogDir, "copilot"),
      context,
      prompt,
      model: this.model
    });
    const client = new CopilotClient({
      ...(this.cliPath ? { cliPath: this.cliPath } : {})
    });

    const permissionHandler: PermissionHandler = (request) => {
      if (request.kind === "read") {
        return { kind: "approve-once" };
      }

      return { kind: "user-not-available" };
    };

    let caughtError: unknown = null;

    try {
      const session = await client.createSession({
        onPermissionRequest: permissionHandler,
        workingDirectory: context.workspacePath,
        ...(this.model ? { model: this.model } : {}),
        availableTools: ["glob", "grep", "view"],
        customAgents: [
          {
            name: "context-analyst",
            displayName: "Context Analyst",
            description: "Gathers evidence from diffs, instructions, and nearby code",
            tools: ["glob", "grep", "view"],
            prompt: loadReviewPromptFile("context-analyst.md"),
            infer: true
          },
          {
            name: "review-author",
            displayName: "Review Author",
            description: "Produces GitLab-ready review findings and thread dispositions",
            tools: ["glob", "grep", "view"],
            prompt: loadReviewPromptFile("review-author.md"),
            infer: true
          }
        ],
        agent: "review-author"
      });
      runLog.setSessionId(session.sessionId);

      const unsubscribe = session.on((event: SessionEvent) => {
        runLog.appendEvent(event);
      });

      try {
        const response: AssistantMessageEvent | undefined = await session.sendAndWait({
          prompt
        }, this.timeoutMs);
        runLog.setResponse(response);
        const content = response?.data.content;
        if (!content) {
          throw new Error("Copilot review session returned no content");
        }

        return reviewResultSchema.parse(parseJsonResponse(content));
      } finally {
        unsubscribe();
        await session.disconnect();
      }
    } catch (error) {
      caughtError = error;
      runLog.setError(error);
      throw error;
    } finally {
      const logPath = await flushRunLog(runLog, this.logger);
      if (caughtError) {
        this.logger.error({ err: caughtError, copilotLogPath: logPath }, "copilot review provider failed");
      }
      await client.stop();
    }
  }
}

function parseJsonResponse(content: string): unknown {
  const trimmed = content.trim();

  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return JSON.parse(fenced[1].trim());
  }

  throw new Error("Copilot review output did not contain a JSON object");
}

async function flushRunLog(runLog: CopilotRunLog, logger: Logger): Promise<string | null> {
  try {
    return await runLog.flush();
  } catch (error) {
    logger.warn({ err: error, copilotLogPath: runLog.path }, "failed to write Copilot run log");
    return null;
  }
}
