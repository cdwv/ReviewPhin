import type {
  HarnessModelConfig,
  HarnessRunLoggingContext,
  HarnessRunResult,
  HarnessRunSpec,
  HarnessTenantContext,
} from "../harness/types.js";
import { buildProjectMemoryCoalescePrompt } from "../prompts/prompt-builders.js";
import { createId } from "../utils/ids.js";
import type {
  ProjectMemoryCoalesceInput,
  ProjectMemoryEntry,
} from "./types.js";

interface ProjectMemoryConsolidatorOptions {
  runSession: (spec: HarnessRunSpec) => Promise<HarnessRunResult>;
}

export class ProjectMemoryConsolidator {
  private readonly runSession: ProjectMemoryConsolidatorOptions["runSession"];

  public constructor(options: ProjectMemoryConsolidatorOptions) {
    this.runSession = options.runSession;
  }

  public async coalesce(input: {
    modelConfig: HarnessModelConfig;
    tenant?: HarnessTenantContext | undefined;
    logging?: HarnessRunLoggingContext | undefined;
    coalesceInput: ProjectMemoryCoalesceInput;
  }): Promise<ProjectMemoryEntry[]> {
    if (input.coalesceInput.entries.length === 0) {
      return [];
    }

    const response = await this.runSession({
      prompt: buildProjectMemoryCoalescePrompt(input.coalesceInput),
      modelConfig: input.modelConfig,
      model: selectConsolidationModel(input.modelConfig),
      tenant: input.tenant,
      tools: [],
      subagents: [],
      logging: {
        interactionRunId: input.logging?.interactionRunId ?? null,
        interactionJobId: input.logging?.interactionJobId ?? null,
        tenantId: input.logging?.tenantId ?? input.tenant?.id ?? null,
        parentInteractionRunId:
          input.logging?.parentInteractionRunId ??
          input.logging?.interactionRunId ??
          null,
        runDirectory: input.logging?.runDirectory,
        pathSegments: [
          ...(input.logging?.pathSegments ?? ["copilot"]),
          "memory-consolidation",
          createId("session"),
        ],
        sessionKind: "memory-consolidation",
      },
    });

    return parseCoalescedEntries(response.response?.data.content);
  }
}

function selectConsolidationModel(
  input: HarnessModelConfig,
): string | undefined {
  return input.textGenerationModel ?? input.reviewModel ?? undefined;
}

function parseCoalescedEntries(
  content: string | undefined,
): ProjectMemoryEntry[] {
  const trimmed = content?.trim();
  if (!trimmed) {
    throw new Error("Project memory consolidator returned no content");
  }

  const parsed = parseJsonResponse(trimmed) as { entries?: unknown };
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
    throw new Error(
      "Project memory consolidator did not return an entries array",
    );
  }

  const entries = parsed.entries
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((text) => ({ text }));

  if (entries.length === 0) {
    throw new Error("Project memory consolidator returned no usable entries");
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

  throw new Error("Project memory consolidator output did not contain JSON");
}
