import { CopilotClient, type AssistantMessageEvent, type PermissionHandler, type ProviderConfig } from "@github/copilot-sdk";
import type { Logger } from "pino";

import type { ProjectMemoryCoalesceInput, ProjectMemoryEntry } from "./types.js";
import { buildProjectMemoryCoalescePrompt } from "../prompts/prompt-builders.js";

interface ProjectMemoryCoalescerOptions {
  logger: Logger;
  model?: string | undefined;
  authToken?: string | undefined;
  provider?: ProviderConfig | undefined;
  sdkLogLevel?: "none" | "error" | "warning" | "info" | "debug" | "all" | undefined;
  cliPath?: string | undefined;
  timeoutMs: number;
}

export class ProjectMemoryTextCoalescer {
  private readonly logger: Logger;
  private readonly model: string | undefined;
  private readonly authToken: string | undefined;
  private readonly provider: ProviderConfig | undefined;
  private readonly sdkLogLevel: ProjectMemoryCoalescerOptions["sdkLogLevel"];
  private readonly cliPath: string | undefined;
  private readonly timeoutMs: number;

  public constructor(options: ProjectMemoryCoalescerOptions) {
    this.logger = options.logger;
    this.model = options.model;
    this.authToken = options.authToken;
    this.provider = options.provider;
    this.sdkLogLevel = options.sdkLogLevel;
    this.cliPath = options.cliPath;
    this.timeoutMs = options.timeoutMs;
  }

  public async coalesce(input: ProjectMemoryCoalesceInput): Promise<ProjectMemoryEntry[]> {
    if (input.entries.length === 0) {
      return [];
    }

    const client = new CopilotClient({
      ...(this.authToken ? { gitHubToken: this.authToken } : {}),
      ...(this.sdkLogLevel ? { logLevel: this.sdkLogLevel } : {}),
      ...(this.cliPath ? { cliPath: this.cliPath } : {})
    });
    const permissionHandler: PermissionHandler = () => ({ kind: "user-not-available" });

    try {
      const session = await client.createSession({
        onPermissionRequest: permissionHandler,
        ...(this.model ? { model: this.model } : {}),
        ...(this.provider ? { provider: this.provider } : {}),
        availableTools: [],
        ...(this.provider ? { enableConfigDiscovery: false } : {})
      });

      try {
        const response = await session.sendAndWait(
          {
            prompt: buildProjectMemoryCoalescePrompt(input)
          },
          this.timeoutMs
        );
        return parseCoalescedEntries(response);
      } finally {
        await session.disconnect();
      }
    } catch (error) {
      this.logger.warn({ err: error, reason: input.reason }, "project memory coalescing failed");
      throw error;
    } finally {
      await client.stop();
    }
  }
}

function parseCoalescedEntries(response: AssistantMessageEvent | undefined): ProjectMemoryEntry[] {
  const content = response?.data.content?.trim();
  if (!content) {
    throw new Error("Project memory coalescer returned no content");
  }

  const parsed = parseJsonResponse(content) as { entries?: unknown };
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
    throw new Error("Project memory coalescer did not return an entries array");
  }

  const entries = parsed.entries
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((text) => ({ text }));

  if (entries.length === 0) {
    throw new Error("Project memory coalescer returned no usable entries");
  }

  return entries;
}

function parseJsonResponse(content: string): unknown {
  if (content.startsWith("{")) {
    return JSON.parse(content);
  }

  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return JSON.parse(fenced[1].trim());
  }

  throw new Error("Project memory coalescer output did not contain JSON");
}
