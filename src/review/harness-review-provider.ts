import type { Logger } from "pino";

import { HarnessSessionRuntime } from "../harness/session.js";
import type { HarnessModelConfig } from "../harness/types.js";
import { ProjectMemoryConsolidator } from "../memory/consolidator.js";
import { getProjectMemoryContentLength } from "../memory/project-memory.js";
import { buildReviewPrompt } from "../prompts/prompt-builders.js";
import type { ReviewProvider, ReviewProviderConfig, ReviewProviderFactory, ReviewProviderRuntimeContext } from "./provider.js";
import type { ReviewContext, ReviewResult } from "./types.js";
import { reviewResultSchema } from "./types.js";

interface HarnessReviewProviderOptions {
  logger: Logger;
  modelConfig: HarnessModelConfig;
  harnessRuntime: HarnessSessionRuntime;
  memoryConsolidator: ProjectMemoryConsolidator;
  maxPromptMemoryChars: number;
}

export class HarnessReviewProvider implements ReviewProvider {
  public readonly name = "copilot-sdk";

  private readonly logger: Logger;
  private readonly modelConfig: HarnessModelConfig;
  private readonly harnessRuntime: HarnessSessionRuntime;
  private readonly memoryConsolidator: ProjectMemoryConsolidator;
  private readonly maxPromptMemoryChars: number;

  public constructor(options: HarnessReviewProviderOptions) {
    this.logger = options.logger;
    this.modelConfig = options.modelConfig;
    this.harnessRuntime = options.harnessRuntime;
    this.memoryConsolidator = options.memoryConsolidator;
    this.maxPromptMemoryChars = options.maxPromptMemoryChars;
  }

  public async review(context: ReviewContext, runtime: ReviewProviderRuntimeContext): Promise<ReviewResult> {
    const effectiveContext = await this.preparePromptContext(context, runtime);
    const prompt = buildReviewPrompt(effectiveContext, {
      maxPromptMemoryChars: this.maxPromptMemoryChars
    });
    const response = await this.harnessRuntime.run({
      prompt,
      modelConfig: this.modelConfig,
      model: this.modelConfig.reviewModel ?? undefined,
      workingDirectory: effectiveContext.workspacePath,
      tenant: runtime.tenant,
      tools: ["glob", "rg", "view"],
      subagents: ["context-analyst", "review-author"],
      agent: "review-author",
      logging: {
        interactionRunId: effectiveContext.logging?.interactionRunId ?? null,
        interactionJobId: effectiveContext.logging?.interactionJobId ?? null,
        tenantId: effectiveContext.logging?.tenantId ?? runtime.tenant.id,
        runDirectory: effectiveContext.logging?.runDirectory,
        pathSegments: ["copilot", "reviewer"],
        sessionKind: "review"
      },
      metadata: {
        mergeRequestIid: effectiveContext.mergeRequest.iid,
        workspacePath: effectiveContext.workspacePath
      }
    });
    const content = response.response?.data.content;
    if (!content) {
      throw new Error("Copilot review session returned no content");
    }

    return reviewResultSchema.parse(this.normalizeOptionalReplyHandoff(parseJsonResponse(content), effectiveContext));
  }

  private async preparePromptContext(
    context: ReviewContext,
    runtime: ReviewProviderRuntimeContext
  ): Promise<ReviewContext> {
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
      context,
      runtime
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
    context: ReviewContext,
    runtime: ReviewProviderRuntimeContext
  ): Promise<ReviewContext["projectMemory"]["entries"]> {
    try {
      return await this.memoryConsolidator.coalesce({
        modelConfig: this.modelConfig,
        tenant: runtime.tenant,
        logging: {
          interactionRunId: context.logging?.interactionRunId ?? null,
          interactionJobId: context.logging?.interactionJobId ?? null,
          tenantId: context.logging?.tenantId ?? runtime.tenant.id,
          runDirectory: context.logging?.runDirectory,
          pathSegments: ["copilot"],
          sessionKind: "review"
        },
        coalesceInput: input
      });
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          interactionRunId: context.logging?.interactionRunId ?? null,
          tenantId: context.logging?.tenantId ?? null,
          reason: input.reason
        },
        "project memory coalescing failed; keeping existing memory entries"
      );
      return input.entries;
    }
  }

  private normalizeOptionalReplyHandoff(payload: unknown, context: ReviewContext): unknown {
    if (!isRecord(payload) || !isRecord(payload.replyHandoff)) {
      return payload;
    }

    const replyHandoff = { ...payload.replyHandoff };
    const summary = typeof replyHandoff.summary === "string" ? replyHandoff.summary.trim() : replyHandoff.summary;
    if (typeof summary === "string" && summary.length > 0) {
      replyHandoff.summary = summary;
      return {
        ...payload,
        replyHandoff
      };
    }

    const synthesizedSummary = this.synthesizeReplyHandoffSummary(payload, replyHandoff.targets);

    this.logger.warn(
      {
        interactionRunId: context.logging?.interactionRunId ?? null,
        tenantId: context.logging?.tenantId ?? null
      },
      "reviewer emitted an empty reply handoff summary; synthesizing fallback summary"
    );
    return {
      ...payload,
      replyHandoff: {
        ...replyHandoff,
        summary: synthesizedSummary
      }
    };
  }

  private synthesizeReplyHandoffSummary(payload: Record<string, unknown>, targets: unknown): string {
    if (!Array.isArray(targets)) {
      return this.synthesizeReplyHandoffSummaryFromOverview(payload);
    }

    for (const target of targets) {
      if (!isRecord(target) || typeof target.guidance !== "string") {
        continue;
      }

      const guidance = target.guidance.trim();
      if (guidance.length === 0) {
        continue;
      }

      return guidance.length <= 240 ? guidance : `${guidance.slice(0, 237)}...`;
    }

    return this.synthesizeReplyHandoffSummaryFromOverview(payload);
  }

  private synthesizeReplyHandoffSummaryFromOverview(payload: Record<string, unknown>): string {
    if (isRecord(payload.overview)) {
      const overallAssessment = normalizeNonEmptyString(payload.overview.overallAssessment);
      if (overallAssessment) {
        return overallAssessment;
      }

      if (isRecord(payload.overview.mergeReadiness)) {
        const mergeReadinessSummary = normalizeNonEmptyString(payload.overview.mergeReadiness.summary);
        if (mergeReadinessSummary) {
          return mergeReadinessSummary;
        }
      }

      const overviewSummary = normalizeNonEmptyString(payload.overview.summary);
      if (overviewSummary) {
        return overviewSummary;
      }
    }

    return "Review follow-up available.";
  }
}

interface HarnessReviewProviderFactoryOptions {
  logger: Logger;
  harnessRuntime: HarnessSessionRuntime;
  maxPromptMemoryChars: number;
}

export class HarnessReviewProviderFactory implements ReviewProviderFactory {
  private readonly logger: Logger;
  private readonly harnessRuntime: HarnessSessionRuntime;
  private readonly maxPromptMemoryChars: number;

  public constructor(options: HarnessReviewProviderFactoryOptions) {
    this.logger = options.logger;
    this.harnessRuntime = options.harnessRuntime;
    this.maxPromptMemoryChars = options.maxPromptMemoryChars;
  }

  public createProvider(config: ReviewProviderConfig): ReviewProvider {
    return new HarnessReviewProvider({
      logger: this.logger.child({
        modelProfileName: config.modelProfileName,
        selectionSource: config.selectionSource,
        reviewModel: config.reviewModel,
        textGenerationModel: config.textGenerationModel,
        hasAuthToken: Boolean(config.authToken),
        providerBaseUrl: config.providerBaseUrl,
        providerType: config.providerType
      }),
      modelConfig: config,
      harnessRuntime: this.harnessRuntime,
      memoryConsolidator: this.harnessRuntime.consolidator,
      maxPromptMemoryChars: this.maxPromptMemoryChars
    });
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

  throw new Error("Harness review output did not contain a JSON object");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}
