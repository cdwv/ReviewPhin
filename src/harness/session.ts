import { join } from "node:path";

import {
  CopilotClient,
  type AssistantMessageEvent,
  type PermissionHandler,
  type SessionEvent
} from "@github/copilot-sdk";
import type { Logger } from "pino";

import type { ProjectMemoryBackendFactory } from "../memory/backend.js";
import { ProjectMemoryConsolidator } from "../memory/consolidator.js";
import { ProjectMemoryService } from "../memory/service.js";
import { createId } from "../utils/ids.js";
import { resolveHarnessSubagents, resolveHarnessTools } from "./registry.js";
import { HarnessRunLog } from "./run-log.js";
import type { HarnessRunResult, HarnessRunSpec } from "./types.js";

interface HarnessSessionRuntimeOptions {
  logger: Logger;
  projectMemoryBackendFactory: ProjectMemoryBackendFactory;
  runLogDir: string;
  timeoutMs: number;
  maxPromptMemoryChars: number;
  sdkLogLevel?: "none" | "error" | "warning" | "info" | "debug" | "all" | undefined;
  cliPath?: string | undefined;
}

export class HarnessSessionRuntime {
  private readonly logger: Logger;
  private readonly projectMemoryBackendFactory: ProjectMemoryBackendFactory;
  private readonly runLogDir: string;
  private readonly timeoutMs: number;
  private readonly maxPromptMemoryChars: number;
  private readonly sdkLogLevel: HarnessSessionRuntimeOptions["sdkLogLevel"];
  private readonly cliPath: string | undefined;
  private readonly memoryConsolidator: ProjectMemoryConsolidator;

  public constructor(options: HarnessSessionRuntimeOptions) {
    this.logger = options.logger;
    this.projectMemoryBackendFactory = options.projectMemoryBackendFactory;
    this.runLogDir = options.runLogDir;
    this.timeoutMs = options.timeoutMs;
    this.maxPromptMemoryChars = options.maxPromptMemoryChars;
    this.sdkLogLevel = options.sdkLogLevel;
    this.cliPath = options.cliPath;
    this.memoryConsolidator = new ProjectMemoryConsolidator({
      runSession: async (spec) => this.run(spec)
    });
  }

  public async run(spec: HarnessRunSpec): Promise<HarnessRunResult> {
    const client = new CopilotClient({
      ...(!spec.modelConfig.provider && spec.modelConfig.authToken
        ? { gitHubToken: spec.modelConfig.authToken }
        : {}),
      ...(this.sdkLogLevel ? { logLevel: this.sdkLogLevel } : {}),
      ...(this.cliPath ? { cliPath: this.cliPath } : {})
    });

    const runLog = new HarnessRunLog({
      logDir: resolveLogDir(this.runLogDir, spec),
      prompt: spec.prompt,
      model: spec.model,
      logging: spec.logging,
      metadata: spec.metadata
    });

    const permissionHandler: PermissionHandler = (request) => {
      if (request.kind === "read" || request.kind === "custom-tool") {
        return { kind: "approve-once" };
      }

      return { kind: "user-not-available" };
    };

    const memoryBackend =
      spec.tenant?.memoryEnabled && spec.tools.includes("add_memory_entry")
        ? this.projectMemoryBackendFactory.createForHarnessRun({
            tenant: spec.tenant,
            logger: this.logger,
            logging: spec.logging
          })
        : null;
    const memoryService =
      memoryBackend && spec.tenant
        ? new ProjectMemoryService({
            logger: this.logger.child({
              interactionRunId: spec.logging?.interactionRunId ?? null,
              interactionJobId: spec.logging?.interactionJobId ?? null,
              tenantId: spec.logging?.tenantId ?? spec.tenant.id,
              component: "project-memory-service"
            }),
            backend: memoryBackend,
            consolidator: this.memoryConsolidator,
            modelConfig: spec.modelConfig,
            tenant: spec.tenant,
            logging: spec.logging,
            maxPromptMemoryChars: this.maxPromptMemoryChars
          })
        : null;

    let caughtError: unknown = null;
    const events: SessionEvent[] = [];

    try {
      const { registeredTools, availableTools, enabledToolIds } = resolveHarnessTools(spec.tools, {
        memoryService
      });

      const session = await client.createSession({
        onPermissionRequest: permissionHandler,
        ...(spec.workingDirectory ? { workingDirectory: spec.workingDirectory } : {}),
        ...(spec.model ? { model: spec.model } : {}),
        ...(spec.modelConfig.provider ? { provider: spec.modelConfig.provider } : {}),
        ...(spec.modelConfig.provider ? { enableConfigDiscovery: false } : {}),
        tools: registeredTools,
        availableTools,
        customAgents: resolveHarnessSubagents(spec.subagents, enabledToolIds),
        ...(spec.agent ? { agent: spec.agent } : {})
      });
      runLog.setSessionId(session.sessionId);

      const unsubscribe = session.on((event: SessionEvent) => {
        events.push(event);
        runLog.appendEvent(event);
      });

      try {
        const response: AssistantMessageEvent | undefined = await session.sendAndWait(
          {
            prompt: spec.prompt
          },
          spec.timeoutMs ?? this.timeoutMs
        );
        runLog.setResponse(response);
        return {
          response,
          events
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
        this.logger.error({ err: caughtError, copilotLogPath: logPath }, "harness session failed");
      }
      await client.stop();
    }
  }

  public get consolidator(): ProjectMemoryConsolidator {
    return this.memoryConsolidator;
  }
}

function resolveLogDir(baseLogDir: string, spec: HarnessRunSpec): string {
  const pathSegments =
    spec.logging?.pathSegments && spec.logging.pathSegments.length > 0
      ? spec.logging.pathSegments
      : ["copilot", createId("session")];
  return join(spec.logging?.runDirectory ?? baseLogDir, ...pathSegments);
}

async function flushRunLog(runLog: HarnessRunLog, logger: Logger): Promise<string | null> {
  try {
    return await runLog.flush();
  } catch (error) {
    logger.warn({ err: error, copilotLogPath: runLog.path }, "failed to write Copilot run log");
    return null;
  }
}
