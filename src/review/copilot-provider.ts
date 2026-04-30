import { join } from "node:path";

import {
  CopilotClient,
  defineTool,
  type AssistantMessageEvent,
  type SessionEvent,
  type PermissionHandler
} from "@github/copilot-sdk";
import type { Logger } from "pino";

import { GitLabClient } from "../gitlab/client.js";
import { ProjectMemoryTextCoalescer } from "../memory/coalescer.js";
import { projectMemoryToolInputSchema } from "../memory/types.js";
import { getProjectMemoryContentLength, updateProjectMemory } from "../memory/project-memory.js";
import { renderPrompt } from "../prompts/instruction-renderer.js";
import { CopilotRunLog } from "./copilot-run-log.js";
import { buildReviewPrompt } from "../prompts/prompt-builders.js";
import type { ReviewProvider } from "./provider.js";
import type { ReviewContext, ReviewResult } from "./types.js";
import { reviewResultSchema } from "./types.js";

const PROJECT_MEMORY_TOOL_NAME = "update_project_memory";

interface CopilotReviewProviderOptions {
  logger: Logger;
  model?: string | undefined;
  textGenerationModel: string;
  cliPath?: string | undefined;
  runLogDir: string;
  timeoutMs: number;
  maxPromptMemoryChars: number;
}

export class CopilotReviewProvider implements ReviewProvider {
  public readonly name = "copilot-sdk";

  private readonly logger: Logger;
  private readonly model: string | undefined;
  private readonly textGenerationModel: string;
  private readonly cliPath: string | undefined;
  private readonly runLogDir: string;
  private readonly timeoutMs: number;
  private readonly maxPromptMemoryChars: number;
  private readonly projectMemoryCoalescer: ProjectMemoryTextCoalescer;

  public constructor(options: CopilotReviewProviderOptions) {
    this.logger = options.logger;
    this.model = options.model;
    this.textGenerationModel = options.textGenerationModel;
    this.cliPath = options.cliPath;
    this.runLogDir = options.runLogDir;
    this.timeoutMs = options.timeoutMs;
    this.maxPromptMemoryChars = options.maxPromptMemoryChars;
    this.projectMemoryCoalescer = new ProjectMemoryTextCoalescer({
      logger: this.logger,
      model: this.textGenerationModel,
      cliPath: this.cliPath,
      timeoutMs: this.timeoutMs
    });
  }

  public async review(context: ReviewContext): Promise<ReviewResult> {
    const effectiveContext = await this.preparePromptContext(context);
    const prompt = buildReviewPrompt(effectiveContext, {
      maxPromptMemoryChars: this.maxPromptMemoryChars
    });
    const runLog = new CopilotRunLog({
      logDir: join(effectiveContext.logging?.runDirectory ?? this.runLogDir, "copilot"),
      context: effectiveContext,
      prompt,
      model: this.model
    });
    const client = new CopilotClient({
      ...(this.cliPath ? { cliPath: this.cliPath } : {})
    });

    const permissionHandler: PermissionHandler = (request) => {
      if (request.kind === "read" || request.kind === "custom-tool") {
        return { kind: "approve-once" };
      }

      return { kind: "user-not-available" };
    };

    let caughtError: unknown = null;
    let projectMemory = effectiveContext.projectMemory;

    try {
      const tools =
        effectiveContext.projectMemory.enabled && effectiveContext.projectMemoryWriteTarget
          ? [
              defineTool(PROJECT_MEMORY_TOOL_NAME, {
                description: "Persist durable project knowledge into the Reviewphin memory wiki page",
                parameters: {
                  type: "object",
                  additionalProperties: false,
                  required: ["memory", "rationale"],
                  properties: {
                    memory: {
                      type: "string",
                      description: "One durable project fact, preference, convention, or team policy to remember"
                    },
                    rationale: {
                      type: "string",
                      description: "Why this is long-term useful project memory instead of a one-off review detail"
                    },
                    supersedes: {
                      type: "array",
                      items: {
                        type: "string"
                      },
                      description: "Existing memory entries that should be replaced by the new memory"
                    }
                  }
                },
                handler: async (args) => {
                  const input = projectMemoryToolInputSchema.parse(args);
                  const target = effectiveContext.projectMemoryWriteTarget;
                  if (!target) {
                    throw new Error("Project memory write target was not configured");
                  }

                  const client = new GitLabClient({
                    baseUrl: target.baseUrl,
                    apiToken: target.apiToken,
                    logger: this.logger.child({
                      reviewRunId: effectiveContext.logging?.reviewRunId ?? null,
                      tenantId: effectiveContext.logging?.tenantId ?? null,
                      toolName: PROJECT_MEMORY_TOOL_NAME
                    })
                  });
                  const result = await updateProjectMemory(client, target.projectId, projectMemory, input, {
                    maxChars: this.maxPromptMemoryChars,
                    coalesce: async (coalesceInput) => this.coalesceProjectMemorySafely(coalesceInput, effectiveContext)
                  });
                  projectMemory = result.memory;
                  return result.changed
                    ? `Project memory ${result.action}; it now contains ${result.memory.entries.length} entr${result.memory.entries.length === 1 ? "y" : "ies"}.`
                    : "Project memory already contained that knowledge, so no wiki update was needed.";
                }
              })
            ]
          : [];

      const readOnlyTools = ["glob", "rg", "view"] as const;
      const reviewAuthorTools = [...readOnlyTools, ...(tools.length > 0 ? [PROJECT_MEMORY_TOOL_NAME] : [])];
      const session = await client.createSession({
        onPermissionRequest: permissionHandler,
        workingDirectory: effectiveContext.workspacePath,
        ...(this.model ? { model: this.model } : {}),
        tools,
        availableTools: reviewAuthorTools,
        customAgents: [
          {
            name: "context-analyst",
            displayName: "Context Analyst",
            description: "Gathers evidence from diffs, instructions, and nearby code",
            tools: [...readOnlyTools],
            prompt: renderPrompt("subagent.context-analyst", {}),
            infer: true
          },
          {
            name: "review-author",
            displayName: "Review Author",
            description: "Produces GitLab-ready review findings and thread dispositions",
            tools: reviewAuthorTools,
            prompt: renderPrompt("subagent.review-author", {}),
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

  private async preparePromptContext(context: ReviewContext): Promise<ReviewContext> {
    if (!context.projectMemory.enabled || getProjectMemoryContentLength(context.projectMemory.entries) <= this.maxPromptMemoryChars) {
      return context;
    }

      const entries = await this.coalesceProjectMemorySafely(
        {
          entries: context.projectMemory.entries,
          maxChars: this.maxPromptMemoryChars,
          targetChars: Math.floor(this.maxPromptMemoryChars * 0.75),
          reason: "prompt-budget"
        },
        context
      );

    return {
      ...context,
      projectMemory: {
        ...context.projectMemory,
        entries
      }
    };
  }

  private async coalesceProjectMemorySafely(
    input: {
      entries: ReviewContext["projectMemory"]["entries"];
      maxChars: number;
      targetChars: number;
      reason: "prompt-budget" | "save-threshold";
    },
    context: ReviewContext
  ): Promise<ReviewContext["projectMemory"]["entries"]> {
    try {
      return await this.projectMemoryCoalescer.coalesce(input);
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          reviewRunId: context.logging?.reviewRunId ?? null,
          tenantId: context.logging?.tenantId ?? null,
          reason: input.reason
        },
        "project memory coalescing failed; keeping existing memory entries"
      );
      return input.entries;
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
