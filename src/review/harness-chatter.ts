import { buildChatterPrompt } from "../prompts/prompt-builders.js";
import type { ProjectMemoryContext } from "../memory/types.js";
import { HarnessSessionRuntime } from "../harness/session.js";
import type { HarnessModelConfig } from "../harness/types.js";
import type {
  ChatterBatchResult,
  ReplyStyle,
  ResponseTarget,
  ReviewContext,
  ReviewResult,
  ReviewTriggerContext,
  ReviewerReplyHandoff
} from "./types.js";
import { chatterBatchResultSchema } from "./types.js";

export interface ChatterRunContext {
  trigger: ReviewTriggerContext;
  responseTargets: ResponseTarget[];
  projectMemory: ProjectMemoryContext;
  replyStyle: ReplyStyle;
  phase: "memory" | "reply";
  reviewContext?: ReviewContext | null | undefined;
  reviewerReplyHandoff?: ReviewerReplyHandoff | null | undefined;
  reviewResult?: ReviewResult | null | undefined;
  logging?: {
    interactionRunId: string;
    interactionJobId: string;
    tenantId: string;
    runDirectory?: string | undefined;
  } | undefined;
}

export interface ChatterRuntimeContext {
  tenant: {
    id: string;
    baseUrl: string;
    projectId: number;
    apiToken: string;
    memoryEnabled: boolean;
  };
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

  public async run(context: ChatterRunContext, runtime: ChatterRuntimeContext): Promise<ChatterBatchResult> {
    const prompt = buildChatterPrompt(context);
    const tools =
      context.phase === "memory" && runtime.tenant.memoryEnabled
        ? (["glob", "rg", "view", "add_memory_entry"] as const)
        : (["glob", "rg", "view"] as const);
    const response = await this.harnessRuntime.run({
      prompt,
      modelConfig: this.modelConfig,
      model: this.modelConfig.textGenerationModel ?? this.modelConfig.reviewModel ?? undefined,
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
        sessionKind: context.phase === "memory" ? "memory" : "reply"
      },
      metadata: {
        mergeRequestIid: context.reviewContext?.mergeRequest.iid ?? null,
        workspacePath: context.reviewContext?.workspacePath ?? null
      }
    });
    const content = response.response?.data.content;
    if (!content) {
      throw new Error("Copilot chatter session returned no content");
    }

    return chatterBatchResultSchema.parse(parseJsonResponse(content));
  }

  public get sessionPaths(): { memory: string[]; reply: string[] } {
    return {
      memory: ["copilot", "chatter", "memory"],
      reply: ["copilot", "chatter", "reply"]
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
      harnessRuntime: this.harnessRuntime
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

  throw new Error("Harness chatter output did not contain a JSON object");
}
