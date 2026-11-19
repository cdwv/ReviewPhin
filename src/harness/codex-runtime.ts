import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Logger } from "pino";
import type { ProjectMemoryService } from "../memory/service.js";
import { renderPrompt } from "../prompts/instruction-renderer.js";
import { CodexProtocol } from "./codex-protocol.js";
import { prepareCodexAttachments } from "./codex-attachments.js";
import { loadCodexCustomizations } from "./codex-customizations.js";
import { createCodexTools } from "./codex-tools.js";
import { loadRepositoryCustomizations } from "./repository-customizations.js";
import { parseHarnessStructuredResponse } from "./response-format.js";
import { HarnessRunLog } from "./run-log.js";
import type { HarnessRunResult, HarnessRunSpec } from "./types.js";

export class CodexRuntime {
  public constructor(
    private readonly options: {
      command: string;
      args: string[];
      timeoutMs: number;
      memoryService?: (
        spec: HarnessRunSpec,
      ) => Pick<ProjectMemoryService, "addEntry"> | null;
      logger?: Logger;
      runLogDir?: string;
    },
  ) {}

  public async run<T>(spec: HarnessRunSpec<T>): Promise<HarnessRunResult<T>> {
    if (spec.modelConfig.provider)
      throw new Error(
        "Codex harness does not support Copilot provider profiles; use a native Codex model profile",
      );
    const timeoutMs = spec.timeoutMs ?? this.options.timeoutMs;
    const { tools, call } = createCodexTools(
      spec,
      this.options.memoryService?.(spec) ?? null,
    );
    const server = new CodexProtocol({
      ...this.options,
      timeoutMs,
      onToolCall: call,
    });
    const log = this.options.runLogDir
      ? new HarnessRunLog({
          logDir: join(
            spec.logging?.runDirectory ?? this.options.runLogDir,
            ...(spec.logging?.pathSegments?.map((segment, index) =>
              index === 0 && segment === "copilot" ? "codex" : segment,
            ) ?? ["codex", randomUUID()]),
          ),
          prompt: spec.prompt,
          model: spec.model,
          reasoningEffort: spec.reasoningEffort,
          logging: spec.logging,
          metadata: spec.metadata,
        })
      : null;
    try {
      const custom = await loadRepositoryCustomizations(spec.workingDirectory);
      if (custom) log?.setRepositoryCustomizations(custom);
      const roleGuidance = spec.subagents.length
        ? [
            "Perform context analysis first, then produce the review yourself using the following role instructions.",
            ...spec.subagents.map((id) =>
              renderPrompt(
                id === "context-analyst"
                  ? "subagent.context-analyst"
                  : "subagent.review-author",
                {},
              ),
            ),
          ].join("\n\n")
        : "";
      const repositoryGuidance = spec.workingDirectory
        ? await loadCodexCustomizations(spec.workingDirectory)
        : "";
      const instructions = [
        roleGuidance,
        custom?.instructions,
        repositoryGuidance,
      ]
        .filter(Boolean)
        .join("\n\n");
      await server.initialize();
      const thread = await server.startThread({
        sandbox: "read-only",
        environments: [],
        dynamicTools: tools,
        config: { "features.shell_tool": false },
        approvalPolicy: "never",
        ephemeral: true,
        ...(spec.workingDirectory ? { cwd: spec.workingDirectory } : {}),
        ...(spec.model ? { model: spec.model } : {}),
        ...(instructions ? { developerInstructions: instructions } : {}),
      });
      log?.setSessionId(thread);
      const deadline = spec.overallTimeoutMs
        ? Date.now() + spec.overallTimeoutMs
        : null;
      let prompt = spec.prompt;
      const attachments = await prepareCodexAttachments(
        spec.attachments,
        spec.workingDirectory,
      );
      if (attachments.text) prompt += `\n\n${attachments.text}`;
      const images = attachments.images;
      for (
        let attempt = 0;
        attempt < (spec.responseFormat ? 3 : 1);
        attempt++
      ) {
        const remaining =
          deadline === null
            ? timeoutMs
            : Math.min(timeoutMs, deadline - Date.now());
        if (remaining <= 0) throw new Error("Codex session deadline exceeded");
        const started = Date.now();
        const content = await server.turn(thread, prompt, {
          timeoutMs: remaining,
          ...(attempt === 0 && images.length ? { images } : {}),
          ...(spec.reasoningEffort ? { effort: spec.reasoningEffort } : {}),
        });
        const response = {
          type: "assistant.message" as const,
          id: randomUUID(),
          parentId: null,
          timestamp: new Date().toISOString(),
          data: { content, messageId: randomUUID() },
        };
        const parsed = parseHarnessStructuredResponse(
          content,
          spec.responseFormat,
        );
        log?.setResponse(response);
        log?.appendStructuredOutputAttempt({
          attempt: attempt + 1,
          correctionAttempt: attempt,
          durationMs: Date.now() - started,
          response,
          parseError: parsed.parseError,
          events: [],
        });
        if (!spec.responseFormat || parsed.parsed !== undefined)
          return { response, events: [], ...parsed };
        if (attempt === 2)
          throw new Error(
            `Codex structured output invalid: ${parsed.parseError?.message ?? "unknown error"}`,
          );
        prompt = `Your previous response was invalid: ${parsed.parseError?.message ?? "invalid JSON"}. Return only a corrected JSON object matching the original request.`;
      }
      throw new Error("Codex session ended without a response");
    } catch (error) {
      log?.setError(error);
      throw error;
    } finally {
      await server.close();
      if (log)
        try {
          await log.flush();
        } catch (error) {
          this.options.logger?.warn(
            { err: error },
            "failed to write Codex run log",
          );
        }
    }
  }
}
