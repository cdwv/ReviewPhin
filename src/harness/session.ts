import { join } from "node:path";

import {
  CopilotClient,
  type AssistantMessageEvent,
  type ModelInfo,
  type PermissionHandler,
  type CopilotSession,
  type SessionEvent,
} from "@github/copilot-sdk";
import type { Logger } from "pino";

import { ProjectMemoryConsolidator } from "../memory/consolidator.js";
import { ProjectMemoryService } from "../memory/service.js";
import { createId } from "../utils/ids.js";
import { parseHarnessStructuredResponse } from "./response-format.js";
import { resolveHarnessSubagents, resolveHarnessTools } from "./registry.js";
import { HarnessRunLog } from "./run-log.js";
import type {
  HarnessRunAttachment,
  HarnessRunResult,
  HarnessRunSpec,
} from "./types.js";

interface HarnessSessionRuntimeOptions {
  logger: Logger;
  runLogDir: string;
  timeoutMs: number;
  maxPromptMemoryChars: number;
  sdkLogLevel?:
    | "none"
    | "error"
    | "warning"
    | "info"
    | "debug"
    | "all"
    | undefined;
  cliPath?: string | undefined;
}

export class HarnessSessionRuntime {
  private readonly logger: Logger;
  private readonly runLogDir: string;
  private readonly timeoutMs: number;
  private readonly maxPromptMemoryChars: number;
  private readonly sdkLogLevel: HarnessSessionRuntimeOptions["sdkLogLevel"];
  private readonly cliPath: string | undefined;
  private readonly memoryConsolidator: ProjectMemoryConsolidator;

  public constructor(options: HarnessSessionRuntimeOptions) {
    this.logger = options.logger;
    this.runLogDir = options.runLogDir;
    this.timeoutMs = options.timeoutMs;
    this.maxPromptMemoryChars = options.maxPromptMemoryChars;
    this.sdkLogLevel = options.sdkLogLevel;
    this.cliPath = options.cliPath;
    this.memoryConsolidator = new ProjectMemoryConsolidator({
      runSession: async (spec) => this.run(spec),
    });
  }

  public async run<TParsed = unknown>(
    spec: HarnessRunSpec<TParsed>,
  ): Promise<HarnessRunResult<TParsed>> {
    const client = new CopilotClient({
      ...(!spec.modelConfig.provider && spec.modelConfig.authToken
        ? { gitHubToken: spec.modelConfig.authToken }
        : {}),
      ...(this.sdkLogLevel ? { logLevel: this.sdkLogLevel } : {}),
      ...(this.cliPath ? { cliPath: this.cliPath } : {}),
    });

    const runLog = new HarnessRunLog({
      logDir: resolveLogDir(this.runLogDir, spec),
      prompt: spec.prompt,
      model: spec.model,
      reasoningEffort: spec.reasoningEffort,
      logging: spec.logging,
      metadata: spec.metadata,
    });

    const permissionHandler: PermissionHandler = (request) => {
      if (request.kind === "read" || request.kind === "custom-tool") {
        return { kind: "approve-once" };
      }

      return { kind: "user-not-available" };
    };

    const memoryService = this.resolveMemoryService(spec);

    let caughtError: unknown = null;
    const events: SessionEvent[] = [];

    try {
      await client.start();
      const { registeredTools, availableTools, enabledToolIds } =
        resolveHarnessTools(spec.tools, {
          memoryService,
        });

      const session = await client.createSession({
        onPermissionRequest: permissionHandler,
        ...(spec.workingDirectory
          ? { workingDirectory: spec.workingDirectory }
          : {}),
        ...(spec.model ? { model: spec.model } : {}),
        ...(spec.reasoningEffort
          ? { reasoningEffort: spec.reasoningEffort }
          : {}),
        ...(spec.modelConfig.provider
          ? { provider: spec.modelConfig.provider }
          : {}),
        ...(spec.modelConfig.provider ? { enableConfigDiscovery: false } : {}),
        tools: registeredTools,
        availableTools,
        customAgents: resolveHarnessSubagents(spec.subagents, enabledToolIds),
        ...(spec.agent ? { agent: spec.agent } : {}),
      });
      runLog.setSessionId(session.sessionId);

      const unsubscribe = session.on((event: SessionEvent) => {
        events.push(event);
        runLog.appendEvent(event);
      });

      try {
        const preparedInput = await this.preparePromptInput(
          client,
          session,
          spec,
        );
        const response: AssistantMessageEvent | undefined =
          await session.sendAndWait(
            {
              prompt: preparedInput.prompt,
              ...(preparedInput.attachments &&
              preparedInput.attachments.length > 0
                ? { attachments: preparedInput.attachments }
                : {}),
            },
            spec.timeoutMs ?? this.timeoutMs,
          );
        runLog.setResponse(response);
        const structuredResponse = parseHarnessStructuredResponse(
          response?.data.content,
          spec.responseFormat,
        );
        return {
          response,
          events,
          ...structuredResponse,
        };
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
        this.logger.error(
          { err: caughtError, copilotLogPath: logPath },
          "harness session failed",
        );
      }
      await client.stop();
    }
  }

  public get consolidator(): ProjectMemoryConsolidator {
    return this.memoryConsolidator;
  }

  private async preparePromptInput(
    client: CopilotClient,
    session: CopilotSession,
    spec: HarnessRunSpec,
  ): Promise<{
    prompt: string;
    attachments: HarnessRunSpec["attachments"];
  }> {
    if (!spec.attachments || spec.attachments.length === 0) {
      return {
        prompt: spec.prompt,
        attachments: spec.attachments,
      };
    }

    if (
      !spec.attachments.some((attachment) =>
        attachmentRequiresVision(attachment),
      )
    ) {
      return {
        prompt: spec.prompt,
        attachments: spec.attachments,
      };
    }

    const omittedImageAttachments = spec.attachments.filter((attachment) =>
      attachmentRequiresVision(attachment),
    );

    const selectedModelId =
      spec.model ?? (await this.resolveCurrentSessionModelId(session));

    if (!selectedModelId) {
      return {
        prompt: spec.prompt,
        attachments: spec.attachments,
      };
    }

    let models: ModelInfo[];
    try {
      models = await client.listModels();
    } catch {
      return {
        prompt: spec.prompt,
        attachments: spec.attachments,
      };
    }

    const selectedModel = models.find((model) => model.id === selectedModelId);
    if (!selectedModel) {
      return {
        prompt: spec.prompt,
        attachments: spec.attachments,
      };
    }

    if (!selectedModel.capabilities.supports.vision) {
      return this.omitVisionAttachments(spec, omittedImageAttachments, {
        model: selectedModelId,
        promptReason: `The selected model "${selectedModelId}" does not support vision in Copilot SDK.`,
        logMessage:
          "selected model does not support vision in Copilot SDK; continuing without image attachments",
      });
    }

    return {
      prompt: spec.prompt,
      attachments: spec.attachments,
    };
  }

  private resolveMemoryService(
    spec: HarnessRunSpec,
  ): ProjectMemoryService | null {
    if (
      !spec.tenant?.memoryEnabled ||
      !spec.tools.includes("add_memory_entry")
    ) {
      return null;
    }

    return new ProjectMemoryService({
      logger: this.logger.child({
        interactionRunId: spec.logging?.interactionRunId ?? null,
        interactionJobId: spec.logging?.interactionJobId ?? null,
        tenantId: spec.logging?.tenantId ?? spec.tenant.id,
        component: "project-memory-service",
      }),
      backend: spec.tenant.projectMemoryBackend,
      consolidator: this.memoryConsolidator,
      modelConfig: spec.modelConfig,
      tenant: spec.tenant,
      logging: spec.logging,
      maxPromptMemoryChars: this.maxPromptMemoryChars,
    });
  }

  private async resolveCurrentSessionModelId(
    session: CopilotSession,
  ): Promise<string | null> {
    try {
      const currentModel = await session.rpc.model.getCurrent();
      return currentModel.modelId ?? null;
    } catch {
      return null;
    }
  }

  private omitVisionAttachments(
    spec: HarnessRunSpec,
    omittedImageAttachments: HarnessRunAttachment[],
    input: {
      model: string | null;
      promptReason: string;
      logMessage: string;
    },
  ): {
    prompt: string;
    attachments: HarnessRunSpec["attachments"];
  } {
    this.logger.warn(
      {
        interactionRunId: spec.logging?.interactionRunId ?? null,
        interactionJobId: spec.logging?.interactionJobId ?? null,
        tenantId: spec.logging?.tenantId ?? null,
        sessionKind: spec.logging?.sessionKind ?? null,
        model: input.model,
        modelProfileName: spec.modelConfig.modelProfileName,
        attachmentCount: spec.attachments?.length ?? 0,
      },
      input.logMessage,
    );

    const textOnlyAttachments = spec.attachments?.filter(
      (attachment) => !attachmentRequiresVision(attachment),
    );
    return {
      prompt: appendVisionUnavailableNote(spec.prompt, {
        model: input.model,
        omittedImageAttachments,
        reason: input.promptReason,
      }),
      attachments:
        textOnlyAttachments && textOnlyAttachments.length > 0
          ? textOnlyAttachments
          : undefined,
    };
  }
}

function resolveLogDir(baseLogDir: string, spec: HarnessRunSpec): string {
  const pathSegments =
    spec.logging?.pathSegments && spec.logging.pathSegments.length > 0
      ? spec.logging.pathSegments
      : ["copilot", createId("session")];
  return join(spec.logging?.runDirectory ?? baseLogDir, ...pathSegments);
}

async function flushRunLog(
  runLog: HarnessRunLog,
  logger: Logger,
): Promise<string | null> {
  try {
    return await runLog.flush();
  } catch (error) {
    logger.warn(
      { err: error, copilotLogPath: runLog.path },
      "failed to write Copilot run log",
    );
    return null;
  }
}

const IMAGE_FILE_EXTENSION_PATTERN =
  /\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)$/i;

function attachmentRequiresVision(attachment: HarnessRunAttachment): boolean {
  if (attachment.type === "blob") {
    return attachment.mimeType.toLowerCase().startsWith("image/");
  }

  if (attachment.type === "file") {
    return (
      IMAGE_FILE_EXTENSION_PATTERN.test(attachment.path) ||
      (typeof attachment.displayName === "string" &&
        IMAGE_FILE_EXTENSION_PATTERN.test(attachment.displayName))
    );
  }

  return false;
}

function appendVisionUnavailableNote(
  prompt: string,
  input: {
    model: string | null;
    omittedImageAttachments: HarnessRunAttachment[];
    reason: string;
  },
): string {
  const imageLabels = input.omittedImageAttachments
    .map((attachment) => describeAttachmentForPrompt(attachment))
    .filter(
      (value, index, values) =>
        value.length > 0 && values.indexOf(value) === index,
    );

  const describedImages =
    imageLabels.length > 0 ? imageLabels.join(", ") : "image attachments";

  return [
    prompt,
    "",
    "Runtime note:",
    `${input.reason} These image attachments were not sent to you: ${describedImages}. Do not claim to have inspected the images. If the user is asking about them, explain that image input is unavailable for this model and answer from the available text context only.`,
  ].join("\n");
}

function describeAttachmentForPrompt(attachment: HarnessRunAttachment): string {
  if (attachment.type === "blob") {
    return attachment.displayName ?? attachment.mimeType;
  }

  if (attachment.type === "file") {
    return attachment.displayName ?? attachment.path;
  }

  return attachment.type;
}
