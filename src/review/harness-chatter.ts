import { buildChatterPrompt } from "../prompts/prompt-builders.js";
import type { ProjectMemoryContext } from "../memory/types.js";
import type { HarnessSessionRuntime } from "../harness/session.js";
import type {
  HarnessModelConfig,
  HarnessRunAttachments,
  HarnessTenantContext,
} from "../harness/types.js";
import type {
  ChatterBatchResult,
  CommentReviewTriggerContext,
  ReplyStyle,
  ResponseTarget,
  ReviewContext,
  ReviewResult,
  ReviewerReplyHandoff,
} from "./types.js";
import { chatterBatchResultSchema } from "./types.js";

export interface ChatterRunContext {
  attachments?: HarnessRunAttachments | undefined;
  trigger: CommentReviewTriggerContext;
  responseTargets: ResponseTarget[];
  projectMemory: ProjectMemoryContext;
  replyStyle: ReplyStyle;
  phase: "memory" | "reply";
  reviewContext?: ReviewContext | null | undefined;
  reviewerReplyHandoff?: ReviewerReplyHandoff | null | undefined;
  reviewResult?: ReviewResult | null | undefined;
  logging?:
    | {
        interactionRunId: string;
        interactionJobId: string;
        tenantId: string;
        runDirectory?: string | undefined;
      }
    | undefined;
}

export interface ChatterRuntimeContext {
  tenant: HarnessTenantContext;
}

interface HarnessChatterRunnerOptions {
  modelConfig: HarnessModelConfig;
  harnessRuntime: HarnessSessionRuntime;
}

export class HarnessChatterRunner {
  private readonly modelConfig: HarnessModelConfig;
  private readonly harnessRuntime: HarnessSessionRuntime;

  public constructor(options: HarnessChatterRunnerOptions) {
    this.modelConfig = options.modelConfig;
    this.harnessRuntime = options.harnessRuntime;
  }

  public async run(
    context: ChatterRunContext,
    runtime: ChatterRuntimeContext,
  ): Promise<ChatterBatchResult> {
    const prompt = buildChatterPrompt(context);
    const tools =
      context.phase === "memory" && runtime.tenant.memoryEnabled
        ? (["glob", "rg", "view", "add_memory_entry"] as const)
        : (["glob", "rg", "view"] as const);
    const response = await this.harnessRuntime.run({
      prompt,
      ...(context.attachments ? { attachments: context.attachments } : {}),
      modelConfig: this.modelConfig,
      model:
        this.modelConfig.textGenerationModel ??
        this.modelConfig.reviewModel ??
        undefined,
      ...(this.modelConfig.textGenerationReasoningEffort
        ? { reasoningEffort: this.modelConfig.textGenerationReasoningEffort }
        : {}),
      workingDirectory: context.reviewContext?.workspacePath,
      tenant: runtime.tenant,
      tools: [...tools],
      subagents: [],
      logging: {
        interactionRunId: context.logging?.interactionRunId ?? null,
        interactionJobId: context.logging?.interactionJobId ?? null,
        tenantId: context.logging?.tenantId ?? runtime.tenant.id,
        runDirectory: context.logging?.runDirectory,
        pathSegments: ["copilot", "chatter", context.phase],
        sessionKind: context.phase === "memory" ? "memory" : "reply",
      },
      metadata: {
        codeReviewId: context.reviewContext?.codeReview.id ?? null,
        workspacePath: context.reviewContext?.workspacePath ?? null,
      },
      responseFormat: {
        schema: chatterBatchResultSchema,
        looksLike: isChatterBatchResultLike,
      },
    });
    if (!response.response?.data.content) {
      throw new Error("Copilot chatter session returned no content");
    }
    if (!response.parsed) {
      throw new Error(
        response.parseError?.message ??
          "Copilot chatter session returned invalid structured output",
      );
    }

    return chatterBatchResultSchema.parse(response.parsed);
  }

  public get sessionPaths(): { memory: string[]; reply: string[] } {
    return {
      memory: ["copilot", "chatter", "memory"],
      reply: ["copilot", "chatter", "reply"],
    };
  }
}

interface HarnessChatterRunnerFactoryOptions {
  harnessRuntime: HarnessSessionRuntime;
}

export class HarnessChatterRunnerFactory {
  private readonly harnessRuntime: HarnessSessionRuntime;

  public constructor(options: HarnessChatterRunnerFactoryOptions) {
    this.harnessRuntime = options.harnessRuntime;
  }

  public createRunner(modelConfig: HarnessModelConfig): HarnessChatterRunner {
    return new HarnessChatterRunner({
      modelConfig,
      harnessRuntime: this.harnessRuntime,
    });
  }
}

function isChatterBatchResultLike(value: Record<string, unknown>): boolean {
  return "memory" in value || "replies" in value;
}
